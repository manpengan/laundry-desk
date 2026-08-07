import assert from "node:assert/strict";
import test from "node:test";

import { executeCommand } from "../bus/executor.js";
import { MemoryIdempotencyStore } from "../bus/idempotency.js";
import { HandlerCommandError, type ActorContext, type HandlerContext } from "../bus/types.js";
import { FakeSqlClient } from "../db/fake-client.js";
import type { TenantContext } from "../db/types.js";
import { createRegisteredM1Bus } from "../handlers/register-m1.js";
import { createMemoryOrderStore } from "../order/memory-store.js";
import { MemoryPendingActionStore } from "../pending-actions/store.js";
import { createMemoryMemberDeps } from "./runtime.js";
import { requireFrozenTopupBonus } from "./topup-confirmation.js";

const ORG_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STORE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const STAFF_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CUSTOMER_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const TENANT: TenantContext = Object.freeze({
  orgId: ORG_ID,
  storeId: STORE_ID,
  staffId: STAFF_ID,
});

const ACTOR: ActorContext = Object.freeze({
  staffId: STAFF_ID,
  deviceId: null,
  via: "ui",
  permissions: Object.freeze(["customer_write"]),
});
const LOW_PRIVILEGE_ACTOR: ActorContext = Object.freeze({
  ...ACTOR,
  staffId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  permissions: Object.freeze([]),
});
const OTHER_AUTHORIZED_ACTOR: ActorContext = Object.freeze({
  ...LOW_PRIVILEGE_ACTOR,
  permissions: Object.freeze(["customer_write"]),
});
const LOW_PRIVILEGE_TENANT: TenantContext = Object.freeze({
  ...TENANT,
  staffId: LOW_PRIVILEGE_ACTOR.staffId,
});

test("a confirmed top-up without frozen server authority fails closed", () => {
  const context: HandlerContext = Object.freeze({
    client: new FakeSqlClient(),
    tenant: TENANT,
    actor: ACTOR,
    request: Object.freeze({
      name: "member.topup",
      version: "1.0.0",
      input: Object.freeze({}),
      dryRun: false,
      confirmRef: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    }),
    parsed: Object.freeze({}),
  });

  assert.throws(
    () => requireFrozenTopupBonus(context, 100_000),
    (error: unknown) =>
      error instanceof HandlerCommandError && error.commandError.code === "POLICY_DENIED",
  );
});

test("member top-up confirms and executes the same server-frozen bonus tier", async () => {
  const member = createMemoryMemberDeps([CUSTOMER_ID]);
  const opened = await member.store.openAccount({
    customer_id: CUSTOMER_ID,
    store_id: STORE_ID,
    at: 1_780_000_000,
  });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const createdRule = await member.store.upsertBonusRule({
    rule_id: null,
    min_topup_cents: 100_000,
    bonus_cents: 10_000,
    status: "active",
    staff_id: STAFF_ID,
    at: 1_780_000_001,
    note: null,
  });
  assert.equal(createdRule.ok, true);
  if (!createdRule.ok) return;

  const pendingStore = new MemoryPendingActionStore();
  const bus = createRegisteredM1Bus(
    {
      order: Object.freeze({
        store: createMemoryOrderStore(),
        timeZone: "UTC",
        now: () => 1_780_000_100,
      }),
      member,
    },
    pendingStore,
  );
  const sql = new FakeSqlClient();
  const idempotencyStore = new MemoryIdempotencyStore();
  const input = Object.freeze({
    account_id: opened.value.account.account_id,
    amount_cents: 100_000,
    method: "cash",
  });

  const first = await executeCommand(sql, TENANT, "member.topup", input, {
    registry: bus.registry,
    actor: ACTOR,
    chainHooks: bus.chainHooks,
    pendingStore,
    idempotencyStore,
  });
  assert.equal(first.ok, false, JSON.stringify(first));
  if (first.ok) return;
  assert.equal(first.error.code, "POLICY_CONFIRMATION_REQUIRED");
  assert.deepEqual(first.error.detail, {
    kind: "confirmation",
    confirm_ref: first.error.detail?.kind === "confirmation" ? first.error.detail.confirm_ref : "",
    summary: {
      kind: "member_topup",
      principal_cents: 100_000,
      bonus_cents: 10_000,
      credited_cents: 110_000,
      matched_rule: {
        rule_id: createdRule.value.rule_id,
        min_topup_cents: 100_000,
        bonus_cents: 10_000,
      },
    },
  });
  if (first.error.detail?.kind !== "confirmation") return;

  const crossStaffAttempt = await executeCommand(
    sql,
    LOW_PRIVILEGE_TENANT,
    "member.topup",
    {},
    {
      registry: bus.registry,
      actor: OTHER_AUTHORIZED_ACTOR,
      chainHooks: bus.chainHooks,
      pendingStore,
      idempotencyStore,
      confirmRef: first.error.detail.confirm_ref,
    },
  );
  assert.equal(crossStaffAttempt.ok, false);
  if (!crossStaffAttempt.ok) assert.equal(crossStaffAttempt.error.code, "POLICY_DENIED");

  // Repricing after the first hop must not change what the confirmed action grants.
  await member.store.upsertBonusRule({
    rule_id: createdRule.value.rule_id,
    min_topup_cents: 100_000,
    bonus_cents: 1,
    status: "active",
    staff_id: STAFF_ID,
    at: 1_780_000_002,
    note: null,
  });

  const confirmed = await executeCommand(
    sql,
    TENANT,
    "member.topup",
    {},
    {
      registry: bus.registry,
      actor: ACTOR,
      chainHooks: bus.chainHooks,
      pendingStore,
      idempotencyStore,
      confirmRef: first.error.detail.confirm_ref,
    },
  );
  assert.equal(confirmed.ok, true, JSON.stringify(confirmed));

  const previewAttempt = await executeCommand(
    sql,
    TENANT,
    "member.topup",
    {},
    {
      registry: bus.registry,
      actor: ACTOR,
      chainHooks: bus.chainHooks,
      pendingStore,
      idempotencyStore,
      confirmRef: first.error.detail.confirm_ref,
      dryRun: true,
    },
  );
  assert.equal(previewAttempt.ok, false);
  if (!previewAttempt.ok) assert.equal(previewAttempt.error.code, "VALIDATION_FAILED");
  assert.doesNotMatch(JSON.stringify(previewAttempt), /account_id|amount_cents/iu);

  const deniedReplay = await executeCommand(
    sql,
    LOW_PRIVILEGE_TENANT,
    "member.topup",
    {},
    {
      registry: bus.registry,
      actor: LOW_PRIVILEGE_ACTOR,
      chainHooks: bus.chainHooks,
      pendingStore,
      idempotencyStore,
      confirmRef: first.error.detail.confirm_ref,
    },
  );
  assert.equal(deniedReplay.ok, false);
  if (!deniedReplay.ok) assert.equal(deniedReplay.error.code, "POLICY_DENIED");
  assert.doesNotMatch(JSON.stringify(deniedReplay), /credited_cents/iu);

  // A response lost after execution retries against an already-consumed card.
  // Resolve the frozen request first, then replay the card-bound idempotency key.
  const replay = await executeCommand(
    sql,
    TENANT,
    "member.topup",
    {},
    {
      registry: bus.registry,
      actor: ACTOR,
      chainHooks: bus.chainHooks,
      pendingStore,
      idempotencyStore,
      confirmRef: first.error.detail.confirm_ref,
    },
  );
  assert.deepEqual(replay, confirmed);

  const view = await member.store.getByCustomer(CUSTOMER_ID, 10);
  assert.equal(view?.balance.principal_cents, 100_000);
  assert.equal(view?.balance.bonus_cents, 10_000);
  assert.equal(view?.recent[0]?.bonus_rule_id, createdRule.value.rule_id);
  assert.equal(view?.recent.length, 1);
});
