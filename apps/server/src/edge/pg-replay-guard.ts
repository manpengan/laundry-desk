import {
  CommandResponseSchema,
  classifyQueueEnvelopeCompatibility,
  createCommandError,
} from "@laundry/contracts";

import type { BusContext, CommandResult, CommandTransactionGuard } from "../bus/types.js";
import type { SqlClient } from "../db/types.js";
import { lockPgReplayState } from "./pg-replay-state.js";
import type { PreparedPgReplay } from "./pg-replay.js";
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

function requireGrantSequence(
  authorization: Readonly<{ kind: "grant"; grant_id: string; per_grant_seq?: number }>,
): number {
  const sequence = authorization.per_grant_seq;
  if (sequence === undefined || !Number.isSafeInteger(sequence) || sequence <= 0) {
    throw new Error("Persistently sequenced grant replay required");
  }
  return sequence;
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
  const authorization = prepared.request.payload.envelope.authorization;
  const result =
    authorization.kind === "grant"
      ? await client.query<AcceptedRecord>(
          `SELECT envelope_sha256, result_json
             FROM edge_replay_records
            WHERE org_id = $1::uuid AND store_id = $2::uuid
              AND authorization_kind = 'grant' AND grant_id = $3::uuid
              AND accepted_per_grant_seq = $4
            LIMIT 1`,
          [
            prepared.orgId,
            prepared.storeId,
            authorization.grant_id,
            requireGrantSequence(authorization),
          ],
        )
      : await client.query<AcceptedRecord>(
          `SELECT envelope_sha256, result_json
             FROM edge_replay_records
            WHERE org_id = $1::uuid AND store_id = $2::uuid
              AND authorization_kind = 'primary_lease' AND lease_id = $3::uuid
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
  privacySubjectCustomerId?: string;
}>;

function replaySequence(prepared: PreparedPgReplay): number {
  const authorization = prepared.request.payload.envelope.authorization;
  return authorization.kind === "grant"
    ? requireGrantSequence(authorization)
    : authorization.per_lease_seq;
}

async function insertRecord(
  client: SqlClient,
  prepared: PreparedPgReplay,
  newId: () => string,
  input: RecordInput,
): Promise<void> {
  const envelope = prepared.request.payload.envelope;
  const authorization = envelope.authorization;
  const grantSequence = authorization.kind === "grant" ? requireGrantSequence(authorization) : null;
  const leaseId = authorization.kind === "primary_lease" ? authorization.lease_id : null;
  const primaryEpoch = authorization.kind === "primary_lease" ? authorization.primary_epoch : null;
  const leaseSequence = authorization.kind === "primary_lease" ? authorization.per_lease_seq : null;
  await client.query(
    `INSERT INTO edge_replay_records (
       id, org_id, store_id, reported_queue_id, accepted_queue_id,
       authorization_kind, grant_id, lease_id, original_staff_id,
       replayed_by_staff_id, device_id, primary_epoch,
       reported_per_lease_seq, accepted_per_lease_seq,
       reported_per_grant_seq, accepted_per_grant_seq,
       envelope_sha256, command, idempotency_key, decision, reason,
       result_json, privacy_subject_customer_id, recorded_at
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
       $6, $7::uuid, $8::uuid, $9::uuid,
       $10::uuid, $11::uuid, $12,
       $13, $14, $15, $16,
       $17, $18, $19::uuid, $20, $21, $22::jsonb, $23::uuid,
       clock_timestamp()
     )`,
    [
      newId(),
      prepared.orgId,
      prepared.storeId,
      envelope.queue_id,
      input.accepted ? envelope.queue_id : null,
      authorization.kind,
      authorization.grant_id,
      leaseId,
      prepared.originalStaffId,
      prepared.replayedByStaffId,
      prepared.deviceId,
      primaryEpoch,
      leaseSequence,
      input.accepted ? leaseSequence : null,
      grantSequence,
      input.accepted ? grantSequence : null,
      prepared.envelopeSha256,
      envelope.payload.command,
      envelope.payload.idempotency_key,
      input.decision,
      input.reason,
      JSON.stringify(input.result),
      input.privacySubjectCustomerId ?? null,
    ],
  );
}

async function advanceSequence(client: SqlClient, prepared: PreparedPgReplay): Promise<void> {
  const authorization = prepared.request.payload.envelope.authorization;
  const result =
    authorization.kind === "grant"
      ? await client.query(
          `UPDATE offline_grant_replay_state
              SET last_seq = $4, updated_at = clock_timestamp()
            WHERE org_id = $1::uuid AND store_id = $2::uuid AND grant_id = $3::uuid`,
          [
            prepared.orgId,
            prepared.storeId,
            authorization.grant_id,
            requireGrantSequence(authorization),
          ],
        )
      : await client.query(
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

function authorityReason(prepared: PreparedPgReplay, currentPrimary: boolean): string {
  if (!prepared.grantWindowValid) return "grant_window_invalid";
  if (prepared.authorizationKind === "primary_lease" && !currentPrimary) return "old_epoch";
  return "authority_changed";
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
      const authorization = prepared.request.payload.envelope.authorization;
      const locked = await lockPgReplayState(client, prepared);
      const queueRecord = await acceptedByQueue(client, prepared);
      if (queueRecord !== null) {
        const duplicate = queueRecord.envelope_sha256 === prepared.envelopeSha256;
        const result = duplicate
          ? parseStoredResult(queueRecord.result_json)
          : arbitrationFailure();
        await insertRecord(client, prepared, newId, {
          decision: duplicate ? "duplicate" : "collision",
          reason: duplicate ? "queue_duplicate" : "queue_hash_collision",
          accepted: false,
          result,
        });
        if (duplicate) latestDisposition = "duplicate";
        return Object.freeze({ kind: "return" as const, result });
      }
      if ((await acceptedBySequence(client, prepared)) !== null) {
        const result = arbitrationFailure();
        await insertRecord(client, prepared, newId, {
          decision: "collision",
          reason:
            authorization.kind === "grant"
              ? "grant_sequence_collision"
              : "lease_sequence_collision",
          accepted: false,
          result,
        });
        return Object.freeze({ kind: "return" as const, result });
      }
      const sequence = replaySequence(prepared);
      if (sequence !== locked.expectedSeq) {
        const result = arbitrationFailure();
        await insertRecord(client, prepared, newId, {
          decision: "rejected",
          reason: sequence < locked.expectedSeq ? "sequence_stale" : "sequence_gap",
          accepted: false,
          result,
        });
        return Object.freeze({ kind: "return" as const, result });
      }
      const currentPrimary =
        authorization.kind === "grant" ||
        (locked.currentEpoch === authorization.primary_epoch &&
          locked.currentLeaseId === authorization.lease_id);
      if (!currentPrimary || !locked.authorityCurrent) {
        const result = arbitrationFailure();
        await insertRecord(client, prepared, newId, {
          decision: "arbitration",
          reason: authorityReason(prepared, currentPrimary),
          accepted: true,
          result,
        });
        await advanceSequence(client, prepared);
        return Object.freeze({ kind: "return" as const, result });
      }
      return Object.freeze({ kind: "continue" as const, state: continueState });
    },
    settle: async (client, _context, state, result, privacySubjectCustomerId) => {
      if (state !== continueState) throw new Error("Replay guard state mismatch");
      await insertRecord(client, prepared, newId, {
        decision: result.ok ? "applied" : "arbitration",
        reason: result.ok ? "applied" : result.error.code,
        accepted: true,
        result,
        ...(privacySubjectCustomerId === undefined ? {} : { privacySubjectCustomerId }),
      });
      await advanceSequence(client, prepared);
    },
  });
  return Object.freeze({ guard, disposition: () => latestDisposition });
}
