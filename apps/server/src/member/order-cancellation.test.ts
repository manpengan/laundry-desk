import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { FakeSqlClient } from "../db/fake-client.js";
import { createMemoryOrderStore } from "../order/memory-store.js";
import { createMemoryMemberStore } from "./memory-store.js";
import {
  CANCEL_AT,
  CANCEL_DAY,
  cancellationHandlers,
  runCancellationHandler,
  seedCancellationOrder,
} from "./order-cancellation-test-support.js";

async function fixture(bonus = 0) {
  const tenant = { orgId: randomUUID(), storeId: randomUUID(), staffId: randomUUID() };
  const customerId = randomUUID();
  const order = createMemoryOrderStore();
  const member = createMemoryMemberStore({ customerIds: [customerId] });
  const orderId = await seedCancellationOrder(order, tenant, customerId);
  const handlers = cancellationHandlers(order, { persistence: "memory", store: member });
  const run = (name: string, input: Readonly<Record<string, unknown>>, fail = false) =>
    runCancellationHandler(new FakeSqlClient(), tenant, handlers, name, input, fail);
  const opened = await member.openAccount({
    customer_id: customerId,
    store_id: tenant.storeId,
    at: CANCEL_AT,
  });
  assert.ok(opened.ok);
  const accountId = opened.value.account.account_id;
  if (bonus > 0)
    await member.upsertBonusRule({
      rule_id: null,
      min_topup_cents: 10000,
      bonus_cents: bonus,
      status: "active",
      staff_id: tenant.staffId,
      at: CANCEL_AT,
      note: null,
    });
  await run("member.topup", { account_id: accountId, amount_cents: 10000, method: "cash" });
  const pay = (amount: number, fail = false) =>
    run(
      "member.balance.pay",
      { account_id: accountId, order_id: orderId, amount_cents: amount },
      fail,
    );
  const cancel = (fail = false) =>
    run("order.cancel", { order_id: orderId, reason: "顾客撤单" }, fail);
  const view = () => member.getById(accountId, 50);
  const payments = () => order.listPayments(tenant.orgId, tenant.storeId, orderId);
  return { tenant, customerId, orderId, accountId, order, member, pay, cancel, view, payments };
}

for (const bonus of [0, 1000, 5000]) {
  test(`cancel returns the exact principal/bonus split (bonus ${bonus})`, async () => {
    const f = await fixture(bonus);
    await f.pay(4200);
    await f.cancel();
    const view = await f.view();
    assert.deepEqual(view?.balance, {
      principal_cents: 10000,
      bonus_cents: bonus,
      total_cents: 10000 + bonus,
    });
    const pay = view?.recent.find((row) => row.kind === "pay");
    const reversal = view?.recent.find((row) => row.kind === "reversal");
    assert.equal(reversal?.ref_ledger_id, pay?.ledger_id);
    assert.equal(reversal?.principal_delta_cents, -(pay?.principal_delta_cents ?? 0));
    assert.equal(reversal?.bonus_delta_cents, -(pay?.bonus_delta_cents ?? 0));
    assert.equal(reversal?.tender, null);
    assert.equal(await f.member.sumCashPrincipal(f.tenant.storeId, CANCEL_DAY), 10000);
    assert.equal((await f.payments()).filter((row) => row.kind === "reversal").length, 1);
    assert.equal(
      (await f.order.getOrder(f.tenant.orgId, f.tenant.storeId, f.orderId))?.status,
      "cancelled",
    );
    await assert.rejects(() => f.cancel());
    assert.equal((await f.view())?.recent.length, 3);
  });
}

test("mixed cash and multiple balance payments return only original stored value", async () => {
  const f = await fixture(1000);
  await f.pay(1200);
  await f.pay(1000);
  assert.ok(
    await f.order.appendPayment({
      org_id: f.tenant.orgId,
      store_id: f.tenant.storeId,
      order_id: f.orderId,
      amount_cents: 2000,
      method: "cash",
      kind: "pay",
      note: null,
      staff_id: f.tenant.staffId,
      at: CANCEL_AT,
      business_date: CANCEL_DAY,
    }),
  );
  await f.cancel();
  assert.equal((await f.view())?.balance.total_cents, 11000);
  assert.equal((await f.view())?.recent.filter((row) => row.kind === "reversal").length, 2);
  assert.equal((await f.payments()).filter((row) => row.kind === "reversal").length, 3);
});

test("frozen account receives its original funds without unfreezing", async () => {
  const f = await fixture(1000);
  await f.pay(4200);
  assert.ok(
    (
      await f.member.transitionStatus({
        account_id: f.accountId,
        action: "freeze",
        expected_customer_id: f.customerId,
        expected_status_version: 1,
        store_id: f.tenant.storeId,
        staff_id: f.tenant.staffId,
        at: CANCEL_AT,
        reason: "挂失",
      })
    ).ok,
  );
  await f.cancel();
  assert.equal((await f.view())?.account.status, "frozen");
  assert.equal((await f.view())?.balance.total_cents, 11000);
});

test("closed account refuses cancellation without creating trapped credit", async () => {
  const f = await fixture();
  await f.pay(4200);
  assert.ok(
    (
      await f.member.close({
        account_id: f.accountId,
        expected_customer_id: f.customerId,
        expected_status: "active",
        expected_status_version: 1,
        expected_principal_cents: 5800,
        expected_bonus_cents: 0,
        refund_tender: "cash",
        store_id: f.tenant.storeId,
        staff_id: f.tenant.staffId,
        at: CANCEL_AT,
        business_date: CANCEL_DAY,
        reason: "退卡",
      })
    ).ok,
  );
  await assert.rejects(() => f.cancel());
  assert.equal((await f.view())?.balance.total_cents, 0);
  assert.equal((await f.payments()).length, 1);
  assert.equal(
    (await f.order.getOrder(f.tenant.orgId, f.tenant.storeId, f.orderId))?.status,
    "open",
  );
});

test("a merged customer's same account receives its own original balance", async () => {
  const f = await fixture();
  await f.pay(4200);
  const target = randomUUID();
  assert.equal(await f.member.mergeCustomerMemberAccount(f.customerId, target), "relinked");
  await f.cancel();
  assert.equal((await f.member.getByCustomer(target, 20))?.balance.total_cents, 10000);
  assert.equal(await f.member.getByCustomer(f.customerId, 20), null);
});

test("concurrent cancellation credits once", async () => {
  const f = await fixture(1000);
  await f.pay(4200);
  const results = await Promise.allSettled([f.cancel(), f.cancel()]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal((await f.view())?.balance.total_cents, 11000);
  assert.equal((await f.payments()).length, 2);
});

test("failure after cancellation audit rolls back both ledgers and order", async () => {
  const f = await fixture(1000);
  await f.pay(4200);
  await assert.rejects(() => f.cancel(true), /Injected failure/u);
  assert.equal((await f.view())?.balance.total_cents, 6800);
  assert.equal((await f.payments()).length, 1);
  assert.equal(
    (await f.order.getOrder(f.tenant.orgId, f.tenant.storeId, f.orderId))?.status,
    "open",
  );
  await f.cancel();
  assert.equal((await f.view())?.balance.total_cents, 11000);
});

test("failure after balance-payment audit rolls back debit, payment and linkage", async () => {
  const f = await fixture();
  await assert.rejects(() => f.pay(4200, true), /Injected failure/u);
  assert.equal((await f.view())?.balance.total_cents, 10000);
  assert.equal((await f.payments()).length, 0);
  await f.pay(4200);
  await f.cancel();
  assert.equal((await f.view())?.balance.total_cents, 10000);
});
