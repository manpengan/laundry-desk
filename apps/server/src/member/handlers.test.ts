import assert from "node:assert/strict";
import test from "node:test";

import { FakeSqlClient } from "../db/fake-client.js";
import type { TenantContext } from "../db/types.js";
import { HandlerCommandError, type ActorContext, type CommandHandler } from "../bus/types.js";
import type { OrderHandlerDeps } from "../order/handlers.js";
import type { PaymentAppendInput, PaymentAppendResult } from "../order/types.js";
import { createMemberHandlers } from "./handlers.js";
import { createMemoryMemberStore } from "./memory-store.js";
import type { MemberStore } from "./types.js";

const ORG_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STORE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const STAFF_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CUSTOMER_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ORDER_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const TENANT: TenantContext = Object.freeze({
  orgId: ORG_ID,
  storeId: STORE_ID,
  staffId: STAFF_ID,
});

function actor(permissions: readonly string[]): ActorContext {
  return Object.freeze({
    staffId: STAFF_ID,
    deviceId: null,
    via: "ui" as const,
    permissions: Object.freeze([...permissions]),
  });
}

type Recorded = { calls: PaymentAppendInput[] };

function makeDeps(options: { paymentFails?: boolean } = {}): {
  handlers: ReturnType<typeof createMemberHandlers>;
  recorded: Recorded;
  store: MemberStore;
} {
  const recorded: Recorded = { calls: [] };
  const appendPayment = async (input: PaymentAppendInput): Promise<PaymentAppendResult | null> => {
    recorded.calls.push(input);
    if (options.paymentFails === true) return null;
    return Object.freeze({
      order: Object.freeze({
        order_id: input.order_id,
        paid_cents: input.amount_cents,
        balance_cents: 0,
        status: "paid",
      }),
      payment: Object.freeze({
        payment_id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        method: input.method,
        amount_cents: input.amount_cents,
        kind: input.kind,
      }),
    }) as unknown as PaymentAppendResult;
  };

  const order = Object.freeze({
    store: Object.freeze({ appendPayment }),
    timeZone: "UTC",
    rolloverHour: 0,
    now: () => 1_780_000_000,
  }) as unknown as OrderHandlerDeps;

  const store = createMemoryMemberStore({ customerIds: [CUSTOMER_ID] });
  return {
    handlers: createMemberHandlers({
      persistence: "memory",
      store,
      order,
    }),
    recorded,
    store,
  };
}

async function run(
  handler: CommandHandler,
  parsed: Readonly<Record<string, unknown>>,
  permissions: readonly string[],
): Promise<Awaited<ReturnType<CommandHandler>>> {
  return handler(
    Object.freeze({
      client: new FakeSqlClient(),
      tenant: TENANT,
      actor: actor(permissions),
      parsed,
    }) as unknown as Parameters<CommandHandler>[0],
  );
}

const asRecord = (value: unknown): Readonly<Record<string, unknown>> =>
  value as Readonly<Record<string, unknown>>;

/** Assert on the envelope code, not the message: the message is human text. */
const hasCode =
  (code: string) =>
  (error: unknown): boolean => {
    assert.ok(error instanceof HandlerCommandError);
    assert.equal(error.commandError.code, code);
    return true;
  };

test("account.open refuses a caller without customer_write", async () => {
  const { handlers } = makeDeps();

  await assert.rejects(
    () => run(handlers["member.account.open"], { customer_id: CUSTOMER_ID }, ["order_write"]),
    hasCode("PERMISSION_DENIED"),
  );
});

test("balance.pay refuses a caller without order_write", async () => {
  const { handlers } = makeDeps();

  await assert.rejects(
    () =>
      run(
        handlers["member.balance.pay"],
        { account_id: ORDER_ID, order_id: ORDER_ID, amount_cents: 100 },
        ["customer_write"],
      ),
    hasCode("PERMISSION_DENIED"),
  );
});

test("topup then balance.pay debits the ledger and settles the order once", async () => {
  const { handlers, recorded } = makeDeps();

  const opened = await run(handlers["member.account.open"], { customer_id: CUSTOMER_ID }, [
    "customer_write",
  ]);
  const accountId = asRecord(opened.result).account_id as string;

  await run(
    handlers["member.topup"],
    { account_id: accountId, amount_cents: 10_000, method: "cash" },
    ["customer_write"],
  );

  const paid = await run(
    handlers["member.balance.pay"],
    { account_id: accountId, order_id: ORDER_ID, amount_cents: 4_200 },
    ["order_write"],
  );

  const result = asRecord(paid.result);
  assert.equal(result.balance_cents, 5_800);
  assert.equal(result.order_id, ORDER_ID);
  // Exactly one order-side payment, and it is tendered as `balance`.
  assert.equal(recorded.calls.length, 1);
  assert.equal(recorded.calls[0]?.method, "balance");
  assert.equal(recorded.calls[0]?.amount_cents, 4_200);
  assert.equal(recorded.calls[0]?.kind, "pay");
});

test("an overdraw is refused before the order side is touched", async () => {
  const { handlers, recorded } = makeDeps();
  const opened = await run(handlers["member.account.open"], { customer_id: CUSTOMER_ID }, [
    "customer_write",
  ]);
  const accountId = asRecord(opened.result).account_id as string;
  await run(
    handlers["member.topup"],
    { account_id: accountId, amount_cents: 1_000, method: "cash" },
    ["customer_write"],
  );

  await assert.rejects(
    () =>
      run(
        handlers["member.balance.pay"],
        { account_id: accountId, order_id: ORDER_ID, amount_cents: 1_001 },
        ["order_write"],
      ),
    hasCode("INVARIANT_FAILED"),
  );

  // The order must never see a payment for money the member did not have.
  assert.equal(recorded.calls.length, 0);
});

test("an order-side rejection surfaces instead of silently keeping the debit", async () => {
  const { handlers, recorded } = makeDeps({ paymentFails: true });
  const opened = await run(handlers["member.account.open"], { customer_id: CUSTOMER_ID }, [
    "customer_write",
  ]);
  const accountId = asRecord(opened.result).account_id as string;
  await run(
    handlers["member.topup"],
    { account_id: accountId, amount_cents: 10_000, method: "cash" },
    ["customer_write"],
  );

  // The debit and the order payment share one transaction, so the thrown error
  // is what rolls the ledger row back. Swallowing it would strand the money.
  await assert.rejects(
    () =>
      run(
        handlers["member.balance.pay"],
        { account_id: accountId, order_id: ORDER_ID, amount_cents: 100 },
        ["order_write"],
      ),
    hasCode("VALIDATION_FAILED"),
  );
  assert.equal(recorded.calls.length, 1);
});

test("account.get reports a zero balance shape for a customer with no account", async () => {
  const { handlers } = makeDeps();

  const view = await run(handlers["member.account.get"], { customer_id: CUSTOMER_ID }, [
    "customer_read",
  ]);

  assert.deepEqual(asRecord(view.result).account, null);
});

test("account.get exposes the balance split and the ledger it summed", async () => {
  const { handlers } = makeDeps();
  const opened = await run(handlers["member.account.open"], { customer_id: CUSTOMER_ID }, [
    "customer_write",
  ]);
  const accountId = asRecord(opened.result).account_id as string;
  await run(
    handlers["member.topup"],
    { account_id: accountId, amount_cents: 7_500, method: "wechat" },
    ["customer_write"],
  );

  const view = await run(handlers["member.account.get"], { customer_id: CUSTOMER_ID }, [
    "customer_read",
  ]);

  const account = asRecord(asRecord(view.result).account);
  assert.equal(account.balance_cents, 7_500);
  assert.equal(account.principal_cents, 7_500);
  assert.equal(account.bonus_cents, 0);
  const recent = asRecord(view.result).recent as readonly Readonly<Record<string, unknown>>[];
  assert.equal(recent.length, 1);
  assert.equal(recent[0]?.kind, "topup");
});

test("bonus_rule.upsert refuses a caller without member_rule_write (ADR-22 §2.3)", async () => {
  const { handlers } = makeDeps();

  // Deliberately holding every other write permission: changing how much money
  // the shop gives away must not ride along with pricing or customer rights.
  await assert.rejects(
    () =>
      run(
        handlers["member.bonus_rule.upsert"],
        { min_topup_cents: 100_000, bonus_cents: 10_000, status: "active" },
        ["customer_write", "order_write", "catalog_write", "settings_admin"],
      ),
    hasCode("PERMISSION_DENIED"),
  );
});

test("bonus_rule.upsert creates a tier and a later top-up grants it", async () => {
  const { handlers } = makeDeps();

  const created = await run(
    handlers["member.bonus_rule.upsert"],
    { min_topup_cents: 100_000, bonus_cents: 10_000, status: "active" },
    ["member_rule_write"],
  );
  const rule = created.result as { rule_id: string; bonus_cents: number };
  assert.equal(rule.bonus_cents, 10_000);
  assert.equal(created.audit?.entity, "member_bonus_rules");

  const opened = await run(handlers["member.account.open"], { customer_id: CUSTOMER_ID }, [
    "customer_write",
  ]);
  const account = opened.result as { account_id: string };
  const topped = await run(
    handlers["member.topup"],
    { account_id: account.account_id, amount_cents: 100_000, method: "cash" },
    ["customer_write"],
  );

  const balance = topped.result as { principal_cents: number; bonus_cents: number };
  assert.equal(balance.principal_cents, 100_000);
  assert.equal(balance.bonus_cents, 10_000);
});

test("topup ignores a client-supplied bonus: the schema has no such field", async () => {
  const { handlers } = makeDeps();
  await run(
    handlers["member.bonus_rule.upsert"],
    { min_topup_cents: 100_000, bonus_cents: 10_000, status: "active" },
    ["member_rule_write"],
  );
  const opened = await run(handlers["member.account.open"], { customer_id: CUSTOMER_ID }, [
    "customer_write",
  ]);
  const account = opened.result as { account_id: string };

  const topped = await run(
    handlers["member.topup"],
    {
      account_id: account.account_id,
      amount_cents: 100_000,
      method: "cash",
      // A clerk cannot pair any top-up with any grant (ADR-22 §3.1).
      bonus_cents: 999_999,
    },
    ["customer_write"],
  );

  const balance = topped.result as { bonus_cents: number };
  assert.equal(balance.bonus_cents, 10_000);
});

test("bonus_rules.list hides retired tiers unless asked", async () => {
  const { handlers } = makeDeps();
  const created = await run(
    handlers["member.bonus_rule.upsert"],
    { min_topup_cents: 100_000, bonus_cents: 10_000, status: "active" },
    ["member_rule_write"],
  );
  const rule = created.result as { rule_id: string };
  await run(
    handlers["member.bonus_rule.upsert"],
    {
      rule_id: rule.rule_id,
      min_topup_cents: 100_000,
      bonus_cents: 10_000,
      status: "retired",
    },
    ["member_rule_write"],
  );

  const visible = await run(handlers["member.bonus_rules.list"], {}, ["customer_read"]);
  assert.deepEqual((visible.result as { rules: readonly unknown[] }).rules, []);

  const all = await run(handlers["member.bonus_rules.list"], { include_retired: true }, [
    "customer_read",
  ]);
  assert.equal((all.result as { rules: readonly unknown[] }).rules.length, 1);
});

test("bonus_rule.upsert refuses an unknown rule id instead of creating a second tier", async () => {
  const { handlers } = makeDeps();

  await assert.rejects(
    () =>
      run(
        handlers["member.bonus_rule.upsert"],
        {
          rule_id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
          min_topup_cents: 100_000,
          bonus_cents: 10_000,
          status: "active",
        },
        ["member_rule_write"],
      ),
    hasCode("VALIDATION_FAILED"),
  );
});

test("refund refuses a caller without member_refund (ADR-22 §5.1)", async () => {
  const { handlers } = makeDeps();

  // payment_refund returns an order payment; this returns prepaid money the
  // shop is holding. Holding one must not grant the other.
  await assert.rejects(
    () =>
      run(
        handlers["member.refund"],
        { account_id: ORDER_ID, amount_cents: 1_000, tender: "cash", reason: "退卡" },
        ["payment_refund", "order_write", "customer_write", "member_rule_write"],
      ),
    hasCode("PERMISSION_DENIED"),
  );
});

test("refund returns principal, never the bonus, and reports the new balance", async () => {
  const { handlers } = makeDeps();
  await run(
    handlers["member.bonus_rule.upsert"],
    { min_topup_cents: 100_000, bonus_cents: 10_000, status: "active" },
    ["member_rule_write"],
  );
  const opened = await run(handlers["member.account.open"], { customer_id: CUSTOMER_ID }, [
    "customer_write",
  ]);
  const account = opened.result as { account_id: string };
  await run(
    handlers["member.topup"],
    { account_id: account.account_id, amount_cents: 100_000, method: "cash" },
    ["customer_write"],
  );

  const refunded = await run(
    handlers["member.refund"],
    {
      account_id: account.account_id,
      amount_cents: 100_000,
      tender: "cash",
      reason: "顾客退卡",
    },
    ["member_refund"],
  );

  const body = refunded.result as { principal_cents: number; bonus_cents: number };
  assert.equal(body.principal_cents, 0);
  assert.equal(body.bonus_cents, 10_000);
  assert.equal(refunded.audit?.entity, "member_ledger");
});

test("refund refuses to reach past the principal into the bonus", async () => {
  const { handlers } = makeDeps();
  await run(
    handlers["member.bonus_rule.upsert"],
    { min_topup_cents: 100_000, bonus_cents: 10_000, status: "active" },
    ["member_rule_write"],
  );
  const opened = await run(handlers["member.account.open"], { customer_id: CUSTOMER_ID }, [
    "customer_write",
  ]);
  const account = opened.result as { account_id: string };
  await run(
    handlers["member.topup"],
    { account_id: account.account_id, amount_cents: 100_000, method: "cash" },
    ["customer_write"],
  );

  // Total balance is 110_000; only 100_000 of it is the customer's own money.
  await assert.rejects(
    () =>
      run(
        handlers["member.refund"],
        {
          account_id: account.account_id,
          amount_cents: 110_000,
          tender: "cash",
          reason: "顾客退卡",
        },
        ["member_refund"],
      ),
    hasCode("INVARIANT_FAILED"),
  );
});

test("refund refuses a blank reason", async () => {
  const { handlers } = makeDeps();
  const opened = await run(handlers["member.account.open"], { customer_id: CUSTOMER_ID }, [
    "customer_write",
  ]);
  const account = opened.result as { account_id: string };

  await assert.rejects(
    () =>
      run(
        handlers["member.refund"],
        { account_id: account.account_id, amount_cents: 100, tender: "cash", reason: "   " },
        ["member_refund"],
      ),
    hasCode("VALIDATION_FAILED"),
  );
});

test("lifecycle handlers enforce dedicated permissions and frozen blocks ordinary refund", async () => {
  const { handlers } = makeDeps();
  const opened = await run(handlers["member.account.open"], { customer_id: CUSTOMER_ID }, [
    "customer_write",
  ]);
  const accountId = String(asRecord(opened.result).account_id);

  await assert.rejects(
    () =>
      run(
        handlers["member.account.freeze"],
        {
          account_id: accountId,
          expected_customer_id: CUSTOMER_ID,
          expected_status_version: 1,
          reason: "reported lost",
        },
        ["customer_write"],
      ),
    hasCode("PERMISSION_DENIED"),
  );
  const frozen = await run(
    handlers["member.account.freeze"],
    {
      account_id: accountId,
      expected_customer_id: CUSTOMER_ID,
      expected_status_version: 1,
      reason: "reported lost",
    },
    ["member_freeze"],
  );
  assert.deepEqual(asRecord(frozen.result), {
    account_id: accountId,
    customer_id: CUSTOMER_ID,
    status: "frozen",
    status_version: 2,
    status_changed_at: 1_780_000_000,
  });
  assert.deepEqual(JSON.parse(frozen.audit?.beforeJson ?? "null"), {
    customer_id: CUSTOMER_ID,
    status: "active",
    status_version: 1,
  });

  await assert.rejects(
    () =>
      run(
        handlers["member.refund"],
        {
          account_id: accountId,
          amount_cents: 1,
          tender: "cash",
          reason: "ordinary refund",
        },
        ["member_refund"],
      ),
    hasCode("INVARIANT_FAILED"),
  );
  await assert.rejects(
    () =>
      run(
        handlers["member.account.unfreeze"],
        {
          account_id: accountId,
          expected_customer_id: CUSTOMER_ID,
          expected_status_version: 2,
          reason: "verified",
        },
        ["member_freeze"],
      ),
    hasCode("PERMISSION_DENIED"),
  );
});

test("close requires both permissions and returns an exact settled account projection", async () => {
  const { handlers, store } = makeDeps();
  const rule = await store.upsertBonusRule({
    rule_id: null,
    min_topup_cents: 1_000,
    bonus_cents: 100,
    status: "active",
    staff_id: STAFF_ID,
    at: 1_779_999_999,
    note: null,
  });
  assert.equal(rule.ok, true);
  const opened = await run(handlers["member.account.open"], { customer_id: CUSTOMER_ID }, [
    "customer_write",
  ]);
  const accountId = String(asRecord(opened.result).account_id);
  await run(
    handlers["member.topup"],
    { account_id: accountId, amount_cents: 1_000, method: "cash" },
    ["customer_write"],
  );

  const closeInput = {
    account_id: accountId,
    expected_customer_id: CUSTOMER_ID,
    expected_status_version: 1,
    expected_status: "active",
    expected_principal_cents: 1_000,
    expected_bonus_cents: 100,
    refund_tender: "cash",
    reason: "customer requested closure",
  } as const;
  await assert.rejects(
    () => run(handlers["member.account.close"], closeInput, ["member_lifecycle_manage"]),
    hasCode("PERMISSION_DENIED"),
  );
  const closed = await run(handlers["member.account.close"], closeInput, [
    "member_lifecycle_manage",
    "member_refund",
  ]);
  const closeResult = asRecord(closed.result);
  assert.deepEqual(closeResult, {
    account_id: accountId,
    customer_id: CUSTOMER_ID,
    status: "closed",
    status_version: 2,
    refunded_principal_cents: 1_000,
    forfeited_bonus_cents: 100,
    refund_ledger_id: closeResult.refund_ledger_id,
    bonus_forfeit_ledger_id: closeResult.bonus_forfeit_ledger_id,
    principal_cents: 0,
    bonus_cents: 0,
    balance_cents: 0,
  });
  assert.equal(typeof closeResult.refund_ledger_id, "string");
  assert.equal(typeof closeResult.bonus_forfeit_ledger_id, "string");
  assert.deepEqual(
    closed.events?.map((event) => event.type),
    ["member.account_closed", "member.principal_refunded", "member.bonus_forfeited"],
  );

  const view = await run(handlers["member.account.get"], { customer_id: CUSTOMER_ID }, [
    "customer_read",
  ]);
  const projected = asRecord(view.result);
  const account = asRecord(projected.account);
  assert.deepEqual(Object.keys(account).sort(), [
    "account_id",
    "balance_cents",
    "bonus_cents",
    "customer_id",
    "principal_cents",
    "status",
    "status_changed_at",
    "status_reason",
    "status_version",
  ]);
  assert.equal(account.status, "closed");
  assert.equal(account.status_reason, "customer requested closure");
  const recent = projected.recent as readonly unknown[];
  assert.deepEqual(Object.keys(asRecord(recent[0])).sort(), [
    "at",
    "bonus_delta_cents",
    "bonus_rule_id",
    "business_date",
    "kind",
    "ledger_id",
    "note",
    "order_id",
    "principal_delta_cents",
    "store_id",
    "tender",
  ]);
});

test("lifecycle handlers reject blank reasons before changing the account", async () => {
  const { handlers, store } = makeDeps();
  const opened = await run(handlers["member.account.open"], { customer_id: CUSTOMER_ID }, [
    "customer_write",
  ]);
  const accountId = String(asRecord(opened.result).account_id);

  await assert.rejects(
    () =>
      run(
        handlers["member.account.freeze"],
        {
          account_id: accountId,
          expected_customer_id: CUSTOMER_ID,
          expected_status_version: 1,
          reason: "   ",
        },
        ["member_freeze"],
      ),
    hasCode("VALIDATION_FAILED"),
  );
  await assert.rejects(
    () =>
      run(
        handlers["member.account.close"],
        {
          account_id: accountId,
          expected_customer_id: CUSTOMER_ID,
          expected_status_version: 1,
          expected_status: "active",
          expected_principal_cents: 0,
          expected_bonus_cents: 0,
          refund_tender: null,
          reason: "",
        },
        ["member_lifecycle_manage", "member_refund"],
      ),
    hasCode("VALIDATION_FAILED"),
  );
  assert.equal((await store.getByCustomer(CUSTOMER_ID, 10))?.account.status, "active");
});

test("zero-balance close emits no refund or forfeiture event", async () => {
  const { handlers } = makeDeps();
  const opened = await run(handlers["member.account.open"], { customer_id: CUSTOMER_ID }, [
    "customer_write",
  ]);
  const accountId = String(asRecord(opened.result).account_id);
  const closed = await run(
    handlers["member.account.close"],
    {
      account_id: accountId,
      expected_customer_id: CUSTOMER_ID,
      expected_status_version: 1,
      expected_status: "active",
      expected_principal_cents: 0,
      expected_bonus_cents: 0,
      refund_tender: null,
      reason: "empty account",
    },
    ["member_lifecycle_manage", "member_refund"],
  );

  assert.deepEqual(
    closed.events?.map((event) => event.type),
    ["member.account_closed"],
  );
});
