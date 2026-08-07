/** Real-PG durability regressions for WYSIWYS member top-up confirmation. */

import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import test from "node:test";

import { executeCommand } from "../bus/executor.js";
import { createPgIdempotencyStore } from "../bus/pg-idempotency.js";
import type { ActorContext, CommandResult } from "../bus/types.js";
import { createPgPool, resolvePgUrls, type PgPool } from "../db/pg-pool.js";
import { withPoolClient } from "../db/pg-sql-client.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import type { TenantContext } from "../db/types.js";
import { createRegisteredM1Bus } from "../handlers/register-m1.js";
import { DEMO_ADMIN_ID, DEMO_ORG_ID, DEMO_STORE_ID } from "../local/demo-ids.js";
import { seedPgTestIdentityFixture } from "../local/pg-test-fixture.js";
import { createPgMemberStore } from "../member/pg-store.js";
import { createPgMemberDeps } from "../member/runtime.js";
import { createMemoryOrderStore } from "../order/memory-store.js";
import { hashCanonical } from "./canonical.js";
import { createPgPendingActionStore, PENDING_ACTION_RETENTION_SECONDS } from "./pg-store.js";
import type { CreatePendingActionInput, PendingActionStore } from "./types.js";

const urls =
  process.env.LAUNDRY_USE_LOCAL_PG === "1" || process.env.LAUNDRY_USE_LOCAL_PG === "true"
    ? resolvePgUrls(process.env)
    : null;

const TENANT: TenantContext = Object.freeze({
  orgId: DEMO_ORG_ID,
  storeId: DEMO_STORE_ID,
  staffId: DEMO_ADMIN_ID,
});

const ACTOR: ActorContext = Object.freeze({
  staffId: DEMO_ADMIN_ID,
  deviceId: null,
  via: "ui",
  permissions: Object.freeze(["customer_write"]),
});

const NOW = 1_780_000_000;

function record(value: unknown): Readonly<Record<string, unknown>> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return value as Readonly<Record<string, unknown>>;
}

function confirmationRef(result: CommandResult): string {
  assert.equal(result.ok, false, JSON.stringify(result));
  if (result.ok) throw new Error("expected confirmation result");
  assert.equal(result.error.code, "POLICY_CONFIRMATION_REQUIRED");
  assert.equal(result.error.detail?.kind, "confirmation");
  if (result.error.detail?.kind !== "confirmation") throw new Error("missing confirmation detail");
  return result.error.detail.confirm_ref;
}

function ledgerId(result: CommandResult): string {
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error("expected executed result");
  const data = record(result.data.result);
  assert.equal(typeof data.ledger_id, "string");
  return data.ledger_id as string;
}

function createBus(pendingStore: PendingActionStore) {
  return createRegisteredM1Bus(
    {
      order: Object.freeze({
        store: createMemoryOrderStore(),
        timeZone: "UTC",
        now: () => NOW,
      }),
      member: createPgMemberDeps(),
    },
    pendingStore,
  );
}

async function runTopup(
  pool: PgPool,
  pendingStore: PendingActionStore,
  input: unknown,
  options: Readonly<{
    idempotencyKey?: string;
    confirmRef?: string;
    newId?: () => string;
    actor?: ActorContext;
  }> = {},
): Promise<CommandResult> {
  const bus = createBus(pendingStore);
  return withPoolClient(pool, (sql) =>
    executeCommand(sql, TENANT, "member.topup", input, {
      registry: bus.registry,
      actor: options.actor ?? ACTOR,
      chainHooks: bus.chainHooks,
      pendingStore,
      idempotencyStore: createPgIdempotencyStore(pool),
      ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
      ...(options.confirmRef === undefined ? {} : { confirmRef: options.confirmRef }),
      ...(options.newId === undefined ? {} : { newId: options.newId }),
    }),
  );
}

async function seedAccount(
  pool: PgPool,
): Promise<Readonly<{ customerId: string; accountId: string }>> {
  const customerId = randomUUID();
  await withPoolClient(pool, (sql) =>
    withTenantTransaction(sql, TENANT, async (tx) => {
      await tx.query(
        `INSERT INTO customers (id, org_id, phone, name, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, 'Pending durability test', now(), now())`,
        [customerId, TENANT.orgId, `139${randomUUID().replaceAll("-", "").slice(0, 8)}`],
      );
    }),
  );
  const opened = await withPoolClient(pool, (sql) =>
    withTenantTransaction(sql, TENANT, (tx) =>
      createPgMemberStore(tx, TENANT).openAccount({
        customer_id: customerId,
        store_id: TENANT.storeId,
        at: NOW,
      }),
    ),
  );
  assert.equal(opened.ok, true, JSON.stringify(opened));
  if (!opened.ok) throw new Error("unable to seed member account");
  return Object.freeze({ customerId, accountId: opened.value.account.account_id });
}

async function upsertBonusRule(
  pool: PgPool,
  input: Readonly<{
    ruleId: string | null;
    threshold: number;
    bonus: number;
    at: number;
  }>,
): Promise<string> {
  const outcome = await withPoolClient(pool, (sql) =>
    withTenantTransaction(sql, TENANT, (tx) =>
      createPgMemberStore(tx, TENANT).upsertBonusRule({
        rule_id: input.ruleId,
        min_topup_cents: input.threshold,
        bonus_cents: input.bonus,
        status: "active",
        staff_id: TENANT.staffId,
        at: input.at,
        note: null,
      }),
    ),
  );
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  if (!outcome.ok) throw new Error("unable to seed bonus rule");
  return outcome.value.rule_id;
}

async function counts(
  pool: PgPool,
  accountId: string,
  idempotencyKey: string,
  confirmRef: string,
): Promise<Readonly<{ ledger: number; audit: number; idempotency: number; consumed: number }>> {
  const result = await pool.query<{
    ledger: string;
    audit: string;
    idempotency: string;
    consumed: string;
  }>(
    `SELECT
       (SELECT count(*)::text FROM member_ledger WHERE account_id = $1::uuid) AS ledger,
       (SELECT count(*)::text FROM audit_log
          WHERE command = 'member.topup' AND idempotency_key = $2) AS audit,
       (SELECT count(*)::text FROM command_idempotency
          WHERE command = 'member.topup' AND idempotency_key = $2::uuid) AS idempotency,
       (SELECT count(*)::text FROM ai_pending_actions
          WHERE nonce = $3::uuid AND status = 'consumed') AS consumed`,
    [accountId, idempotencyKey, confirmRef],
  );
  const row = result.rows[0];
  assert.ok(row);
  return Object.freeze({
    ledger: Number(row.ledger),
    audit: Number(row.audit),
    idempotency: Number(row.idempotency),
    consumed: Number(row.consumed),
  });
}

test(
  "PG confirmation survives rebuild, rolls back atomically, replays lost responses and serializes concurrency",
  { skip: urls === null },
  async () => {
    assert.ok(urls);
    const adminPool = createPgPool({ connectionString: urls.admin });
    const appPool = createPgPool({ connectionString: urls.app, max: 8 });
    const singleConnectionPool = createPgPool({
      connectionString: urls.app,
      max: 1,
      connectionTimeoutMillis: 1_000,
    });
    const customerIds: string[] = [];
    const accountIds: string[] = [];
    const idempotencyKeys: string[] = [];
    const confirmRefs: string[] = [];
    const bonusRuleIds: string[] = [];
    try {
      await seedPgTestIdentityFixture(adminPool);

      // A new store instance represents a rebuilt local runtime. The second hop
      // must recover the exact frozen card from PostgreSQL, not process memory.
      const rebuilt = await seedAccount(singleConnectionPool);
      customerIds.push(rebuilt.customerId);
      accountIds.push(rebuilt.accountId);
      const rebuiltKey = randomUUID();
      idempotencyKeys.push(rebuiltKey);
      const rebuiltRef = confirmationRef(
        await runTopup(
          singleConnectionPool,
          createPgPendingActionStore(singleConnectionPool),
          { account_id: rebuilt.accountId, amount_cents: 123, method: "cash" },
          { idempotencyKey: rebuiltKey },
        ),
      );
      confirmRefs.push(rebuiltRef);
      const rebuiltResult = await runTopup(
        singleConnectionPool,
        createPgPendingActionStore(singleConnectionPool),
        {},
        { confirmRef: rebuiltRef },
      );
      ledgerId(rebuiltResult);

      const deniedReplay = await runTopup(
        singleConnectionPool,
        createPgPendingActionStore(singleConnectionPool),
        {},
        {
          confirmRef: rebuiltRef,
          actor: Object.freeze({ ...ACTOR, permissions: Object.freeze([]) }),
        },
      );
      assert.equal(deniedReplay.ok, false);
      if (!deniedReplay.ok) assert.equal(deniedReplay.error.code, "PERMISSION_DENIED");
      assert.doesNotMatch(JSON.stringify(deniedReplay), /ledger_id/iu);

      // Treat the successful result as a response lost after COMMIT. A third
      // runtime instance must return the byte-equivalent durable result.
      const replay = await runTopup(
        singleConnectionPool,
        createPgPendingActionStore(singleConnectionPool),
        {},
        { confirmRef: rebuiltRef },
      );
      assert.deepEqual(replay, rebuiltResult);
      assert.deepEqual(await counts(adminPool, rebuilt.accountId, rebuiltKey, rebuiltRef), {
        ledger: 1,
        audit: 1,
        idempotency: 1,
        consumed: 1,
      });

      // Two first hops may share a caller key while freezing different bonus
      // authority. The confirmation hash must bind that authority so the later
      // card cannot replay a differently priced result.
      const repriced = await seedAccount(singleConnectionPool);
      customerIds.push(repriced.customerId);
      accountIds.push(repriced.accountId);
      const amount = 1_500_000_000 + randomInt(1_000_000);
      const ruleId = await upsertBonusRule(singleConnectionPool, {
        ruleId: null,
        threshold: amount,
        bonus: 200,
        at: NOW + 1,
      });
      bonusRuleIds.push(ruleId);
      const repricedKey = randomUUID();
      idempotencyKeys.push(repricedKey);
      const richerRef = confirmationRef(
        await runTopup(
          singleConnectionPool,
          createPgPendingActionStore(singleConnectionPool),
          { account_id: repriced.accountId, amount_cents: amount, method: "cash" },
          { idempotencyKey: repricedKey },
        ),
      );
      confirmRefs.push(richerRef);
      await upsertBonusRule(singleConnectionPool, {
        ruleId,
        threshold: amount,
        bonus: 100,
        at: NOW + 2,
      });
      const leanerRef = confirmationRef(
        await runTopup(
          singleConnectionPool,
          createPgPendingActionStore(singleConnectionPool),
          { account_id: repriced.accountId, amount_cents: amount, method: "cash" },
          { idempotencyKey: repricedKey },
        ),
      );
      confirmRefs.push(leanerRef);
      assert.notEqual(leanerRef, richerRef);
      ledgerId(
        await runTopup(
          singleConnectionPool,
          createPgPendingActionStore(singleConnectionPool),
          {},
          { confirmRef: leanerRef },
        ),
      );
      const conflictingAuthority = await runTopup(
        singleConnectionPool,
        createPgPendingActionStore(singleConnectionPool),
        {},
        { confirmRef: richerRef },
      );
      assert.equal(conflictingAuthority.ok, false);
      if (!conflictingAuthority.ok) {
        assert.equal(conflictingAuthority.error.code, "IDEMPOTENCY_CONFLICT");
      }
      assert.deepEqual(await counts(adminPool, repriced.accountId, repricedKey, richerRef), {
        ledger: 1,
        audit: 1,
        idempotency: 1,
        consumed: 0,
      });

      // Force the append-only audit INSERT to fail after ledger write and card
      // CAS. The enclosing transaction must roll back all four surfaces.
      const rollback = await seedAccount(appPool);
      customerIds.push(rollback.customerId);
      accountIds.push(rollback.accountId);
      const rollbackKey = randomUUID();
      idempotencyKeys.push(rollbackKey);
      const rollbackRef = confirmationRef(
        await runTopup(
          appPool,
          createPgPendingActionStore(appPool),
          { account_id: rollback.accountId, amount_cents: 124, method: "cash" },
          { idempotencyKey: rollbackKey },
        ),
      );
      confirmRefs.push(rollbackRef);
      const failed = await runTopup(
        appPool,
        createPgPendingActionStore(appPool),
        {},
        {
          confirmRef: rollbackRef,
          newId: () => "not-a-uuid",
        },
      );
      assert.equal(failed.ok, false);
      if (!failed.ok) assert.equal(failed.error.code, "TRANSACTION_FAILED");
      assert.deepEqual(await counts(adminPool, rollback.accountId, rollbackKey, rollbackRef), {
        ledger: 0,
        audit: 0,
        idempotency: 0,
        consumed: 0,
      });
      const afterRollback = await createPgPendingActionStore(appPool).get(rollbackRef, {
        tenant: TENANT,
      });
      assert.equal(afterRollback?.status, "pending");
      const retried = await runTopup(
        appPool,
        createPgPendingActionStore(appPool),
        {},
        { confirmRef: rollbackRef },
      );
      ledgerId(retried);

      // Two confirmations race on separate connections. The idempotency claim
      // and card row lock serialize them; both callers receive one result while
      // only one ledger/audit mutation commits.
      const concurrent = await seedAccount(appPool);
      customerIds.push(concurrent.customerId);
      accountIds.push(concurrent.accountId);
      const concurrentKey = randomUUID();
      idempotencyKeys.push(concurrentKey);
      const concurrentRef = confirmationRef(
        await runTopup(
          appPool,
          createPgPendingActionStore(appPool),
          { account_id: concurrent.accountId, amount_cents: 125, method: "cash" },
          { idempotencyKey: concurrentKey },
        ),
      );
      confirmRefs.push(concurrentRef);
      const [left, right] = await Promise.all([
        runTopup(appPool, createPgPendingActionStore(appPool), {}, { confirmRef: concurrentRef }),
        runTopup(appPool, createPgPendingActionStore(appPool), {}, { confirmRef: concurrentRef }),
      ]);
      assert.deepEqual(left, right);
      ledgerId(left);
      assert.deepEqual(
        await counts(adminPool, concurrent.accountId, concurrentKey, concurrentRef),
        { ledger: 1, audit: 1, idempotency: 1, consumed: 1 },
      );
    } finally {
      await adminPool.query("DELETE FROM audit_log WHERE idempotency_key = ANY($1::text[])", [
        idempotencyKeys,
      ]);
      await adminPool.query(
        "DELETE FROM command_idempotency WHERE idempotency_key = ANY($1::uuid[])",
        [idempotencyKeys],
      );
      await adminPool.query("DELETE FROM ai_pending_actions WHERE nonce = ANY($1::uuid[])", [
        confirmRefs,
      ]);
      await adminPool.query("DELETE FROM member_ledger WHERE account_id = ANY($1::uuid[])", [
        accountIds,
      ]);
      await adminPool.query("DELETE FROM member_accounts WHERE id = ANY($1::uuid[])", [accountIds]);
      await adminPool.query("DELETE FROM customers WHERE id = ANY($1::uuid[])", [customerIds]);
      await adminPool.query("DELETE FROM member_bonus_rules WHERE id = ANY($1::uuid[])", [
        bonusRuleIds,
      ]);
      await singleConnectionPool.end();
      await appPool.end();
      await adminPool.end();
    }
  },
);

type RawPendingFixture = Readonly<{
  nonce: string;
  idempotencyKey: string;
  status: "pending" | "expired" | "consumed";
  createdAt: number;
  expiresAt: number;
  consumedAt?: number;
}>;

async function insertRawPendingFixture(pool: PgPool, fixture: RawPendingFixture): Promise<void> {
  const args = Object.freeze({ fixture: fixture.nonce });
  await pool.query(
    `INSERT INTO ai_pending_actions (
       nonce, org_id, store_id, command, command_version, args_json,
       authority_present, args_hash, entity_versions_json, creator_staff_id,
       idempotency_key, created_at_epoch, expires_at_epoch, status,
       effective_risk, policy_outcome, requires_other_approver,
       consumed_by_staff_id, consumed_at_epoch
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, 'member.topup', '1.0.0', $4::jsonb,
       false, $5, '[]'::jsonb, $6::uuid,
       $7::uuid, $8::bigint, $9::bigint, $10,
       'R3', 'confirm', false, $11::uuid, $12::bigint
     )`,
    [
      fixture.nonce,
      TENANT.orgId,
      TENANT.storeId,
      JSON.stringify(args),
      hashCanonical(args),
      TENANT.staffId,
      fixture.idempotencyKey,
      fixture.createdAt,
      fixture.expiresAt,
      fixture.status,
      fixture.status === "consumed" ? TENANT.staffId : null,
      fixture.status === "consumed" ? fixture.consumedAt : null,
    ],
  );
}

async function scopedPendingCount(
  pool: PgPool,
  tenant: TenantContext,
  nonce: string,
): Promise<number> {
  return withPoolClient(pool, (sql) =>
    withTenantTransaction(sql, tenant, async (tx) => {
      const result = await tx.query<Readonly<{ count: string }>>(
        "SELECT count(*)::text AS count FROM ai_pending_actions WHERE nonce = $1::uuid",
        [nonce],
      );
      return Number(result.rows[0]?.count ?? "0");
    }),
  );
}

test(
  "PG pending-action RLS is fail-closed and bounded retention preserves live/replay authority",
  { skip: urls === null },
  async () => {
    assert.ok(urls);
    const adminPool = createPgPool({ connectionString: urls.admin });
    const appPool = createPgPool({ connectionString: urls.app, max: 4 });
    const now = Math.floor(Date.now() / 1000);
    const old = now - PENDING_ACTION_RETENTION_SECONDS - 600;
    const fixtures = Object.freeze({
      oldExpired: randomUUID(),
      recentExpired: randomUUID(),
      oldConsumed: randomUUID(),
      replayProtected: randomUUID(),
      replayExpired: randomUUID(),
      trigger: randomUUID(),
    });
    const fixtureRefs = Object.freeze(Object.values(fixtures));
    const idempotencyKeys = Object.freeze(fixtureRefs.map(() => randomUUID()));
    const otherStoreId = randomUUID();
    const otherOrgId = randomUUID();
    const otherOrgStoreId = randomUUID();
    const otherStaffId = randomUUID();

    try {
      await seedPgTestIdentityFixture(adminPool);
      await adminPool.query(
        `INSERT INTO stores (id, org_id, code, name, timezone, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, 'Pending RLS other store', 'UTC', now(), now())`,
        [otherStoreId, TENANT.orgId, `pending-other-${otherStoreId.slice(0, 8)}`],
      );
      await adminPool.query(
        `INSERT INTO orgs (id, code, name, created_at, updated_at)
         VALUES ($1::uuid, $2, 'Pending RLS other org', now(), now())`,
        [otherOrgId, `pending-org-${otherOrgId.slice(0, 8)}`],
      );
      await adminPool.query(
        `INSERT INTO stores (id, org_id, code, name, timezone, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, 'Pending RLS other org store', 'UTC', now(), now())`,
        [otherOrgStoreId, otherOrgId, `pending-store-${otherOrgStoreId.slice(0, 8)}`],
      );
      await adminPool.query(
        `INSERT INTO staffs (
           id, org_id, username, password_hash, display_name,
           is_active, permission_version, created_at, updated_at
         ) VALUES ($1::uuid, $2::uuid, $3, 'not-a-real-hash', 'Pending RLS actor',
           true, 1, now(), now())`,
        [otherStaffId, otherOrgId, `pending-actor-${otherStaffId.slice(0, 8)}`],
      );

      await insertRawPendingFixture(adminPool, {
        nonce: fixtures.oldExpired,
        idempotencyKey: idempotencyKeys[0]!,
        status: "expired",
        createdAt: old - 300,
        expiresAt: old,
      });
      await insertRawPendingFixture(adminPool, {
        nonce: fixtures.recentExpired,
        idempotencyKey: idempotencyKeys[1]!,
        status: "expired",
        createdAt: now - 600,
        expiresAt: now - 300,
      });
      await insertRawPendingFixture(adminPool, {
        nonce: fixtures.oldConsumed,
        idempotencyKey: idempotencyKeys[2]!,
        status: "consumed",
        createdAt: old - 300,
        expiresAt: old,
        consumedAt: old,
      });
      await insertRawPendingFixture(adminPool, {
        nonce: fixtures.replayProtected,
        idempotencyKey: idempotencyKeys[3]!,
        status: "consumed",
        createdAt: old - 300,
        expiresAt: old,
        consumedAt: old,
      });
      await insertRawPendingFixture(adminPool, {
        nonce: fixtures.replayExpired,
        idempotencyKey: idempotencyKeys[4]!,
        status: "consumed",
        createdAt: old - 300,
        expiresAt: old,
        consumedAt: old,
      });
      await adminPool.query(
        `INSERT INTO command_idempotency (
           org_id, store_id, command, idempotency_key, request_hash,
           status, result_json, completed_at
         ) VALUES
           ($1::uuid, $2::uuid, 'member.topup', $3::uuid, $5,
             'completed', '{"ok":true,"data":{}}'::jsonb, now()),
           ($1::uuid, $2::uuid, 'member.topup', $4::uuid, $6,
             'completed', '{"ok":true,"data":{}}'::jsonb, to_timestamp($7::double precision))`,
        [
          TENANT.orgId,
          TENANT.storeId,
          idempotencyKeys[3],
          idempotencyKeys[4],
          "replay-protected",
          "replay-expired",
          old,
        ],
      );

      const unset = await appPool.query<Readonly<{ count: string }>>(
        "SELECT count(*)::text AS count FROM ai_pending_actions WHERE nonce = $1::uuid",
        [fixtures.replayProtected],
      );
      assert.equal(Number(unset.rows[0]?.count ?? "0"), 0);
      assert.equal(
        await scopedPendingCount(
          appPool,
          Object.freeze({ ...TENANT, storeId: otherStoreId }),
          fixtures.replayProtected,
        ),
        0,
      );
      assert.equal(
        await scopedPendingCount(
          appPool,
          Object.freeze({ orgId: otherOrgId, storeId: otherOrgStoreId, staffId: otherStaffId }),
          fixtures.replayProtected,
        ),
        0,
      );
      assert.equal(await scopedPendingCount(appPool, TENANT, fixtures.replayProtected), 1);

      const triggerInput: CreatePendingActionInput = Object.freeze({
        nonce: fixtures.trigger,
        command: "member.topup",
        commandVersion: "1.0.0",
        args: Object.freeze({ fixture: fixtures.trigger }),
        entityVersions: Object.freeze([]),
        creatorStaffId: TENANT.staffId,
        orgId: TENANT.orgId,
        storeId: TENANT.storeId,
        idempotencyKey: idempotencyKeys[5]!,
        createdAt: now,
        effectiveRisk: "R3",
        policyOutcome: "confirm",
        requiresOtherApprover: false,
      });
      await withPoolClient(appPool, (sql) =>
        withTenantTransaction(
          sql,
          TENANT,
          async (tx) =>
            await createPgPendingActionStore(appPool).create(triggerInput, {
              tenant: TENANT,
              client: tx,
            }),
        ),
      );

      const remaining = await adminPool.query<Readonly<{ nonce: string }>>(
        "SELECT nonce::text FROM ai_pending_actions WHERE nonce = ANY($1::uuid[])",
        [fixtureRefs],
      );
      assert.deepEqual(
        remaining.rows.map((row) => row.nonce).sort(),
        [fixtures.recentExpired, fixtures.replayProtected, fixtures.trigger].sort(),
      );
    } finally {
      await adminPool.query(
        "DELETE FROM command_idempotency WHERE idempotency_key = ANY($1::uuid[])",
        [idempotencyKeys],
      );
      await adminPool.query("DELETE FROM ai_pending_actions WHERE nonce = ANY($1::uuid[])", [
        fixtureRefs,
      ]);
      await adminPool.query("DELETE FROM staffs WHERE id = $1::uuid", [otherStaffId]);
      await adminPool.query("DELETE FROM stores WHERE id = ANY($1::uuid[])", [
        [otherStoreId, otherOrgStoreId],
      ]);
      await adminPool.query("DELETE FROM orgs WHERE id = $1::uuid", [otherOrgId]);
      await appPool.end();
      await adminPool.end();
    }
  },
);
