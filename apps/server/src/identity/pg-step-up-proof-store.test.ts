/** Real-PG durability and transaction regressions for step-up proofs. */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { ACCESS_TOKEN_AUDIENCE, ACCESS_TOKEN_ISSUER } from "@laundry/contracts";

import { createCsrfProofSigner } from "../auth/csrf.js";
import { executeCommand } from "../bus/executor.js";
import { createPgIdempotencyStore } from "../bus/pg-idempotency.js";
import type { ActorContext, CommandResult } from "../bus/types.js";
import { createPgPool, resolvePgUrls, type PgPool } from "../db/pg-pool.js";
import { withPoolClient } from "../db/pg-sql-client.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import type { TenantContext } from "../db/types.js";
import { createRegisteredM1Bus } from "../handlers/register-m1.js";
import { DEMO_ADMIN_ID, DEMO_ORG_ID, DEMO_STAFF_A_ID, DEMO_STORE_ID } from "../local/demo-ids.js";
import { seedPgTestIdentityFixture } from "../local/pg-test-fixture.js";
import { loadPgStaffDirectory } from "../local/staff-directory.js";
import { createPgStaffRoleResolver } from "../local/staff-role-resolver.js";
import { createPgPendingActionStore } from "../pending-actions/pg-store.js";
import type { PendingAction } from "../pending-actions/types.js";
import { createStepUpProof } from "../policy/step-up.js";
import type { StepUpProofStore } from "../policy/step-up-proof-store.js";
import { createAccessTokenSigner } from "./crypto-util.js";
import { createPasswordPort } from "./password.js";
import { createStepUpChallenge, verifyStepUpPin } from "./pin-step-up.js";
import { createPgIdentityStore } from "./pg-store.js";
import { createPgStepUpProofStore } from "./pg-step-up-proof-store.js";
import type { SessionRecord } from "./types.js";

const urls =
  process.env.LAUNDRY_USE_LOCAL_PG === "1" || process.env.LAUNDRY_USE_LOCAL_PG === "true"
    ? resolvePgUrls(process.env)
    : null;

const TENANT: TenantContext = Object.freeze({
  orgId: DEMO_ORG_ID,
  storeId: DEMO_STORE_ID,
  staffId: DEMO_STAFF_A_ID,
});

const ACTOR: ActorContext = Object.freeze({
  staffId: DEMO_STAFF_A_ID,
  deviceId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  via: "ui",
  permissions: Object.freeze(["settings_admin", "staff_read"]),
});

type ProofFixture = Readonly<{
  proofId: string;
  confirmRef: string;
  idempotencyKey: string;
  settingKey: string;
}>;

function sqlPlatformDeps() {
  return Object.freeze({
    persistence: "sql" as const,
    settings: {
      getMany: async () => Object.freeze({}),
      setMany: async () => undefined,
    },
    features: {
      get: async () =>
        Object.freeze({
          fulfillment: true,
          membership: false,
          shift_closing: false,
          delivery: false,
          marketing: false,
          ai: false,
        }),
    },
    audit: { list: async () => Object.freeze([]) },
  });
}

async function insertSession(adminPool: PgPool, sessionId: string): Promise<void> {
  await adminPool.query(
    `INSERT INTO sessions (
       id, org_id, store_id, staff_id, device_id, session_version,
       permission_version, authentication_method, status, created_at
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
       1, 1, 'password', 'active', now())`,
    [sessionId, TENANT.orgId, TENANT.storeId, TENANT.staffId, ACTOR.deviceId],
  );
}

async function seedPending(
  pool: PgPool,
  nowEpochSeconds: number,
): Promise<Readonly<{ fixture: ProofFixture; pending: PendingAction }>> {
  const pendingStore = createPgPendingActionStore(pool);
  const confirmRef = randomUUID();
  const idempotencyKey = randomUUID();
  const settingKey = `step_up.atomic_${randomUUID().replaceAll("-", "")}`;
  const pending = await withPoolClient(pool, (sql) =>
    withTenantTransaction(
      sql,
      TENANT,
      async (tx) =>
        await pendingStore.create(
          {
            nonce: confirmRef,
            command: "platform.settings.set",
            commandVersion: "1.0.0",
            args: { entries: [{ key: settingKey, value_json: JSON.stringify(4242) }] },
            entityVersions: Object.freeze([]),
            creatorStaffId: TENANT.staffId,
            orgId: TENANT.orgId,
            storeId: TENANT.storeId,
            idempotencyKey,
            createdAt: nowEpochSeconds,
            effectiveRisk: "R5",
            policyOutcome: "step_up",
            requiresOtherApprover: true,
          },
          Object.freeze({ tenant: TENANT, client: tx }),
        ),
    ),
  );
  return Object.freeze({
    fixture: Object.freeze({
      proofId: randomUUID(),
      confirmRef,
      idempotencyKey,
      settingKey,
    }),
    pending,
  });
}

async function seedProof(
  pool: PgPool,
  sessionId: string,
  nowEpochSeconds: number,
): Promise<ProofFixture> {
  const { fixture, pending } = await seedPending(pool, nowEpochSeconds);
  const proof = createStepUpProof({
    proofId: fixture.proofId,
    pending,
    approverStaffId: DEMO_ADMIN_ID,
    issuedAt: nowEpochSeconds,
    sessionBinding: Object.freeze({ sessionId, sessionVersion: 1 }),
  });
  await createPgStepUpProofStore(pool).insert(proof, { tenant: TENANT });
  return fixture;
}

async function executeConfirmed(
  pool: PgPool,
  sessionId: string,
  fixture: ProofFixture,
  nowEpochSeconds: number,
  newId?: () => string,
): Promise<CommandResult> {
  const pendingStore = createPgPendingActionStore(pool);
  const stepUpProofStore = createPgStepUpProofStore(pool);
  const bus = createRegisteredM1Bus({ platform: sqlPlatformDeps() }, pendingStore);
  return withPoolClient(pool, (sql) =>
    executeCommand(
      sql,
      TENANT,
      "platform.settings.set",
      {},
      {
        registry: bus.registry,
        actor: ACTOR,
        chainHooks: bus.chainHooks,
        pendingStore,
        stepUpProofStore,
        idempotencyStore: createPgIdempotencyStore(pool),
        confirmRef: fixture.confirmRef,
        sessionBinding: Object.freeze({ sessionId, sessionVersion: 1 }),
        now: () => new Date(nowEpochSeconds * 1000),
        ...(newId === undefined ? {} : { newId }),
      },
    ),
  );
}

async function cleanup(
  adminPool: PgPool,
  sessionId: string,
  fixtures: readonly ProofFixture[],
): Promise<void> {
  const proofIds = fixtures.map((fixture) => fixture.proofId);
  const confirmRefs = fixtures.map((fixture) => fixture.confirmRef);
  const idempotencyKeys = fixtures.map((fixture) => fixture.idempotencyKey);
  const settingKeys = fixtures.map((fixture) => fixture.settingKey);
  await adminPool.query("DELETE FROM audit_log WHERE idempotency_key = ANY($1::text[])", [
    idempotencyKeys,
  ]);
  await adminPool.query("DELETE FROM command_idempotency WHERE idempotency_key = ANY($1::uuid[])", [
    idempotencyKeys,
  ]);
  await adminPool.query("DELETE FROM step_up_proofs WHERE proof_id = ANY($1::uuid[])", [proofIds]);
  await adminPool.query("DELETE FROM ai_pending_actions WHERE nonce = ANY($1::uuid[])", [
    confirmRefs,
  ]);
  await adminPool.query("DELETE FROM settings WHERE org_id = $1::uuid AND key = ANY($2::text[])", [
    TENANT.orgId,
    settingKeys,
  ]);
  await adminPool.query("DELETE FROM sessions WHERE id = $1::uuid", [sessionId]);
}

test(
  "PG step-up proof survives runtime rebuild and rolls back with business + audit on max=1",
  { skip: urls === null },
  async () => {
    assert.ok(urls);
    const adminPool = createPgPool({ connectionString: urls.admin });
    const singlePool = createPgPool({
      connectionString: urls.app,
      max: 1,
      connectionTimeoutMillis: 1_000,
    });
    const sessionId = randomUUID();
    const fixtures: ProofFixture[] = [];
    const now = Math.floor(Date.now() / 1000);
    try {
      await seedPgTestIdentityFixture(adminPool);
      await insertSession(adminPool, sessionId);
      const fixture = await seedProof(singlePool, sessionId, now);
      fixtures.push(fixture);

      const rebuiltStore: StepUpProofStore = createPgStepUpProofStore(singlePool);
      const rebuilt = await rebuiltStore.get(fixture.proofId, { tenant: TENANT });
      assert.equal(rebuilt?.status, "active");
      const otherTenant = Object.freeze({
        orgId: randomUUID(),
        storeId: randomUUID(),
        staffId: randomUUID(),
      });
      assert.equal(await rebuiltStore.get(fixture.proofId, { tenant: otherTenant }), null);

      const failed = await executeConfirmed(
        singlePool,
        sessionId,
        fixture,
        now + 1,
        () => "not-a-uuid",
      );
      assert.equal(failed.ok, false);
      if (!failed.ok) assert.equal(failed.error.code, "TRANSACTION_FAILED");

      const afterRollbackProof = await createPgStepUpProofStore(singlePool).get(fixture.proofId, {
        tenant: TENANT,
      });
      const afterRollbackCard = await createPgPendingActionStore(singlePool).get(
        fixture.confirmRef,
        { tenant: TENANT },
      );
      assert.equal(afterRollbackProof?.status, "active");
      assert.equal(afterRollbackCard?.status, "pending");
      const rolledBack = await adminPool.query<{ settings: string; audit: string }>(
        `SELECT
           (SELECT count(*)::text FROM settings
             WHERE org_id = $1::uuid AND key = $2) AS settings,
           (SELECT count(*)::text FROM audit_log
             WHERE command = 'platform.settings.set' AND idempotency_key = $3) AS audit`,
        [TENANT.orgId, fixture.settingKey, fixture.idempotencyKey],
      );
      assert.deepEqual(rolledBack.rows[0], { settings: "0", audit: "0" });

      const succeeded = await executeConfirmed(singlePool, sessionId, fixture, now + 2);
      assert.equal(succeeded.ok, true, JSON.stringify(succeeded));
      assert.equal(
        (await createPgStepUpProofStore(singlePool).get(fixture.proofId, { tenant: TENANT }))
          ?.status,
        "consumed",
      );
      assert.equal(
        (await createPgPendingActionStore(singlePool).get(fixture.confirmRef, { tenant: TENANT }))
          ?.status,
        "consumed",
      );
      const committed = await adminPool.query<{ settings: string; audit: string }>(
        `SELECT
           (SELECT count(*)::text FROM settings
             WHERE org_id = $1::uuid AND key = $2) AS settings,
           (SELECT count(*)::text FROM audit_log
             WHERE command = 'platform.settings.set' AND idempotency_key = $3) AS audit`,
        [TENANT.orgId, fixture.settingKey, fixture.idempotencyKey],
      );
      assert.deepEqual(committed.rows[0], { settings: "1", audit: "1" });
    } finally {
      await cleanup(adminPool, sessionId, fixtures);
      await singlePool.end();
      await adminPool.end();
    }
  },
);

test(
  "PG PIN success and proof issuance commit atomically and retention cascades",
  { skip: urls === null },
  async () => {
    assert.ok(urls);
    const adminPool = createPgPool({ connectionString: urls.admin });
    const singlePool = createPgPool({
      connectionString: urls.app,
      max: 1,
      connectionTimeoutMillis: 1_000,
    });
    const sessionId = randomUUID();
    let challengeId: string | null = null;
    const fixtures: ProofFixture[] = [];
    const now = Math.floor(Date.now() / 1000);
    try {
      const fixtureIdentity = await seedPgTestIdentityFixture(adminPool);
      await insertSession(adminPool, sessionId);
      const { fixture, pending } = await seedPending(singlePool, now);
      fixtures.push(fixture);
      const session: SessionRecord = Object.freeze({
        session_id: sessionId,
        session_version: 1,
        org_id: TENANT.orgId,
        store_id: TENANT.storeId,
        staff_id: TENANT.staffId,
        device_id: ACTOR.deviceId!,
        permission_version: 1,
        authentication_method: "password",
        status: "active",
        family_id: randomUUID(),
        created_at: now,
        revoked_at: null,
      });
      const identity = createPgIdentityStore(singlePool);
      const proofs = createPgStepUpProofStore(singlePool);
      const clock = Object.freeze({ nowEpochSeconds: () => now + 1 });
      const signingSecret = `${randomUUID()}${randomUUID()}`;
      const sessionDeps = Object.freeze({
        sessions: identity.sessions,
        refresh: identity.refresh,
        lifecycle: identity.lifecycle,
        clock,
        accessTokenSigner: createAccessTokenSigner({
          secret: signingSecret,
          issuer: ACCESS_TOKEN_ISSUER,
          audience: ACCESS_TOKEN_AUDIENCE,
        }),
        csrfProofMinter: createCsrfProofSigner(signingSecret),
      });
      const productionDeps = Object.freeze({
        challenges: identity.pinChallenges,
        lockouts: identity.pinLockouts,
        staff: identity.staff,
        pinPort: createPasswordPort(),
        clock,
        sessions: sessionDeps,
        pending: createPgPendingActionStore(singlePool),
        proofs,
        resolveStaffRole: createPgStaffRoleResolver(singlePool, loadPgStaffDirectory),
      });
      const challenge = await createStepUpChallenge(productionDeps, {
        purpose: "step_up",
        session,
        pending_action_ref: pending.nonce,
        approver_staff_id: DEMO_ADMIN_ID,
      });
      challengeId = challenge.challenge_id;

      const rollbackDeps = Object.freeze({
        ...productionDeps,
        proofs: Object.freeze({
          ...proofs,
          insert: async (...args: Parameters<StepUpProofStore["insert"]>) => {
            await proofs.insert(...args);
            throw new Error("forced proof issue rollback");
          },
        }),
      });
      await assert.rejects(
        () =>
          verifyStepUpPin(rollbackDeps, {
            challenge_id: challenge.challenge_id,
            pin: fixtureIdentity.adminPin,
            session,
          }),
        /forced proof issue rollback/u,
      );
      assert.equal((await identity.pinChallenges.get(challenge.challenge_id))?.status, "active");
      const rolledBackProofs = await adminPool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM step_up_proofs WHERE pending_action_ref = $1::uuid",
        [pending.nonce],
      );
      assert.equal(rolledBackProofs.rows[0]?.count, "0");

      const issued = await verifyStepUpPin(productionDeps, {
        challenge_id: challenge.challenge_id,
        pin: fixtureIdentity.adminPin,
        session,
      });
      assert.equal((await identity.pinChallenges.get(challenge.challenge_id))?.status, "consumed");
      const persisted = await proofs.get(issued.step_up_proof_id, { tenant: TENANT });
      assert.equal(persisted?.status, "active");
      assert.equal(persisted?.pendingActionRef, pending.nonce);
      assert.equal(persisted?.requesterStaffId, TENANT.staffId);
      assert.equal(persisted?.approverStaffId, DEMO_ADMIN_ID);

      const retentionCutoff = now - 30 * 24 * 60 * 60 - 600;
      await adminPool.query(
        `UPDATE ai_pending_actions
         SET created_at_epoch = $2::bigint, expires_at_epoch = $3::bigint
         WHERE nonce = $1::uuid`,
        [pending.nonce, retentionCutoff - 300, retentionCutoff],
      );
      const trigger = await seedPending(singlePool, now);
      fixtures.push(trigger.fixture);

      const cascaded = await adminPool.query<{ pending: string; proof: string }>(
        `SELECT
           (SELECT count(*)::text FROM ai_pending_actions WHERE nonce = $1::uuid) AS pending,
           (SELECT count(*)::text FROM step_up_proofs WHERE proof_id = $2::uuid) AS proof`,
        [pending.nonce, issued.step_up_proof_id],
      );
      assert.deepEqual(cascaded.rows[0], { pending: "0", proof: "0" });
    } finally {
      if (challengeId !== null) {
        await adminPool.query("DELETE FROM pin_challenges WHERE id = $1::uuid", [challengeId]);
      }
      await cleanup(adminPool, sessionId, fixtures);
      await singlePool.end();
      await adminPool.end();
    }
  },
);

test(
  "PG step-up proof CAS has one winner across concurrent transactions",
  { skip: urls === null },
  async () => {
    assert.ok(urls);
    const adminPool = createPgPool({ connectionString: urls.admin });
    const appPool = createPgPool({ connectionString: urls.app, max: 2 });
    const sessionId = randomUUID();
    const fixtures: ProofFixture[] = [];
    const now = Math.floor(Date.now() / 1000);
    try {
      await seedPgTestIdentityFixture(adminPool);
      await insertSession(adminPool, sessionId);
      const fixture = await seedProof(appPool, sessionId, now);
      fixtures.push(fixture);
      const store = createPgStepUpProofStore(appPool);
      const consume = () =>
        withPoolClient(appPool, (sql) =>
          withTenantTransaction(
            sql,
            TENANT,
            async (tx) =>
              await store.atomicConsume(
                fixture.proofId,
                now + 1,
                Object.freeze({ tenant: TENANT, client: tx }),
              ),
          ),
        );
      const results = await Promise.all([consume(), consume()]);
      assert.deepEqual([...results].sort(), [false, true]);
    } finally {
      await cleanup(adminPool, sessionId, fixtures);
      await appPool.end();
      await adminPool.end();
    }
  },
);
