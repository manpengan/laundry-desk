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

const DEVICE_ID = "a1919191-9191-4919-8919-919191919191";

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

function authorityRequest(
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
      request_primary: false,
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

type GrantAuthority = Readonly<{ grantId: string; issuedAt: string; notAfter: string }>;

function replayRequest(
  privateKey: KeyObject,
  authority: GrantAuthority,
  input: Readonly<{
    queueId?: string;
    idempotencyKey?: string;
    sequence: number;
    command?: "order.hold" | "order.receive" | "payment.collect";
    args?: unknown;
    enqueuedAt?: string;
  }>,
): EdgeReplayRequest {
  const command = input.command ?? "order.hold";
  const args =
    input.args ??
    Object.freeze({
      customer_name: "Offline Guest",
      lines: Object.freeze([
        Object.freeze({ service_code: "wash", category_code: "shirt", qty: 1 }),
      ]),
    });
  const unsigned = Object.freeze({
    protocol_version: "1.0.0",
    payload: Object.freeze({
      device_id: DEVICE_ID,
      envelope: Object.freeze({
        queue_envelope_version: 3,
        contracts_major: 0,
        queue_id: input.queueId ?? randomUUID(),
        enqueued_at: input.enqueuedAt ?? authority.issuedAt,
        payload: Object.freeze({
          command,
          version: command === "payment.collect" ? "0.2.0" : "0.3.0",
          mode: "direct" as const,
          args,
          idempotency_key: input.idempotencyKey ?? randomUUID(),
          dry_run: false,
        }),
        authorization: Object.freeze({
          kind: "grant" as const,
          grant_id: authority.grantId,
          per_grant_seq: input.sequence,
        }),
      }),
    }),
  });
  return EdgeReplayRequestSchema.parse({
    ...unsigned,
    sig: sign(null, canonicalizeEdgeReplayForSigning(unsigned), privateKey).toString("base64url"),
  });
}

async function clearFixture(pool: PgPool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE laundry_owner");
    await client.query(
      `DELETE FROM audit_log
        WHERE org_id = $1::uuid AND store_id = $2::uuid
          AND (via = 'edge_replay' OR command = 'edge.device.pair')`,
      [DEMO_ORG_ID, DEMO_STORE_ID],
    );
    await client.query(
      `DELETE FROM settings
        WHERE org_id = $1::uuid AND key LIKE 'edge.grant.replay.%'`,
      [DEMO_ORG_ID],
    );
    await client.query(
      `DELETE FROM command_idempotency
        WHERE org_id = $1::uuid AND store_id = $2::uuid AND command = 'order.hold'`,
      [DEMO_ORG_ID, DEMO_STORE_ID],
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
      "edge_authority_challenges",
      "edge_devices",
    ]) {
      await client.query(`DELETE FROM ${table} WHERE org_id = $1::uuid AND store_id = $2::uuid`, [
        DEMO_ORG_ID,
        DEMO_STORE_ID,
      ]);
    }
    await client.query(
      `UPDATE staffs SET permission_version = 1, is_active = true
        WHERE org_id = $1::uuid AND id = $2::uuid`,
      [DEMO_ORG_ID, DEMO_STAFF_A_ID],
    );
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
  registry.registerHandler("order.hold", async ({ client, tenant, request }) => {
    const probeId = request.idempotencyKey;
    if (probeId === undefined) throw new Error("Grant replay probe requires idempotency");
    await client.query(
      `INSERT INTO settings (id, org_id, key, value_json, updated_at, updated_by_staff_id)
       VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, clock_timestamp(), $5::uuid)`,
      [
        probeId,
        tenant.orgId,
        `edge.grant.replay.${probeId}`,
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
  newId: () => string = randomUUID,
): Promise<Readonly<{ result: CommandResult; disposition: "applied" | "duplicate" }>> {
  const envelope = prepared.request.payload.envelope;
  const payload = envelope.payload;
  if (payload.mode !== "direct") {
    throw new Error("Grant replay integration requires a direct command");
  }
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

async function prepareRequired(
  pool: PgPool,
  replaySession: AuthorizedSession,
  request: EdgeReplayRequest,
): Promise<PreparedPgReplay> {
  const prepared = await preparePgReplay(pool, replaySession, request);
  assert.ok(prepared, "signed ordinary grant replay must prepare");
  return prepared;
}

test(
  "real PG ordinary grant replay serializes queues, sequences, and authority arbitration",
  { skip: urls === null },
  async () => {
    assert.ok(urls);
    const adminPool = createPgPool({ connectionString: urls.admin });
    const appPool = createPgPool({ connectionString: urls.app, max: 6 });
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
      const challengeInput = Object.freeze({
        request_nonce: randomUUID(),
        device_public_key_spki: deviceKeys.publicKey
          .export({ type: "spki", format: "der" })
          .toString("base64url"),
        request_primary: false,
      });
      const challenge = await authorityService.challenge(issuerSession, challengeInput);
      assert.ok(challenge);
      const issued = await authorityService.issue(
        issuerSession,
        authorityRequest(deviceKeys.privateKey, challenge, challengeInput),
      );
      assert.ok(issued);
      assert.equal(issued.primary_lease, null);
      const authority: GrantAuthority = Object.freeze({
        grantId: issued.offline_grant.payload.grant_id,
        issuedAt: issued.offline_grant.payload.issued_at,
        notAfter: issued.offline_grant.payload.not_after,
      });
      const replaySession = session(DEMO_STAFF_B_ID, "Fixture Staff B");

      const primaryCommand = replayRequest(deviceKeys.privateKey, authority, {
        sequence: 1,
        command: "payment.collect",
        args: { order_id: randomUUID(), amount_cents: 100, method: "cash" },
      });
      assert.equal(await preparePgReplay(appPool, replaySession, primaryCommand), null);
      for (const method of ["wechat", "alipay", "other", "balance"]) {
        const nonCash = replayRequest(deviceKeys.privateKey, authority, {
          sequence: 1,
          command: "order.receive",
          args: {
            lines: [{ service_code: "wash", category_code: "shirt", qty: 1 }],
            initial_payment: { amount_cents: 100, method },
          },
        });
        assert.equal(await preparePgReplay(appPool, replaySession, nonCash), null);
      }

      for (const initial_payment of [undefined, { amount_cents: 100, method: "cash" }]) {
        const cashOrDebt = replayRequest(deviceKeys.privateKey, authority, {
          sequence: 1,
          command: "order.receive",
          args: {
            lines: [{ service_code: "wash", category_code: "shirt", qty: 1 }],
            ...(initial_payment === undefined ? {} : { initial_payment }),
          },
        });
        assert.ok(await preparePgReplay(appPool, replaySession, cashOrDebt));
      }

      const firstRequest = replayRequest(deviceKeys.privateKey, authority, { sequence: 1 });
      assert.equal(
        await preparePgReplay(
          appPool,
          replaySession,
          EdgeReplayRequestSchema.parse({ ...firstRequest, sig: "A".repeat(86) }),
        ),
        null,
      );
      const firstPrepared = await Promise.all([
        prepareRequired(appPool, replaySession, firstRequest),
        prepareRequired(appPool, replaySession, firstRequest),
      ]);
      const firstResults = await Promise.all(
        firstPrepared.map((item) => executePrepared(appPool, item)),
      );
      assert.deepEqual(firstResults.map((item) => item.disposition).sort(), [
        "applied",
        "duplicate",
      ]);
      assert.ok(firstResults.every((item) => item.result.ok));

      const queueCollision = await executePrepared(
        appPool,
        await prepareRequired(
          appPool,
          replaySession,
          replayRequest(deviceKeys.privateKey, authority, {
            sequence: 1,
            queueId: firstRequest.payload.envelope.queue_id,
          }),
        ),
      );
      assert.equal(queueCollision.result.ok, false);

      const secondRequests = [
        replayRequest(deviceKeys.privateKey, authority, { sequence: 2 }),
        replayRequest(deviceKeys.privateKey, authority, { sequence: 2 }),
      ] as const;
      const secondResults = await Promise.all(
        secondRequests.map(async (request) =>
          executePrepared(appPool, await prepareRequired(appPool, replaySession, request)),
        ),
      );
      assert.equal(secondResults.filter((item) => item.result.ok).length, 1);
      assert.equal(secondResults.filter((item) => !item.result.ok).length, 1);

      const gap = await executePrepared(
        appPool,
        await prepareRequired(
          appPool,
          replaySession,
          replayRequest(deviceKeys.privateKey, authority, { sequence: 4 }),
        ),
      );
      assert.equal(gap.result.ok, false);

      await adminPool.query(
        `UPDATE staffs SET permission_version = 2
          WHERE org_id = $1::uuid AND id = $2::uuid`,
        [DEMO_ORG_ID, DEMO_STAFF_A_ID],
      );
      const changed = await executePrepared(
        appPool,
        await prepareRequired(
          appPool,
          replaySession,
          replayRequest(deviceKeys.privateKey, authority, { sequence: 3 }),
        ),
      );
      assert.equal(changed.result.ok, false);
      await adminPool.query(
        `UPDATE staffs SET permission_version = 1
          WHERE org_id = $1::uuid AND id = $2::uuid`,
        [DEMO_ORG_ID, DEMO_STAFF_A_ID],
      );

      const outsideWindow = new Date(Date.parse(authority.notAfter) + 1).toISOString();
      const expiredPrepared = await prepareRequired(
        appPool,
        replaySession,
        replayRequest(deviceKeys.privateKey, authority, {
          sequence: 4,
          enqueuedAt: outsideWindow,
        }),
      );
      assert.equal(expiredPrepared.grantWindowValid, false);
      const expired = await executePrepared(appPool, expiredPrepared);
      assert.equal(expired.result.ok, false);

      const failingRequest = replayRequest(deviceKeys.privateKey, authority, { sequence: 5 });
      const existing = await adminPool.query<{ id: string }>(
        `SELECT id::text FROM edge_replay_records
          WHERE org_id = $1::uuid AND store_id = $2::uuid
          ORDER BY recorded_at LIMIT 1`,
        [DEMO_ORG_ID, DEMO_STORE_ID],
      );
      assert.ok(existing.rows[0]);
      const failed = await executePrepared(
        appPool,
        await prepareRequired(appPool, replaySession, failingRequest),
        () => existing.rows[0]!.id,
      );
      assert.equal(failed.result.ok, false);
      if (!failed.result.ok) assert.equal(failed.result.error.code, "TRANSACTION_FAILED");

      const summary = await adminPool.query<{
        last_seq: string;
        probes: string;
        applied: string;
        duplicate: string;
        collision: string;
        arbitration: string;
        rejected: string;
        failed_probe: string;
        invalid_shape: string;
      }>(
        `SELECT state.last_seq::text,
                (SELECT count(*)::text FROM settings
                  WHERE org_id = $1::uuid AND key LIKE 'edge.grant.replay.%') AS probes,
                count(*) FILTER (WHERE decision = 'applied')::text AS applied,
                count(*) FILTER (WHERE decision = 'duplicate')::text AS duplicate,
                count(*) FILTER (WHERE decision = 'collision')::text AS collision,
                count(*) FILTER (WHERE decision = 'arbitration')::text AS arbitration,
                count(*) FILTER (WHERE decision = 'rejected')::text AS rejected,
                (SELECT count(*)::text FROM settings WHERE id = $4::uuid) AS failed_probe,
                count(*) FILTER (
                  WHERE authorization_kind <> 'grant'
                     OR lease_id IS NOT NULL OR primary_epoch IS NOT NULL
                     OR reported_per_lease_seq IS NOT NULL
                     OR reported_per_grant_seq IS NULL
                )::text AS invalid_shape
           FROM edge_replay_records record
           JOIN offline_grant_replay_state state
             ON state.org_id = record.org_id AND state.store_id = record.store_id
            AND state.grant_id = record.grant_id
          WHERE record.org_id = $1::uuid AND record.store_id = $2::uuid
            AND record.grant_id = $3::uuid
          GROUP BY state.last_seq`,
        [
          DEMO_ORG_ID,
          DEMO_STORE_ID,
          authority.grantId,
          failingRequest.payload.envelope.payload.idempotency_key,
        ],
      );
      assert.deepEqual(summary.rows[0], {
        last_seq: "4",
        probes: "2",
        applied: "2",
        duplicate: "1",
        collision: "2",
        arbitration: "2",
        rejected: "1",
        failed_probe: "0",
        invalid_shape: "0",
      });

      const withoutTenant = await appPool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM offline_grant_replay_state",
      );
      assert.equal(withoutTenant.rows[0]?.count, "0");
      const tenant: TenantContext = Object.freeze({
        orgId: DEMO_ORG_ID,
        storeId: DEMO_STORE_ID,
        staffId: DEMO_STAFF_A_ID,
      });
      for (const statement of [
        `UPDATE offline_grant_replay_state SET grant_id = $3::uuid
          WHERE org_id = $1::uuid AND store_id = $2::uuid AND grant_id = $3::uuid`,
        `DELETE FROM offline_grant_replay_state
          WHERE org_id = $1::uuid AND store_id = $2::uuid AND grant_id = $3::uuid`,
      ]) {
        await assert.rejects(
          () =>
            withPoolClient(appPool, (sql) =>
              withTenantTransaction(sql, tenant, (tx) =>
                tx.query(statement, [DEMO_ORG_ID, DEMO_STORE_ID, authority.grantId]),
              ),
            ),
          /permission denied/u,
        );
      }

      await adminPool.query(
        `DELETE FROM offline_grant_replay_state
          WHERE org_id = $1::uuid AND store_id = $2::uuid AND grant_id = $3::uuid`,
        [DEMO_ORG_ID, DEMO_STORE_ID, authority.grantId],
      );
      const runReplayHeadStatement = (statement: string, lastSequence: number) =>
        withPoolClient(appPool, (sql) =>
          withTenantTransaction(sql, tenant, (tx) =>
            tx.query(statement, [DEMO_ORG_ID, DEMO_STORE_ID, authority.grantId, lastSequence]),
          ),
        );
      const insertReplayHead = `INSERT INTO offline_grant_replay_state (
          org_id, store_id, grant_id, last_seq, updated_at
        ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, clock_timestamp())`;
      const updateReplayHead = `UPDATE offline_grant_replay_state
          SET last_seq = $4, updated_at = clock_timestamp()
        WHERE org_id = $1::uuid AND store_id = $2::uuid AND grant_id = $3::uuid`;

      await assert.rejects(
        () => runReplayHeadStatement(insertReplayHead, 9),
        /offline grant replay head must start at zero/u,
      );
      await runReplayHeadStatement(insertReplayHead, 0);
      await assert.rejects(
        () => runReplayHeadStatement(updateReplayHead, 2),
        /offline grant replay head must advance monotonically/u,
      );
      await runReplayHeadStatement(updateReplayHead, 1);
      await assert.rejects(
        () => runReplayHeadStatement(updateReplayHead, 0),
        /offline grant replay head must advance monotonically/u,
      );
    } finally {
      await clearFixture(adminPool);
      await appPool.end();
      await adminPool.end();
    }
  },
);
