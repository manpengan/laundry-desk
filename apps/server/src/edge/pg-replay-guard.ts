import {
  CommandResponseSchema,
  classifyQueueEnvelopeCompatibility,
  createCommandError,
} from "@laundry/contracts";

import type { BusContext, CommandResult, CommandTransactionGuard } from "../bus/types.js";
import type { SqlClient } from "../db/types.js";
import { lockPgReplayState, type PreparedPgReplay } from "./pg-replay.js";
import { SERVER_EDGE_REPLAY_COMPATIBILITY_POLICY } from "./replay-compatibility.js";

type ReplayDecision = "applied" | "duplicate";
type AcceptedRecord = Readonly<{
  envelope_sha256: string;
  result_json: unknown;
}>;

function arbitrationFailure(): CommandResult {
  return Object.freeze({
    ok: false as const,
    error: createCommandError("REPLAY_ARBITRATION_REQUIRED"),
  });
}

function requirePrimary(prepared: PreparedPgReplay) {
  const authorization = prepared.request.payload.envelope.authorization;
  if (authorization.kind !== "primary_lease") {
    throw new Error("Replay transaction requires a Primary lease");
  }
  return authorization;
}

function assertBusBinding(context: BusContext, prepared: PreparedPgReplay): void {
  const envelope = prepared.request.payload.envelope;
  if (
    context.tenant.orgId !== prepared.orgId ||
    context.tenant.storeId !== prepared.storeId ||
    context.tenant.staffId !== prepared.originalStaffId ||
    context.actor.staffId !== prepared.originalStaffId ||
    context.actor.deviceId !== prepared.deviceId ||
    context.actor.via !== "edge_replay" ||
    context.request.name !== envelope.payload.command ||
    context.request.idempotencyKey !== envelope.payload.idempotency_key
  ) {
    throw new Error("Replay transaction context does not match verified authority");
  }
}

async function acceptedByQueue(
  client: SqlClient,
  prepared: PreparedPgReplay,
): Promise<AcceptedRecord | null> {
  const result = await client.query<AcceptedRecord>(
    `SELECT envelope_sha256, result_json
       FROM edge_replay_records
      WHERE org_id = $1::uuid AND store_id = $2::uuid
        AND accepted_queue_id = $3::uuid
      LIMIT 1`,
    [prepared.orgId, prepared.storeId, prepared.request.payload.envelope.queue_id],
  );
  return result.rows[0] ?? null;
}

async function acceptedBySequence(
  client: SqlClient,
  prepared: PreparedPgReplay,
): Promise<AcceptedRecord | null> {
  const authorization = requirePrimary(prepared);
  const result = await client.query<AcceptedRecord>(
    `SELECT envelope_sha256, result_json
       FROM edge_replay_records
      WHERE org_id = $1::uuid AND store_id = $2::uuid AND lease_id = $3::uuid
        AND accepted_per_lease_seq = $4
      LIMIT 1`,
    [prepared.orgId, prepared.storeId, authorization.lease_id, authorization.per_lease_seq],
  );
  return result.rows[0] ?? null;
}

type RecordInput = Readonly<{
  decision: "applied" | "duplicate" | "arbitration" | "collision" | "rejected";
  reason: string;
  accepted: boolean;
  result: CommandResult;
}>;

async function insertRecord(
  client: SqlClient,
  prepared: PreparedPgReplay,
  newId: () => string,
  input: RecordInput,
): Promise<void> {
  const envelope = prepared.request.payload.envelope;
  const authorization = requirePrimary(prepared);
  await client.query(
    `INSERT INTO edge_replay_records (
       id, org_id, store_id, reported_queue_id, accepted_queue_id,
       grant_id, lease_id, original_staff_id, replayed_by_staff_id, device_id,
       primary_epoch, reported_per_lease_seq, accepted_per_lease_seq,
       envelope_sha256, command, idempotency_key, decision, reason,
       result_json, recorded_at
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
       $6::uuid, $7::uuid, $8::uuid, $9::uuid, $10::uuid,
       $11, $12, $13, $14, $15, $16::uuid, $17, $18, $19::jsonb,
       clock_timestamp()
     )`,
    [
      newId(),
      prepared.orgId,
      prepared.storeId,
      envelope.queue_id,
      input.accepted ? envelope.queue_id : null,
      authorization.grant_id,
      authorization.lease_id,
      prepared.originalStaffId,
      prepared.replayedByStaffId,
      prepared.deviceId,
      authorization.primary_epoch,
      authorization.per_lease_seq,
      input.accepted ? authorization.per_lease_seq : null,
      prepared.envelopeSha256,
      envelope.payload.command,
      envelope.payload.idempotency_key,
      input.decision,
      input.reason,
      JSON.stringify(input.result),
    ],
  );
}

async function advanceSequence(client: SqlClient, prepared: PreparedPgReplay): Promise<void> {
  const authorization = requirePrimary(prepared);
  const result = await client.query(
    `UPDATE primary_lease_replay_state
        SET last_seq = $4, updated_at = clock_timestamp()
      WHERE org_id = $1::uuid AND store_id = $2::uuid AND lease_id = $3::uuid`,
    [prepared.orgId, prepared.storeId, authorization.lease_id, authorization.per_lease_seq],
  );
  if (result.rowCount !== 1) throw new Error("Replay sequence advance failed");
}

function parseStoredResult(value: unknown): CommandResult {
  return CommandResponseSchema.parse(value) as CommandResult;
}

export function createPgReplayGuard(
  prepared: PreparedPgReplay,
  newId: () => string,
): Readonly<{ guard: CommandTransactionGuard; disposition: () => ReplayDecision }> {
  if (
    classifyQueueEnvelopeCompatibility(
      prepared.request.payload.envelope,
      SERVER_EDGE_REPLAY_COMPATIBILITY_POLICY,
    ).mode !== "replay"
  ) {
    throw new Error("Replay compatibility must be accepted before guard construction");
  }
  const continueState = Object.freeze({ replay: prepared.envelopeSha256 });
  let latestDisposition: ReplayDecision = "applied";

  const guard: CommandTransactionGuard = Object.freeze({
    before: async (client, context) => {
      assertBusBinding(context, prepared);
      const authorization = requirePrimary(prepared);
      const locked = await lockPgReplayState(client, prepared);
      const queueRecord = await acceptedByQueue(client, prepared);
      if (queueRecord !== null) {
        const result =
          queueRecord.envelope_sha256 === prepared.envelopeSha256
            ? parseStoredResult(queueRecord.result_json)
            : arbitrationFailure();
        await insertRecord(client, prepared, newId, {
          decision:
            queueRecord.envelope_sha256 === prepared.envelopeSha256 ? "duplicate" : "collision",
          reason:
            queueRecord.envelope_sha256 === prepared.envelopeSha256
              ? "queue_duplicate"
              : "queue_hash_collision",
          accepted: false,
          result,
        });
        latestDisposition = "duplicate";
        return Object.freeze({ kind: "return" as const, result });
      }
      if ((await acceptedBySequence(client, prepared)) !== null) {
        const result = arbitrationFailure();
        await insertRecord(client, prepared, newId, {
          decision: "collision",
          reason: "lease_sequence_collision",
          accepted: false,
          result,
        });
        return Object.freeze({ kind: "return" as const, result });
      }
      if (authorization.per_lease_seq !== locked.expectedSeq) {
        const result = arbitrationFailure();
        await insertRecord(client, prepared, newId, {
          decision: "rejected",
          reason:
            authorization.per_lease_seq < locked.expectedSeq ? "sequence_stale" : "sequence_gap",
          accepted: false,
          result,
        });
        return Object.freeze({ kind: "return" as const, result });
      }
      const currentLease =
        locked.currentEpoch === authorization.primary_epoch &&
        locked.currentLeaseId === authorization.lease_id;
      if (!currentLease || !locked.authorityCurrent) {
        const result = arbitrationFailure();
        await insertRecord(client, prepared, newId, {
          decision: "arbitration",
          reason: currentLease ? "authority_changed" : "old_epoch",
          accepted: true,
          result,
        });
        await advanceSequence(client, prepared);
        return Object.freeze({ kind: "return" as const, result });
      }
      return Object.freeze({ kind: "continue" as const, state: continueState });
    },
    settle: async (client, _context, state, result) => {
      if (state !== continueState) throw new Error("Replay guard state mismatch");
      await insertRecord(client, prepared, newId, {
        decision: result.ok ? "applied" : "arbitration",
        reason: result.ok ? "applied" : result.error.code,
        accepted: true,
        result,
      });
      await advanceSequence(client, prepared);
    },
  });
  return Object.freeze({ guard, disposition: () => latestDisposition });
}
