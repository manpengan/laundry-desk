import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import test from "node:test";

import {
  EdgeAuthorityRequestSchema,
  EdgeReplayRequestSchema,
  canonicalizeEdgeDeviceRegistrationForSigning,
  canonicalizeEdgeReplayForSigning,
  type EdgeAuthorityChallengeData,
  type EdgeAuthorityChallengeRequest,
  type EdgeReplayRequest,
} from "@laundry/contracts";

import type { AuthorizedSession } from "../auth/session-view.js";
import { executeCommand } from "../bus/executor.js";
import { createPgIdempotencyStore } from "../bus/pg-idempotency.js";
import { createM1CommandRegistry } from "../bus/registry.js";
import { permissionsForAuthority } from "../bus/runtime.js";
import type { ActorContext, CommandResult } from "../bus/types.js";
import { createPgPool, resolvePgUrls, type PgPool } from "../db/pg-pool.js";
import { withPoolClient } from "../db/pg-sql-client.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import type { TenantContext } from "../db/types.js";
import { DEMO_ORG_ID, DEMO_STAFF_A_ID, DEMO_STAFF_B_ID, DEMO_STORE_ID } from "../local/demo-ids.js";
import { seedPgTestIdentityFixture } from "../local/pg-test-fixture.js";
import { createEdgeAuthorityService } from "./authority-service.js";
import { createPgAuthorityStore } from "./pg-authority-store.js";
import { createPgReplayGuard } from "./pg-replay-guard.js";
import { preparePgReplay, type PreparedPgReplay } from "./pg-replay.js";

const urls =
  process.env.LAUNDRY_USE_LOCAL_PG === "1" || process.env.LAUNDRY_USE_LOCAL_PG === "true"
    ? resolvePgUrls(process.env)
    : null;

const DEVICE_ID = "91919191-9191-4919-8919-919191919191";
const ORDER_ID = "92929292-9292-4929-8929-929292929292";
const APPLIED_QUEUE_ID = "93939393-9393-4939-8939-939393939301";
const FAILED_QUEUE_ID = "93939393-9393-4939-8939-939393939302";
const GAP_QUEUE_ID = "93939393-9393-4939-8939-939393939303";
const OLD_EPOCH_QUEUE_ID = "93939393-9393-4939-8939-939393939304";
const APPLIED_KEY = "94949494-9494-4949-8949-949494949401";
const FAILED_KEY = "94949494-9494-4949-8949-949494949402";
const GAP_KEY = "94949494-9494-4949-8949-949494949403";
const OLD_EPOCH_KEY = "94949494-9494-4949-8949-949494949404";
const APPLIED_AUDIT_ID = "95959595-9595-4959-8959-959595959501";
const FAILED_AUDIT_ID = "95959595-9595-4959-8959-959595959502";
const APPLIED_RECORD_ID = "96969696-9696-4969-8969-969696969601";
const DUPLICATE_RECORD_ID = "96969696-9696-4969-8969-969696969602";
const GAP_RECORD_ID = "96969696-9696-4969-8969-969696969603";
const OLD_EPOCH_RECORD_ID = "96969696-9696-4969-8969-969696969604";

const ALL_KEYS = Object.freeze([APPLIED_KEY, FAILED_KEY, GAP_KEY, OLD_EPOCH_KEY]);
const ALL_AUDIT_IDS = Object.freeze([APPLIED_AUDIT_ID, FAILED_AUDIT_ID]);

function session(staffId: string, displayName: string): AuthorizedSession {
  return Object.freeze({
    session: Object.freeze({
      session_id: randomUUID(),
      session_version: 1,
      org_id: DEMO_ORG_ID,
      store_id: DEMO_STORE_ID,
      staff_id: staffId,
      device_id: DEVICE_ID,
      permission_version: 1,
      authentication_method: "password",
      status: "active",
      family_id: randomUUID(),
      created_at: 1,
      revoked_at: null,
    }),
    authority: Object.freeze({
      staff_id: staffId,
      display_name: displayName,
      role: staffId === DEMO_STAFF_A_ID ? "admin" : "staff",
      permission_version: 1,
      is_privacy_admin: false,
    }),
  });
}

function registrationRequest(
  privateKey: KeyObject,
  challenge: EdgeAuthorityChallengeData,
  challengeInput: EdgeAuthorityChallengeRequest,
) {
  const authority = Object.freeze({
    protocol_version: "1.0.0",
    payload: Object.freeze({
      org_id: challenge.org_id,
      store_id: challenge.store_id,
      staff_id: challenge.staff_id,
      session_id: challenge.session_id,
      session_version: challenge.session_version,
      permission_version: challenge.permission_version,
      device_id: challenge.device_id,
      device_public_key_spki: challengeInput.device_public_key_spki,
      challenge_id: challenge.challenge_id,
      challenge: challenge.challenge,
      request_nonce: challengeInput.request_nonce,
      request_primary: challengeInput.request_primary,
      pairing_code: challenge.pairing_code,
    }),
  });
  return EdgeAuthorityRequestSchema.parse({
    ...authority,
    sig: sign(null, canonicalizeEdgeDeviceRegistrationForSigning(authority), privateKey).toString(
      "base64url",
    ),
  });
}

function authorityChallengeInput(publicKey: KeyObject): EdgeAuthorityChallengeRequest {
  return Object.freeze({
    request_nonce: randomUUID(),
    device_public_key_spki: publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
    request_primary: true,
  });
}

type LeaseAuthority = Readonly<{
  grantId: string;
  leaseId: string;
  primaryEpoch: number;
  enqueuedAt: string;
}>;

function replayRequest(
  privateKey: KeyObject,
  authority: LeaseAuthority,
  queueId: string,
  idempotencyKey: string,
  perLeaseSeq: number,
): EdgeReplayRequest {
  const unsigned = Object.freeze({
    protocol_version: "1.0.0",
    payload: Object.freeze({
      device_id: DEVICE_ID,
      envelope: Object.freeze({
        queue_envelope_version: 2,
        contracts_major: 0,
        queue_id: queueId,
        enqueued_at: authority.enqueuedAt,
        payload: Object.freeze({
          command: "payment.collect",
          version: "0.2.0",
          mode: "direct" as const,
          args: Object.freeze({ order_id: ORDER_ID, amount_cents: 100, method: "cash" }),
          idempotency_key: idempotencyKey,
          dry_run: false,
        }),
        authorization: Object.freeze({
          kind: "primary_lease" as const,
          grant_id: authority.grantId,
          lease_id: authority.leaseId,
          primary_epoch: authority.primaryEpoch,
          per_lease_seq: perLeaseSeq,
        }),
      }),
    }),
  });
  return EdgeReplayRequestSchema.parse({
    ...unsigned,
    sig: sign(null, canonicalizeEdgeReplayForSigning(unsigned), privateKey).toString("base64url"),
  });
}

function fixedIds(...ids: readonly string[]): () => string {
  let index = 0;
  return () => {
    const id = ids[index];
    if (id === undefined) throw new Error("Replay integration exhausted deterministic IDs");
    index += 1;
    return id;
  };
}

async function clearFixture(pool: PgPool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE laundry_owner");
    await client.query("DELETE FROM audit_log WHERE id = ANY($1::uuid[])", [ALL_AUDIT_IDS]);
    await client.query("DELETE FROM settings WHERE id = ANY($1::uuid[])", [ALL_KEYS]);
    await client.query(
      `DELETE FROM command_idempotency
        WHERE org_id = $1::uuid AND store_id = $2::uuid
          AND idempotency_key = ANY($3::uuid[])`,
      [DEMO_ORG_ID, DEMO_STORE_ID, ALL_KEYS],
    );
    await client.query(
      `DELETE FROM edge_replay_records
        WHERE org_id = $1::uuid AND store_id = $2::uuid`,
      [DEMO_ORG_ID, DEMO_STORE_ID],
    );
    for (const table of [
      "offline_grant_replay_state",
      "primary_lease_replay_state",
      "primary_leases",
      "offline_grants",
      "primary_lease_heads",
      "edge_authority_challenges",
      "edge_devices",
    ]) {
      await client.query(`DELETE FROM ${table} WHERE org_id = $1::uuid AND store_id = $2::uuid`, [
        DEMO_ORG_ID,
        DEMO_STORE_ID,
      ]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function createProbeRegistry() {
  const registry = createM1CommandRegistry();
  registry.registerHandler("payment.collect", async ({ client, tenant, request }) => {
    const probeId = request.idempotencyKey;
    if (probeId === undefined) throw new Error("Replay probe requires idempotency");
    await client.query(
      `INSERT INTO settings (id, org_id, key, value_json, updated_at, updated_by_staff_id)
       VALUES ($1::uuid, $2::uuid, $3, $4, clock_timestamp(), $5::uuid)`,
      [
        probeId,
        tenant.orgId,
        `edge.replay.integration.${probeId}`,
        JSON.stringify({ idempotency_key: probeId }),
        tenant.staffId,
      ],
    );
    return Object.freeze({
      result: Object.freeze({ probe_id: probeId }),
      audit: Object.freeze({ entity: "settings", entityId: probeId }),
    });
  });
  return registry;
}

async function executePrepared(
  pool: PgPool,
  prepared: PreparedPgReplay,
  newId: () => string,
): Promise<Readonly<{ result: CommandResult; disposition: "applied" | "duplicate" }>> {
  const envelope = prepared.request.payload.envelope;
  if (envelope.payload.mode !== "direct") {
    throw new Error("Replay integration requires a direct command");
  }
  const payload = envelope.payload;
  const tenant: TenantContext = Object.freeze({
    orgId: prepared.orgId,
    storeId: prepared.storeId,
    staffId: prepared.originalStaffId,
  });
  const actor: ActorContext = Object.freeze({
    staffId: prepared.originalStaffId,
    deviceId: prepared.deviceId,
    via: "edge_replay",
    permissions: permissionsForAuthority({
      role: prepared.role,
      is_privacy_admin: prepared.isPrivacyAdmin,
    }),
  });
  const guarded = createPgReplayGuard(prepared, newId);
  const result = await withPoolClient(pool, (sql) =>
    executeCommand(sql, tenant, payload.command, payload.args, {
      registry: createProbeRegistry(),
      actor,
      version: payload.version,
      dryRun: payload.dry_run,
      idempotencyKey: payload.idempotency_key,
      idempotencyStore: createPgIdempotencyStore(pool),
      transactionGuard: guarded.guard,
      newId,
    }),
  );
  return Object.freeze({ result, disposition: guarded.disposition() });
}

async function prepareAndExecute(
  pool: PgPool,
  replaySession: AuthorizedSession,
  request: EdgeReplayRequest,
  newId: () => string,
) {
  const prepared = await preparePgReplay(pool, replaySession, request);
  assert.ok(prepared, "signed replay must prepare against persisted authority");
  return executePrepared(pool, prepared, newId);
}

async function setHeadToNextEpoch(pool: PgPool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE laundry_owner");
    const updated = await client.query(
      `UPDATE primary_lease_heads
          SET current_epoch = current_epoch + 1,
              current_lease_id = NULL,
              current_device_id = NULL,
              current_not_after = NULL,
              updated_at = clock_timestamp()
        WHERE org_id = $1::uuid AND store_id = $2::uuid`,
      [DEMO_ORG_ID, DEMO_STORE_ID],
    );
    assert.equal(updated.rowCount, 1);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

test(
  "real PG replay atomically arbitrates signed queues and keeps records append-only",
  { skip: urls === null },
  async () => {
    assert.ok(urls);
    const adminPool = createPgPool({ connectionString: urls.admin });
    const appPool = createPgPool({ connectionString: urls.app, max: 4 });
    try {
      await seedPgTestIdentityFixture(adminPool);
      await clearFixture(adminPool);

      const deviceKeys = generateKeyPairSync("ed25519");
      const authorityService = createEdgeAuthorityService({
        store: createPgAuthorityStore(appPool),
        randomUUID,
        keyPair: generateKeyPairSync("ed25519"),
      });
      const issuerSession = session(DEMO_STAFF_A_ID, "Fixture Staff A");
      const challengeInput = authorityChallengeInput(deviceKeys.publicKey);
      const challenge = await authorityService.challenge(issuerSession, challengeInput);
      assert.ok(challenge);
      const issued = await authorityService.issue(
        issuerSession,
        registrationRequest(deviceKeys.privateKey, challenge, challengeInput),
      );
      assert.ok(issued);
      assert.ok(issued.primary_lease);
      assert.equal(issued.primary_lease.payload.org_id, issued.offline_grant.payload.org_id);
      assert.equal(issued.primary_lease.payload.grant_id, issued.offline_grant.payload.grant_id);
      const authority: LeaseAuthority = Object.freeze({
        grantId: issued.offline_grant.payload.grant_id,
        leaseId: issued.primary_lease.payload.lease_id,
        primaryEpoch: issued.primary_lease.payload.primary_epoch,
        enqueuedAt: issued.primary_lease.payload.issued_at,
      });
      const replaySession = session(DEMO_STAFF_B_ID, "Fixture Staff B");
      const appliedRequest = replayRequest(
        deviceKeys.privateKey,
        authority,
        APPLIED_QUEUE_ID,
        APPLIED_KEY,
        1,
      );

      const applied = await prepareAndExecute(
        appPool,
        replaySession,
        appliedRequest,
        fixedIds(APPLIED_AUDIT_ID, APPLIED_RECORD_ID),
      );
      assert.equal(applied.result.ok, true, JSON.stringify(applied.result));
      assert.equal(applied.disposition, "applied");

      const committed = await adminPool.query<{
        probe_count: string;
        audit_count: string;
        idempotency_status: string | null;
        idempotency_ok: string | null;
        decision: string | null;
        last_seq: string | null;
        audit_staff_id: string | null;
        audit_via: string | null;
        original_staff_id: string | null;
        replayed_by_staff_id: string | null;
      }>(
        `SELECT
           (SELECT count(*)::text FROM settings WHERE id = $1::uuid) AS probe_count,
           (SELECT count(*)::text FROM audit_log WHERE id = $2::uuid) AS audit_count,
           (SELECT status FROM command_idempotency
             WHERE org_id = $3::uuid AND store_id = $4::uuid
               AND command = 'payment.collect' AND idempotency_key = $1::uuid) AS idempotency_status,
           (SELECT result_json ->> 'ok' FROM command_idempotency
             WHERE org_id = $3::uuid AND store_id = $4::uuid
               AND command = 'payment.collect' AND idempotency_key = $1::uuid) AS idempotency_ok,
           (SELECT decision FROM edge_replay_records WHERE id = $5::uuid) AS decision,
           (SELECT last_seq::text FROM primary_lease_replay_state
             WHERE org_id = $3::uuid AND store_id = $4::uuid
               AND lease_id = $6::uuid) AS last_seq,
           (SELECT staff_id::text FROM audit_log WHERE id = $2::uuid) AS audit_staff_id,
           (SELECT via FROM audit_log WHERE id = $2::uuid) AS audit_via,
           (SELECT original_staff_id::text FROM edge_replay_records
             WHERE id = $5::uuid) AS original_staff_id,
           (SELECT replayed_by_staff_id::text FROM edge_replay_records
             WHERE id = $5::uuid) AS replayed_by_staff_id`,
        [
          APPLIED_KEY,
          APPLIED_AUDIT_ID,
          DEMO_ORG_ID,
          DEMO_STORE_ID,
          APPLIED_RECORD_ID,
          authority.leaseId,
        ],
      );
      assert.deepEqual(committed.rows[0], {
        probe_count: "1",
        audit_count: "1",
        idempotency_status: "completed",
        idempotency_ok: "true",
        decision: "applied",
        last_seq: "1",
        audit_staff_id: DEMO_STAFF_A_ID,
        audit_via: "edge_replay",
        original_staff_id: DEMO_STAFF_A_ID,
        replayed_by_staff_id: DEMO_STAFF_B_ID,
      });

      const duplicate = await prepareAndExecute(
        appPool,
        replaySession,
        appliedRequest,
        fixedIds(DUPLICATE_RECORD_ID),
      );
      assert.equal(duplicate.result.ok, true, JSON.stringify(duplicate.result));
      assert.equal(duplicate.disposition, "duplicate");
      const duplicateCounts = await adminPool.query<{
        probes: string;
        audits: string;
        idempotency: string;
        applied: string;
        duplicates: string;
        last_seq: string;
      }>(
        `SELECT
           (SELECT count(*)::text FROM settings WHERE id = $1::uuid) AS probes,
           (SELECT count(*)::text FROM audit_log WHERE id = $2::uuid) AS audits,
           (SELECT count(*)::text FROM command_idempotency
             WHERE org_id = $3::uuid AND store_id = $4::uuid
               AND idempotency_key = $1::uuid) AS idempotency,
           count(*) FILTER (WHERE decision = 'applied')::text AS applied,
           count(*) FILTER (WHERE decision = 'duplicate')::text AS duplicates,
           (SELECT last_seq::text FROM primary_lease_replay_state
             WHERE org_id = $3::uuid AND store_id = $4::uuid
               AND lease_id = $5::uuid) AS last_seq
         FROM edge_replay_records
        WHERE org_id = $3::uuid AND store_id = $4::uuid
          AND reported_queue_id = $6::uuid`,
        [
          APPLIED_KEY,
          APPLIED_AUDIT_ID,
          DEMO_ORG_ID,
          DEMO_STORE_ID,
          authority.leaseId,
          APPLIED_QUEUE_ID,
        ],
      );
      assert.deepEqual(duplicateCounts.rows[0], {
        probes: "1",
        audits: "1",
        idempotency: "1",
        applied: "1",
        duplicates: "1",
        last_seq: "1",
      });

      const gap = await prepareAndExecute(
        appPool,
        replaySession,
        replayRequest(deviceKeys.privateKey, authority, GAP_QUEUE_ID, GAP_KEY, 3),
        fixedIds(GAP_RECORD_ID),
      );
      assert.equal(gap.result.ok, false);
      if (!gap.result.ok) assert.equal(gap.result.error.code, "REPLAY_ARBITRATION_REQUIRED");
      const rejectedGap = await adminPool.query<{
        decision: string;
        reason: string;
        probe_count: string;
        idempotency_count: string;
        last_seq: string;
      }>(
        `SELECT record.decision, record.reason,
                (SELECT count(*)::text FROM settings WHERE id = $1::uuid) AS probe_count,
                (SELECT count(*)::text FROM command_idempotency
                  WHERE org_id = $2::uuid AND store_id = $3::uuid
                    AND idempotency_key = $1::uuid) AS idempotency_count,
                state.last_seq::text
           FROM edge_replay_records record
           JOIN primary_lease_replay_state state
             ON state.org_id = record.org_id AND state.store_id = record.store_id
            AND state.lease_id = record.lease_id
          WHERE record.id = $4::uuid`,
        [GAP_KEY, DEMO_ORG_ID, DEMO_STORE_ID, GAP_RECORD_ID],
      );
      assert.deepEqual(rejectedGap.rows[0], {
        decision: "rejected",
        reason: "sequence_gap",
        probe_count: "0",
        idempotency_count: "0",
        last_seq: "1",
      });

      const forcedRollback = await prepareAndExecute(
        appPool,
        replaySession,
        replayRequest(deviceKeys.privateKey, authority, FAILED_QUEUE_ID, FAILED_KEY, 2),
        fixedIds(FAILED_AUDIT_ID, APPLIED_RECORD_ID),
      );
      assert.equal(forcedRollback.result.ok, false);
      if (!forcedRollback.result.ok) {
        assert.equal(forcedRollback.result.error.code, "TRANSACTION_FAILED");
      }
      const rolledBack = await adminPool.query<{
        probes: string;
        audits: string;
        idempotency: string;
        records: string;
        last_seq: string;
      }>(
        `SELECT
           (SELECT count(*)::text FROM settings WHERE id = $1::uuid) AS probes,
           (SELECT count(*)::text FROM audit_log WHERE id = $2::uuid) AS audits,
           (SELECT count(*)::text FROM command_idempotency
             WHERE org_id = $3::uuid AND store_id = $4::uuid
               AND idempotency_key = $1::uuid) AS idempotency,
           (SELECT count(*)::text FROM edge_replay_records
             WHERE org_id = $3::uuid AND store_id = $4::uuid
               AND reported_queue_id = $5::uuid) AS records,
           (SELECT last_seq::text FROM primary_lease_replay_state
             WHERE org_id = $3::uuid AND store_id = $4::uuid
               AND lease_id = $6::uuid) AS last_seq`,
        [
          FAILED_KEY,
          FAILED_AUDIT_ID,
          DEMO_ORG_ID,
          DEMO_STORE_ID,
          FAILED_QUEUE_ID,
          authority.leaseId,
        ],
      );
      assert.deepEqual(rolledBack.rows[0], {
        probes: "0",
        audits: "0",
        idempotency: "0",
        records: "0",
        last_seq: "1",
      });

      await setHeadToNextEpoch(adminPool);
      const oldEpoch = await prepareAndExecute(
        appPool,
        replaySession,
        replayRequest(deviceKeys.privateKey, authority, OLD_EPOCH_QUEUE_ID, OLD_EPOCH_KEY, 2),
        fixedIds(OLD_EPOCH_RECORD_ID),
      );
      assert.equal(oldEpoch.result.ok, false);
      if (!oldEpoch.result.ok) {
        assert.equal(oldEpoch.result.error.code, "REPLAY_ARBITRATION_REQUIRED");
      }
      const arbitration = await adminPool.query<{
        decision: string;
        reason: string;
        last_seq: string;
        probe_count: string;
        idempotency_count: string;
      }>(
        `SELECT record.decision, record.reason, state.last_seq::text,
                (SELECT count(*)::text FROM settings WHERE id = $1::uuid) AS probe_count,
                (SELECT count(*)::text FROM command_idempotency
                  WHERE org_id = $2::uuid AND store_id = $3::uuid
                    AND idempotency_key = $1::uuid) AS idempotency_count
           FROM edge_replay_records record
           JOIN primary_lease_replay_state state
             ON state.org_id = record.org_id AND state.store_id = record.store_id
            AND state.lease_id = record.lease_id
          WHERE record.id = $4::uuid`,
        [OLD_EPOCH_KEY, DEMO_ORG_ID, DEMO_STORE_ID, OLD_EPOCH_RECORD_ID],
      );
      assert.deepEqual(arbitration.rows[0], {
        decision: "arbitration",
        reason: "old_epoch",
        last_seq: "2",
        probe_count: "0",
        idempotency_count: "0",
      });

      const nextChallengeInput = authorityChallengeInput(deviceKeys.publicKey);
      const nextChallenge = await authorityService.challenge(issuerSession, nextChallengeInput);
      assert.ok(nextChallenge);
      const nextIssued = await authorityService.issue(
        issuerSession,
        registrationRequest(deviceKeys.privateKey, nextChallenge, nextChallengeInput),
      );
      assert.ok(nextIssued);
      assert.ok(nextIssued.primary_lease);
      const mixedRequest = replayRequest(
        deviceKeys.privateKey,
        Object.freeze({
          grantId: authority.grantId,
          leaseId: nextIssued.primary_lease.payload.lease_id,
          primaryEpoch: nextIssued.primary_lease.payload.primary_epoch,
          enqueuedAt: nextIssued.primary_lease.payload.issued_at,
        }),
        randomUUID(),
        randomUUID(),
        1,
      );
      assert.equal(
        await preparePgReplay(appPool, replaySession, mixedRequest),
        null,
        "a grant and lease from different authority issuances must not prepare",
      );

      const withoutTenant = await appPool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM edge_replay_records",
      );
      assert.equal(withoutTenant.rows[0]?.count, "0");
      const tenant: TenantContext = Object.freeze({
        orgId: DEMO_ORG_ID,
        storeId: DEMO_STORE_ID,
        staffId: DEMO_STAFF_A_ID,
      });
      for (const statement of [
        "UPDATE edge_replay_records SET reason = 'forbidden' WHERE id = $1::uuid",
        "DELETE FROM edge_replay_records WHERE id = $1::uuid",
      ]) {
        await assert.rejects(
          () =>
            withPoolClient(appPool, (sql) =>
              withTenantTransaction(sql, tenant, (tx) => tx.query(statement, [APPLIED_RECORD_ID])),
            ),
          /permission denied/u,
        );
      }
    } finally {
      await clearFixture(adminPool);
      await appPool.end();
      await adminPool.end();
    }
  },
);
