import assert from "node:assert/strict";
import test from "node:test";

import { buildPayPayment } from "@laundry/domain";

import { FakeSqlClient } from "../db/fake-client.js";
import { withPoolClient } from "../db/pg-sql-client.js";
import { createPgPool, resolvePgUrls, type PgPool } from "../db/pg-pool.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import { createDefaultChainHooks } from "../handlers/default-chain-hooks.js";
import { createRegisteredM1Bus } from "../handlers/register-m1.js";
import { seedDemoIdentity } from "../local/pg-seed.js";
import { DEMO_ORG_ID, DEMO_STAFF_A_ID, DEMO_STORE_ID } from "../local/demo-ids.js";
import { createPgOrderStore } from "../order/pg-order-store.js";
import { executeCommand } from "../bus/executor.js";
import type { ActorContext } from "../bus/types.js";
import { createPgPaymentStore, orderPaymentLedger } from "./pg-payment-store.js";

const ORDER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PAYMENT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const TENANT = Object.freeze({
  orgId: DEMO_ORG_ID,
  storeId: DEMO_STORE_ID,
  staffId: DEMO_STAFF_A_ID,
});

const urls =
  process.env.LAUNDRY_USE_LOCAL_PG === "1" || process.env.LAUNDRY_USE_LOCAL_PG === "true"
    ? resolvePgUrls(process.env)
    : null;
const maybe = urls === null ? test.skip : test;

const ACTOR: ActorContext = Object.freeze({
  staffId: DEMO_STAFF_A_ID,
  deviceId: null,
  via: "ui",
  permissions: Object.freeze(["order_write", "payment_refund"]),
});

test("PG payment repository reuses the Bus transaction for append-only ledger writes", async () => {
  const client = new FakeSqlClient();
  let poolConnects = 0;
  const pool = {
    connect: async () => {
      poolConnects += 1;
      throw new Error("must not open a nested connection");
    },
  } as unknown as PgPool;
  const store = createPgPaymentStore(pool);
  const payment = buildPayPayment({
    payment_id: PAYMENT_ID,
    org_id: DEMO_ORG_ID,
    store_id: DEMO_STORE_ID,
    order_id: ORDER_ID,
    amount_cents: 500,
    staff_id: DEMO_STAFF_A_ID,
    at: 1_700_000_000,
    method: "cash",
  });

  await withTenantTransaction(client, TENANT, () => store.appendPayment(payment));

  assert.equal(poolConnects, 0);
  assert.equal(client.sqlSequence().filter((sql) => sql === "BEGIN").length, 1);
  assert.equal(client.sqlSequence().at(-1), "COMMIT");
  const insert = client.queries.find((query) => query.sql.includes("INSERT INTO payments"));
  assert.ok(insert);
  assert.deepEqual(insert.params?.slice(0, 7), [
    PAYMENT_ID,
    DEMO_ORG_ID,
    DEMO_STORE_ID,
    ORDER_ID,
    "cash",
    500,
    "pay",
  ]);
});

test("PG payment repository orders same-second corrections after their references", () => {
  const rows = orderPaymentLedger([
    buildPayPayment({
      payment_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      org_id: DEMO_ORG_ID,
      store_id: DEMO_STORE_ID,
      order_id: ORDER_ID,
      amount_cents: 400,
      staff_id: DEMO_STAFF_A_ID,
      at: 1_700_000_000,
    }),
  ]);
  const source = rows[0];
  assert.ok(source);
  const refund = Object.freeze({
    ...source,
    payment_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab",
    kind: "refund" as const,
    amount_cents: 100,
    ref_payment_id: source.payment_id,
  });
  const ordered = orderPaymentLedger([refund, source]);
  assert.deepEqual(
    ordered.map((payment) => payment.payment_id),
    [source.payment_id, refund.payment_id],
  );
});

maybe(
  "real PG payment commands append ledger rows, update order totals, and audit together",
  async () => {
    assert.ok(urls);
    const adminPool = createPgPool({ connectionString: urls.admin });
    const appPool = createPgPool({ connectionString: urls.app });
    try {
      await seedDemoIdentity(adminPool);
      const paymentStore = createPgPaymentStore(appPool);
      const { registry } = createRegisteredM1Bus({
        order: Object.freeze({
          store: createPgOrderStore(appPool),
          payments: paymentStore,
          now: () => 1_700_000_000,
        }),
      });
      const chainHooks = createDefaultChainHooks({
        checkPolicy: async () =>
          Object.freeze({ ok: true as const, data: Object.freeze({ allowed: true as const }) }),
      });
      const receive = await runCommand(appPool, registry, chainHooks, "order.receive", {
        lines: [{ service_code: "wash", category_code: "shirt", unit_price_cents: 1_000, qty: 1 }],
        paid_cents: 0,
      });
      assert.equal(receive.ok, true, JSON.stringify(receive));
      if (!receive.ok) return;
      const orderId = (receive.data.result as { order_id: string }).order_id;

      const collect = await runCommand(appPool, registry, chainHooks, "payment.collect", {
        order_id: orderId,
        amount_cents: 400,
        method: "cash",
      });
      assert.equal(collect.ok, true, JSON.stringify(collect));
      if (!collect.ok) return;
      const paymentId = (collect.data.result as { payment_id: string }).payment_id;

      const refund = await runCommand(appPool, registry, chainHooks, "payment.refund", {
        order_id: orderId,
        amount_cents: 100,
        method: "cash",
        ref_payment_id: paymentId,
        reason: "integration refund",
      });
      assert.equal(refund.ok, true, JSON.stringify(refund));

      const hold = await runCommand(appPool, registry, chainHooks, "order.hold", {
        order_id: orderId,
        reason: "integration hold",
      });
      assert.equal(hold.ok, true, JSON.stringify(hold));
      const held = await withPoolClient(appPool, (client) =>
        withTenantTransaction(client, TENANT, (tx) =>
          tx.query<{ hold_reason: string | null }>(
            "SELECT hold_reason FROM orders WHERE id = $1::uuid",
            [orderId],
          ),
        ),
      );
      assert.equal(held.rows[0]?.hold_reason, "integration hold");

      const cancel = await runCommand(appPool, registry, chainHooks, "order.cancel", {
        order_id: orderId,
        reason: "integration cancellation",
      });
      assert.equal(cancel.ok, true, JSON.stringify(cancel));

      const rows = await withPoolClient(appPool, (client) =>
        withTenantTransaction(client, TENANT, async (tx) => {
          const payments = await paymentStore.listPayments(TENANT.orgId, TENANT.storeId, orderId);
          const order = await tx.query<{
            paid_cents: number;
            balance_cents: number;
            status: string;
            hold_reason: string | null;
          }>(
            "SELECT paid_cents, balance_cents, status, hold_reason FROM orders WHERE id = $1::uuid",
            [orderId],
          );
          const audits = await tx.query<{ command: string }>(
            `SELECT command FROM audit_log
           WHERE org_id = $1::uuid AND store_id = $2::uuid
             AND command IN ('order.receive', 'payment.collect', 'payment.refund', 'order.hold', 'order.cancel')
           ORDER BY at ASC`,
            [TENANT.orgId, TENANT.storeId],
          );
          return Object.freeze({ payments, order, audits });
        }),
      );
      assert.deepEqual(
        rows.payments.map((payment) => ({
          kind: payment.kind,
          amount_cents: payment.amount_cents,
        })),
        [
          { kind: "pay", amount_cents: 400 },
          { kind: "refund", amount_cents: 100 },
          { kind: "reversal", amount_cents: 100 },
          { kind: "reversal", amount_cents: 400 },
        ],
      );
      assert.deepEqual(rows.order.rows[0], {
        paid_cents: 0,
        balance_cents: 1_000,
        status: "cancelled",
        hold_reason: null,
      });
      assert.ok(rows.audits.rows.some((row) => row.command === "order.receive"));
      assert.ok(rows.audits.rows.some((row) => row.command === "payment.collect"));
      assert.ok(rows.audits.rows.some((row) => row.command === "payment.refund"));
      assert.ok(rows.audits.rows.some((row) => row.command === "order.hold"));
      assert.ok(rows.audits.rows.some((row) => row.command === "order.cancel"));
    } finally {
      await appPool.end();
      await adminPool.end();
    }
  },
);

async function runCommand(
  pool: PgPool,
  registry: ReturnType<typeof createRegisteredM1Bus>["registry"],
  chainHooks: ReturnType<typeof createDefaultChainHooks>,
  name: string,
  input: unknown,
) {
  return withPoolClient(pool, (client) =>
    executeCommand(client, TENANT, name, input, { registry, actor: ACTOR, chainHooks }),
  );
}
