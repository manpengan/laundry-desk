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

function deferred() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

class FinancialBarrierClient extends FakeSqlClient {
  readonly reached = deferred();
  readonly resume = deferred();
  constructor(
    private readonly stage: "audit" | "commit",
    private readonly fail = true,
  ) {
    super();
  }
  override async query<TRow = unknown>(sql: string, params?: readonly unknown[]) {
    if (
      (this.stage === "audit" && sql.includes("INSERT INTO audit_log")) ||
      (this.stage === "commit" && sql === "COMMIT")
    ) {
      this.reached.release();
      await this.resume.promise;
      if (this.fail) throw new Error(`Injected ${this.stage} failure`);
    }
    return super.query<TRow>(sql, params);
  }
}

async function fixture() {
  const tenant = { orgId: randomUUID(), storeId: randomUUID(), staffId: randomUUID() };
  const customerId = randomUUID();
  const order = createMemoryOrderStore();
  const member = createMemoryMemberStore({ customerIds: [customerId] });
  const orders = await Promise.all(
    Array.from({ length: 3 }, () => seedCancellationOrder(order, tenant, customerId)),
  );
  const handlers = cancellationHandlers(order, { persistence: "memory", store: member });
  const run = (
    name: string,
    input: Readonly<Record<string, unknown>>,
    client = new FakeSqlClient(),
  ) => runCancellationHandler(client, tenant, handlers, name, input);
  const opened = await member.openAccount({
    customer_id: customerId,
    store_id: tenant.storeId,
    at: CANCEL_AT,
  });
  assert.ok(opened.ok);
  const accountId = opened.value.account.account_id;
  await run("member.topup", { account_id: accountId, amount_cents: 10000, method: "cash" });
  const pay = (index: number, client?: FakeSqlClient) =>
    run(
      "member.balance.pay",
      { account_id: accountId, order_id: orders[index], amount_cents: 4200 },
      client,
    );
  await pay(0);
  const view = () => member.getById(accountId, 50);
  return { tenant, customerId, accountId, order, orders, member, run, pay, view };
}

for (const stage of ["audit", "commit"] as const) {
  test(`uncommitted cancellation credit cannot be spent before ${stage} failure`, async () => {
    const f = await fixture();
    const barrier = new FinancialBarrierClient(stage);
    const cancellation = f.run(
      "order.cancel",
      { order_id: f.orders[0], reason: "回滚隔离测试" },
      barrier,
    );
    const failed = assert.rejects(cancellation, new RegExp(`Injected ${stage} failure`, "u"));
    await barrier.reached.promise;
    try {
      assert.equal(
        (await f.view())?.balance.total_cents,
        5800,
        "other transactions see only committed funds",
      );
      await f.pay(1);
      await assert.rejects(
        () => f.pay(2),
        "a second 4200 spend must not see staged cancellation funds",
      );
    } finally {
      barrier.resume.release();
    }
    await failed;
    assert.equal((await f.view())?.balance.total_cents, 1600);
    assert.equal((await f.view())?.recent.filter((row) => row.kind === "reversal").length, 0);
    assert.equal(
      (await f.order.getOrder(f.tenant.orgId, f.tenant.storeId, f.orders[0]!))?.status,
      "open",
    );
    assert.equal(
      (await f.order.listPayments(f.tenant.orgId, f.tenant.storeId, f.orders[0]!)).length,
      1,
    );
  });
}

test("concurrent close wins over staged cancellation without leaving a closed account with money", async () => {
  const f = await fixture();
  const barrier = new FinancialBarrierClient("audit", false);
  const cancellation = f.run(
    "order.cancel",
    { order_id: f.orders[0], reason: "关闭账户竞态" },
    barrier,
  );
  const failed = assert.rejects(
    cancellation,
    /Concurrent memory transaction changed staged state/u,
  );
  await barrier.reached.promise;
  try {
    await f.run("member.account.close", {
      account_id: f.accountId,
      expected_customer_id: f.customerId,
      expected_status_version: 1,
      expected_status: "active",
      expected_principal_cents: 5800,
      expected_bonus_cents: 0,
      refund_tender: "cash",
      reason: "退卡",
    });
  } finally {
    barrier.resume.release();
  }
  await failed;
  assert.equal((await f.view())?.account.status, "closed");
  assert.equal((await f.view())?.balance.total_cents, 0);
  assert.equal(
    (await f.order.getOrder(f.tenant.orgId, f.tenant.storeId, f.orders[0]!))?.status,
    "open",
  );
});

test("a payment cannot commit after its account was frozen during the audit wait", async () => {
  const f = await fixture();
  const barrier = new FinancialBarrierClient("audit", false);
  const payment = f.pay(1, barrier);
  const failed = assert.rejects(payment, /Concurrent memory transaction changed staged state/u);
  await barrier.reached.promise;
  try {
    const frozen = await f.member.transitionStatus({
      account_id: f.accountId,
      expected_customer_id: f.customerId,
      expected_status_version: 1,
      store_id: f.tenant.storeId,
      staff_id: f.tenant.staffId,
      at: CANCEL_AT,
      reason: "挂失",
      action: "freeze",
    });
    assert.ok(frozen.ok);
  } finally {
    barrier.resume.release();
  }
  await failed;
  assert.equal((await f.view())?.account.status, "frozen");
  assert.equal((await f.view())?.balance.total_cents, 5800);
  assert.equal(
    (await f.order.listPayments(f.tenant.orgId, f.tenant.storeId, f.orders[1]!)).length,
    0,
  );
});

test("failed lifecycle settlement leaves status and existing ledger rows untouched", async () => {
  const f = await fixture();
  const barrier = new FinancialBarrierClient("commit");
  const close = f.run(
    "member.account.close",
    {
      account_id: f.accountId,
      expected_customer_id: f.customerId,
      expected_status_version: 1,
      expected_status: "active",
      expected_principal_cents: 5800,
      expected_bonus_cents: 0,
      refund_tender: "cash",
      reason: "退卡",
    },
    barrier,
  );
  const failed = assert.rejects(close, /Injected commit failure/u);
  await barrier.reached.promise;
  try {
    assert.equal((await f.view())?.account.status, "active");
    assert.equal((await f.view())?.balance.total_cents, 5800);
  } finally {
    barrier.resume.release();
  }
  await failed;
  assert.equal((await f.view())?.account.status, "active");
  assert.equal((await f.view())?.balance.total_cents, 5800);
  assert.equal(await f.member.sumCashPrincipal(f.tenant.storeId, CANCEL_DAY), 10000);
});
