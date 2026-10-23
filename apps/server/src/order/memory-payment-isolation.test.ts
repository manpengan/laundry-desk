import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { FakeSqlClient } from "../db/fake-client.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import { createMemoryMemberStore } from "../member/memory-store.js";
import {
  CANCEL_AT,
  cancellationHandlers,
  runCancellationHandler,
  seedCancellationOrder,
} from "../member/order-cancellation-test-support.js";
import { createMemoryOrderStore } from "./memory-store.js";

function deferred() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

class PaymentBarrierClient extends FakeSqlClient {
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
  const orderId = await seedCancellationOrder(order, tenant, customerId, "ready");
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
  const pay = (method: "balance" | "cash", amountCents: number, client?: FakeSqlClient) =>
    method === "balance"
      ? run(
          "member.balance.pay",
          { account_id: accountId, order_id: orderId, amount_cents: amountCents },
          client,
        )
      : run("payment.collect", { order_id: orderId, amount_cents: amountCents, method }, client);
  const view = async () => {
    const row = await order.getOrder(tenant.orgId, tenant.storeId, orderId);
    assert.ok(row);
    return row;
  };
  const payments = () => order.listPayments(tenant.orgId, tenant.storeId, orderId);
  const garments = () => order.listGarments(tenant.orgId, tenant.storeId, orderId);
  const balance = async () => (await member.getById(accountId, 50))?.balance.total_cents;
  const pickup = (collectCents: number, client?: FakeSqlClient) =>
    run(
      "order.pickup",
      {
        order_id: orderId,
        collect_cents: collectCents,
        garment_ids: [],
        verification_barcodes: [],
      },
      client,
    );
  return {
    tenant,
    customerId,
    orderId,
    order,
    member,
    run,
    pay,
    view,
    payments,
    garments,
    balance,
    pickup,
  };
}

for (const method of ["balance", "cash"] as const) {
  for (const stage of ["audit", "commit"] as const) {
    test(`${method} payment stays invisible until commit and ${stage} failure preserves concurrent cash`, async () => {
      const f = await fixture();
      const barrier = new PaymentBarrierClient(stage);
      const failed = assert.rejects(
        f.pay(method, 1000, barrier),
        new RegExp(`Injected ${stage} failure`, "u"),
      );
      await barrier.reached.promise;
      try {
        assert.equal((await f.view()).paid_cents, 0);
        assert.equal(
          (await f.order.listOrders(f.tenant.orgId, f.tenant.storeId))[0]?.paid_cents,
          0,
        );
        assert.equal((await f.payments()).length, 0);
        assert.equal(await f.balance(), 10000);
        await f.pay("cash", 1000);
      } finally {
        barrier.resume.release();
      }
      await failed;
      assert.equal((await f.view()).paid_cents, 1000);
      assert.equal((await f.view()).balance_cents, 3200);
      assert.deepEqual(
        (await f.payments()).map((row) => [row.method, row.amount_cents]),
        [["cash", 1000]],
      );
      assert.equal(await f.balance(), 10000);
      await f.pay("balance", 500);
      assert.equal((await f.view()).paid_cents, 1500);
      assert.equal(await f.balance(), 9500);
      await f.run("order.cancel", { order_id: f.orderId, reason: "失败后继续撤单" });
      assert.equal((await f.view()).status, "cancelled");
      assert.equal((await f.view()).paid_cents, 0);
      assert.equal(await f.balance(), 10000);
      assert.equal((await f.payments()).filter((row) => row.kind === "reversal").length, 2);
    });
  }
}

test("a concurrent cash payment invalidates the entire pending wallet transaction", async () => {
  const f = await fixture();
  const barrier = new PaymentBarrierClient("audit", false);
  const failed = assert.rejects(
    f.pay("balance", 1000, barrier),
    /Concurrent memory transaction changed staged state/u,
  );
  await barrier.reached.promise;
  try {
    await f.pay("cash", 1000);
  } finally {
    barrier.resume.release();
  }
  await failed;
  assert.equal((await f.view()).paid_cents, 1000);
  assert.equal((await f.view()).balance_cents, 3200);
  assert.equal((await f.payments()).length, 1);
  assert.equal(await f.balance(), 10000);
});

test("a cash refund cannot project an uncommitted wallet payment into the order", async () => {
  const f = await fixture();
  await f.pay("cash", 1000);
  const original = (await f.payments())[0]!;
  const barrier = new PaymentBarrierClient("audit");
  const failed = assert.rejects(f.pay("balance", 1000, barrier), /Injected audit failure/u);
  await barrier.reached.promise;
  try {
    await f.run("payment.refund", {
      order_id: f.orderId,
      amount_cents: 500,
      method: "cash",
      ref_payment_id: original.payment_id,
      reason: "部分退款",
    });
  } finally {
    barrier.resume.release();
  }
  await failed;
  assert.equal((await f.view()).paid_cents, 500);
  assert.equal((await f.view()).balance_cents, 3700);
  assert.deepEqual(
    (await f.payments()).map((row) => row.kind),
    ["pay", "refund"],
  );
  assert.equal(await f.balance(), 10000);
});

test("pickup cannot close an order using an uncommitted full wallet payment", async () => {
  const f = await fixture();
  const barrier = new PaymentBarrierClient("audit");
  const failed = assert.rejects(f.pay("balance", 4200, barrier), /Injected audit failure/u);
  await barrier.reached.promise;
  try {
    await f.pickup(0);
    assert.equal((await f.view()).status, "open");
    assert.equal((await f.view()).balance_cents, 4200);
  } finally {
    barrier.resume.release();
  }
  await failed;
  assert.equal((await f.view()).paid_cents, 0);
  assert.equal((await f.payments()).length, 0);
  assert.equal((await f.garments())[0]?.status, "picked_up");
  await f.pay("cash", 4200);
  assert.equal((await f.view()).status, "closed");
});

for (const stage of ["audit", "commit"] as const) {
  test(`pickup garments and payment remain invisible before ${stage} failure`, async () => {
    const f = await fixture();
    const barrier = new PaymentBarrierClient(stage);
    const failed = assert.rejects(
      f.pickup(4200, barrier),
      new RegExp(`Injected ${stage} failure`, "u"),
    );
    await barrier.reached.promise;
    try {
      assert.equal((await f.view()).status, "open");
      assert.equal((await f.view()).paid_cents, 0);
      assert.equal((await f.garments())[0]?.status, "ready");
      assert.equal((await f.payments()).length, 0);
      await f.run("order.cancel", { order_id: f.orderId, reason: "撤销未取订单" });
    } finally {
      barrier.resume.release();
    }
    await failed;
    assert.equal((await f.view()).status, "cancelled");
    assert.equal((await f.garments())[0]?.status, "ready");
    assert.equal((await f.payments()).length, 0);
  });
}

test("a coupon sees committed payment history and invalidates a concurrent wallet snapshot", async () => {
  const f = await fixture();
  const barrier = new PaymentBarrierClient("audit", false);
  const failed = assert.rejects(
    f.pay("balance", 1000, barrier),
    /Concurrent memory transaction changed staged state/u,
  );
  await barrier.reached.promise;
  try {
    const applied = await withTenantTransaction(new FakeSqlClient(), f.tenant, () =>
      f.order.applyFixedCouponDiscount({
        org_id: f.tenant.orgId,
        store_id: f.tenant.storeId,
        order_id: f.orderId,
        customer_id: f.customerId,
        discount_cents: 500,
        min_order_cents: 0,
        at: CANCEL_AT,
      }),
    );
    assert.ok(applied);
  } finally {
    barrier.resume.release();
  }
  await failed;
  assert.equal((await f.view()).discount_cents, 500);
  assert.equal((await f.view()).payable_cents, 3700);
  assert.equal((await f.view()).balance_cents, 3700);
  assert.equal((await f.view()).paid_cents, 0);
  assert.equal((await f.payments()).length, 0);
  assert.equal(await f.balance(), 10000);
  await f.pay("balance", 3700);
  assert.equal((await f.view()).balance_cents, 0);
  assert.equal(await f.balance(), 6300);
});
