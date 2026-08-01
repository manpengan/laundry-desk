import assert from "node:assert/strict";
import test from "node:test";

import { FakeSqlClient } from "../db/fake-client.js";
import type { TenantContext } from "../db/types.js";
import { HandlerCommandError, type ActorContext, type CommandHandler } from "../bus/types.js";
import type { OrderHandlerDeps } from "../order/handlers.js";
import type { PaymentAppendInput, PaymentAppendResult } from "../order/types.js";
import { createMemberHandlers } from "./handlers.js";
import { createMemoryMemberStore } from "./memory-store.js";

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

  return {
    handlers: createMemberHandlers({
      persistence: "memory",
      store: createMemoryMemberStore({ customerIds: [CUSTOMER_ID] }),
      order,
    }),
    recorded,
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
