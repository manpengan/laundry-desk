/**
 * Real-PostgreSQL counter workday acceptance.
 *
 * Every other order/payment test in this package runs against a capturing pool
 * that asserts on SQL strings, so no test ever drove a real order through the
 * production command path. That gap let migration 0019 ship a business_date
 * CHECK which rejected every possible date — orders and payments could not be
 * written at all on a real database, and the whole suite still passed.
 *
 * This test closes that gap: receive → repay → pickup → shift close, executed
 * through the real command bus against real PostgreSQL under laundry_app RLS.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { executeCommand } from "../bus/executor.js";
import type { ActorContext } from "../bus/types.js";
import { createPgPool, resolvePgUrls } from "../db/pg-pool.js";
import { withPoolClient } from "../db/pg-sql-client.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import type { TenantContext } from "../db/types.js";
import { createRegisteredM1Bus } from "../handlers/register-m1.js";
import { createPgCatalogStore } from "../catalog/pg-catalog-store.js";
import { createPgCustomerStore } from "../customer/pg-customer-store.js";
import { createPgFulfillmentStore } from "../fulfillment/pg-store.js";
import { DEMO_ORG_ID, DEMO_STAFF_A_ID, DEMO_STORE_ID } from "../local/demo-ids.js";
import { LOCAL_PROFILE } from "../local/profile.js";
import { seedPgTestIdentityFixture } from "../local/pg-test-fixture.js";
import { createPgShiftStore } from "../shift/pg-shift-store.js";
import { createPgStatsQuery } from "../stats/pg-source.js";
import { createPgOrderStore } from "./pg-order-store.js";

const urls =
  process.env.LAUNDRY_USE_LOCAL_PG === "1" || process.env.LAUNDRY_USE_LOCAL_PG === "true"
    ? resolvePgUrls(process.env)
    : null;
const maybe = urls === null ? test.skip : test;

const TENANT: TenantContext = Object.freeze({
  orgId: DEMO_ORG_ID,
  storeId: DEMO_STORE_ID,
  staffId: DEMO_STAFF_A_ID,
});

const ACTOR: ActorContext = Object.freeze({
  staffId: DEMO_STAFF_A_ID,
  deviceId: null,
  via: "ui",
  permissions: Object.freeze(["order_write", "payment_write", "shift_close"]),
});

const UNIT_PRICE_CENTS = 1_000;
const PRICING = Object.freeze({
  discount_cents: 100,
  addon_cents: 200,
  urgent_cents: 300,
  freight_cents: 400,
});
const PAYABLE_CENTS =
  2 * UNIT_PRICE_CENTS -
  PRICING.discount_cents +
  PRICING.addon_cents +
  PRICING.urgent_cents +
  PRICING.freight_cents;

/**
 * Pin this acceptance to its own business day. shift.close is terminal and
 * append-only, so closing "today" would freeze the shared integration database
 * for everything that runs afterwards — the browser workday E2E runs later in
 * the same CI job and could no longer take an order. Epoch seconds, matching
 * `deps.now`.
 */
const FIXED_CLOCK_EPOCH_SECONDS = Math.floor(Date.parse("2026-01-15T03:00:00Z") / 1000);
const fixedNow = (): number => FIXED_CLOCK_EPOCH_SECONDS;

maybe("PG counter workday: receive, repay, pickup and close settle on real ledgers", async () => {
  assert.ok(urls);
  const adminPool = createPgPool({ connectionString: urls.admin });
  const appPool = createPgPool({ connectionString: urls.app });
  const serviceCode = "wash";
  const categoryCode = `shirt-${randomUUID().slice(0, 8)}`;
  const phone = `139${String(Date.parse("2026-07-28") % 100_000_000).padStart(8, "0")}`;

  try {
    await seedPgTestIdentityFixture(adminPool);
    await adminPool.query(
      `INSERT INTO catalog_items (
         id, org_id, store_id, code, name, service_code, category_code,
         unit_price_cents, mnemonic, is_active, sort_order, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, '验收洗衬衫', $5, $6, $7, NULL, true, 0, now(), now())`,
      [
        randomUUID(),
        DEMO_ORG_ID,
        DEMO_STORE_ID,
        `acc-${categoryCode}`,
        serviceCode,
        categoryCode,
        UNIT_PRICE_CENTS,
      ],
    );

    const orderStore = createPgOrderStore(appPool);
    const customerStore = createPgCustomerStore(appPool, { orgId: DEMO_ORG_ID });
    const fulfillmentStore = createPgFulfillmentStore(appPool);
    const shiftStore = createPgShiftStore(appPool, {
      orgId: DEMO_ORG_ID,
      storeId: DEMO_STORE_ID,
    });
    const statsSource = createPgStatsQuery(appPool);
    const { registry, chainHooks } = createRegisteredM1Bus({
      order: Object.freeze({
        store: orderStore,
        customer: customerStore,
        catalog: createPgCatalogStore(appPool, {
          orgId: DEMO_ORG_ID,
          storeId: DEMO_STORE_ID,
        }),
        timeZone: LOCAL_PROFILE.timezone,
        now: fixedNow,
      }),
      shift: Object.freeze({
        store: shiftStore,
        stats: statsSource,
        timeZone: LOCAL_PROFILE.timezone,
        now: fixedNow,
      }),
      stats: Object.freeze({ source: statsSource, timeZone: LOCAL_PROFILE.timezone }),
      fulfillment: Object.freeze({ store: fulfillmentStore, now: fixedNow }),
    });

    const issue = async (name: string, input: unknown, confirmRef?: string) =>
      withPoolClient(appPool, (sql) =>
        executeCommand(sql, TENANT, name, input, {
          registry,
          actor: ACTOR,
          chainHooks,
          ...(confirmRef === undefined ? {} : { confirmRef }),
        }),
      );

    /**
     * Mirrors the counter danger-confirm flow: a policy-gated command first
     * answers with a confirm_ref, and the client re-issues it. The executor
     * replays the frozen arguments from the pending card (WYSIWYS), so the
     * reference travels in the options rather than the request body.
     */
    const run = async (name: string, input: unknown): Promise<{ ok: boolean; data?: unknown }> => {
      let result = await issue(name, input);
      if (!result.ok && result.error.code === "POLICY_CONFIRMATION_REQUIRED") {
        const detail: unknown = result.error.detail;
        const confirmRef =
          typeof detail === "object" && detail !== null && "confirm_ref" in detail
            ? (detail as { confirm_ref: unknown }).confirm_ref
            : undefined;
        assert.equal(typeof confirmRef, "string", `${name}: missing confirm_ref`);
        result = await issue(name, input, confirmRef as string);
      }
      assert.equal(result.ok, true, `${name}: ${JSON.stringify(result)}`);
      return result.ok ? { ok: true, data: result.data.result } : { ok: false };
    };

    // Receive two garments with every pricing component and pay 600 in cash.
    const received = (
      await run("order.receive", {
        customer_phone: phone,
        customer_name: "验收顾客",
        lines: [{ service_code: serviceCode, category_code: categoryCode, qty: 2 }],
        ...PRICING,
        initial_payment: { amount_cents: 600, method: "cash" },
      })
    ).data as { order_id: string; business_date: string; balance_cents?: number };

    const afterReceive = await readOrder(appPool, received.order_id);
    // 2026-01-15T03:00Z is 11:00 in Asia/Taipei, so the pinned business day is
    // that same date. Asserting it exactly also proves the clock injection took
    // effect, which is what keeps today's shift open for the browser E2E.
    assert.equal(
      afterReceive.business_date,
      "2026-01-15",
      "receive must persist the pinned ISO business_date",
    );
    assert.equal(afterReceive.original_cents, 2 * UNIT_PRICE_CENTS);
    assert.equal(afterReceive.discount_cents, PRICING.discount_cents);
    assert.equal(afterReceive.addon_cents, PRICING.addon_cents);
    assert.equal(afterReceive.urgent_cents, PRICING.urgent_cents);
    assert.equal(afterReceive.freight_cents, PRICING.freight_cents);
    assert.equal(afterReceive.payable_cents, PAYABLE_CENTS, "authoritative catalog pricing");
    assert.equal(afterReceive.paid_cents, 600);
    assert.equal(afterReceive.balance_cents, PAYABLE_CENTS - 600);
    assert.equal(afterReceive.garment_count, 2);
    assert.equal(afterReceive.payment_count, 1, "a single ledger row for the initial payment");
    assert.deepEqual(
      await statsSource.daySummary({
        orgId: DEMO_ORG_ID,
        storeId: DEMO_STORE_ID,
        businessDate: afterReceive.business_date,
      }),
      {
        business_date: afterReceive.business_date,
        order_count: 1,
        garment_count: 2,
        payable_cents: PAYABLE_CENTS,
        paid_cents: 600,
        balance_cents: PAYABLE_CENTS - 600,
        payment_cents: 600,
        picked_garment_count: 0,
      },
      "stats aggregate must reflect the real order and payment ledgers",
    );

    const garmentIds = await readGarmentIds(appPool, received.order_id);
    assert.equal(garmentIds.length, 2);
    await run("garment.bulk_transition", {
      garment_ids: garmentIds,
      target_status: "washing",
    });
    await run("garment.incident.record", {
      garment_id: garmentIds[0],
      kind: "damage",
      note: "验收污渍复核",
      compensation_cents: 0,
    });
    await run("garment.rework", {
      garment_ids: garmentIds,
      reason: "验收返工",
    });
    await run("garment.bulk_transition", {
      garment_ids: garmentIds,
      target_status: "ready",
    });
    await run("garment.bulk_transition", {
      garment_ids: garmentIds,
      target_status: "racked",
    });
    assert.deepEqual(
      await readFulfillment(appPool, received.order_id),
      { statuses: ["racked", "racked"], statusLogs: 8, incidents: 3 },
      "fulfillment transitions and incidents persist atomically on real PostgreSQL",
    );

    const sourceCustomer = await customerStore.getByPhone(phone);
    assert.ok(sourceCustomer);
    const targetPhone = `138${phone.slice(3)}`;
    const targetCustomer = (
      await customerStore.upsert({
        phone: targetPhone,
        name: "验收顾客",
        note: "保留目标备注",
        now: fixedNow(),
      })
    ).customer;
    const duplicateIds = (await customerStore.findDuplicates(sourceCustomer.customer_id, 20)).map(
      (candidate) => candidate.customer_id,
    );
    assert.ok(duplicateIds.includes(targetCustomer.customer_id));
    assert.deepEqual(
      await customerStore.merge({
        source_customer_id: sourceCustomer.customer_id,
        target_customer_id: targetCustomer.customer_id,
        store_id: DEMO_STORE_ID,
        now: fixedNow(),
      }),
      {
        source_customer_id: sourceCustomer.customer_id,
        target_customer_id: targetCustomer.customer_id,
        relinked_order_count: 1,
      },
    );
    const redirectedCustomer = await customerStore.getByPhone(phone);
    assert.equal(redirectedCustomer?.customer_id, targetCustomer.customer_id);
    assert.equal(redirectedCustomer?.phone, targetPhone);
    assert.equal(redirectedCustomer?.note, "保留目标备注");
    assert.equal(await readOrderCustomerPhone(appPool, received.order_id), targetPhone);

    // Repay the outstanding debt.
    await run("payment.repay", {
      order_id: received.order_id,
      amount_cents: PAYABLE_CENTS - 600,
      method: "wechat",
    });
    const afterRepay = await readOrder(appPool, received.order_id);
    assert.equal(afterRepay.balance_cents, 0, "repay must settle the balance");
    assert.equal(afterRepay.paid_cents, PAYABLE_CENTS);
    assert.equal(afterRepay.payment_count, 2, "payments are append-only");
    assert.deepEqual(
      await statsSource.cashSummary({
        orgId: DEMO_ORG_ID,
        storeId: DEMO_STORE_ID,
        businessDate: afterReceive.business_date,
      }),
      { cash_cents: 600 },
      "cash summary must exclude the WeChat repayment",
    );

    // Pick up everything; nothing left to collect.
    await run("order.pickup", {
      order_id: received.order_id,
      garment_ids: [],
      collect_cents: 0,
    });
    const afterPickup = await readOrder(appPool, received.order_id);
    assert.equal(afterPickup.picked_up_count, 2, "all garments transition to picked_up");
    assert.equal(afterPickup.balance_cents, 0);

    // Close the business day the order landed on.
    const closed = (
      await run("shift.close", {
        business_date: afterReceive.business_date,
        counted_cash_cents: 600,
        retained_float_cents: 100,
        signature_name: "验收签字",
      })
    ).data as {
      counted_cash_cents: number;
      retained_float_cents: number;
      expected_cash_cents: number;
      cash_difference_cents: number;
    };
    assert.deepEqual(
      {
        counted_cash_cents: closed.counted_cash_cents,
        retained_float_cents: closed.retained_float_cents,
        expected_cash_cents: closed.expected_cash_cents,
        cash_difference_cents: closed.cash_difference_cents,
      },
      {
        counted_cash_cents: 600,
        retained_float_cents: 100,
        expected_cash_cents: 600,
        cash_difference_cents: 0,
      },
    );
    const persistedClose = await shiftStore.getByBusinessDate(
      DEMO_ORG_ID,
      DEMO_STORE_ID,
      afterReceive.business_date,
    );
    assert.ok(persistedClose);
    assert.equal(persistedClose.signature_name, "验收签字");
    assert.equal(persistedClose.order_count, 1);
    assert.equal(persistedClose.payable_cents, PAYABLE_CENTS);
    assert.equal(persistedClose.paid_cents, PAYABLE_CENTS);
    assert.equal(persistedClose.payment_cents, 600, "repay is separate from kind=pay cashflow");
    assert.equal(persistedClose.counted_cash_cents, 600);
    assert.equal(persistedClose.retained_float_cents, 100);
    assert.equal(persistedClose.expected_cash_cents, 600);
    assert.equal(persistedClose.cash_difference_cents, 0);
    const closings = await withPoolClient(appPool, (sql) =>
      withTenantTransaction(sql, TENANT, (tx) =>
        tx.query<{ close_count: string; audit_count: string }>(
          `SELECT
             (SELECT count(*) FROM shift_closings WHERE business_date = $1)::text AS close_count,
             (SELECT count(*) FROM audit_log
               WHERE command = 'shift.close' AND entity_id = $2)::text AS audit_count`,
          [afterReceive.business_date, persistedClose.shift_id],
        ),
      ),
    );
    assert.equal(
      Number(closings.rows[0]?.close_count),
      1,
      "shift close writes exactly one closing row",
    );
    assert.equal(Number(closings.rows[0]?.audit_count), 1, "shift close audit commits atomically");
  } finally {
    await appPool.end();
    await adminPool.end();
  }
});

type OrderSnapshot = Readonly<{
  business_date: string;
  original_cents: number;
  discount_cents: number;
  addon_cents: number;
  urgent_cents: number;
  freight_cents: number;
  payable_cents: number;
  paid_cents: number;
  balance_cents: number;
  garment_count: number;
  picked_up_count: number;
  payment_count: number;
}>;

async function readGarmentIds(
  appPool: ReturnType<typeof createPgPool>,
  orderId: string,
): Promise<readonly string[]> {
  return withPoolClient(appPool, (sql) =>
    withTenantTransaction(sql, TENANT, async (tx) => {
      const result = await tx.query<{ id: string }>(
        "SELECT id::text FROM garments WHERE order_id = $1::uuid ORDER BY id",
        [orderId],
      );
      return Object.freeze(result.rows.map((row) => row.id));
    }),
  );
}

async function readFulfillment(
  appPool: ReturnType<typeof createPgPool>,
  orderId: string,
): Promise<Readonly<{ statuses: readonly string[]; statusLogs: number; incidents: number }>> {
  return withPoolClient(appPool, (sql) =>
    withTenantTransaction(sql, TENANT, async (tx) => {
      const garments = await tx.query<{ status: string }>(
        "SELECT status FROM garments WHERE order_id = $1::uuid ORDER BY id",
        [orderId],
      );
      const counts = await tx.query<{ status_logs: string; incidents: string }>(
        `SELECT
           (SELECT count(*) FROM garment_status_log WHERE order_id = $1::uuid)::text AS status_logs,
           (SELECT count(*) FROM garment_incidents WHERE order_id = $1::uuid)::text AS incidents`,
        [orderId],
      );
      return Object.freeze({
        statuses: Object.freeze(garments.rows.map((row) => row.status)),
        statusLogs: Number(counts.rows[0]?.status_logs ?? "0"),
        incidents: Number(counts.rows[0]?.incidents ?? "0"),
      });
    }),
  );
}

async function readOrderCustomerPhone(
  appPool: ReturnType<typeof createPgPool>,
  orderId: string,
): Promise<string | null> {
  return withPoolClient(appPool, (sql) =>
    withTenantTransaction(sql, TENANT, async (tx) => {
      const result = await tx.query<{ customer_phone: string | null }>(
        "SELECT customer_phone FROM orders WHERE id = $1::uuid",
        [orderId],
      );
      return result.rows[0]?.customer_phone ?? null;
    }),
  );
}

async function readOrder(
  appPool: ReturnType<typeof createPgPool>,
  orderId: string,
): Promise<OrderSnapshot> {
  return withPoolClient(appPool, (sql) =>
    withTenantTransaction(sql, TENANT, async (tx) => {
      const order = await tx.query<{
        business_date: string;
        original_cents: number;
        discount_cents: number;
        addon_cents: number;
        urgent_cents: number;
        freight_cents: number;
        payable_cents: number;
        paid_cents: number;
        balance_cents: number;
      }>(
        `SELECT business_date, original_cents, discount_cents, addon_cents,
                urgent_cents, freight_cents, payable_cents, paid_cents, balance_cents
           FROM orders WHERE id = $1`,
        [orderId],
      );
      const garments = await tx.query<{ total: string; picked: string }>(
        `SELECT count(*)::text AS total,
                count(*) FILTER (WHERE status = 'picked_up')::text AS picked
           FROM garments WHERE order_id = $1`,
        [orderId],
      );
      const payments = await tx.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM payments WHERE order_id = $1",
        [orderId],
      );
      const row = order.rows[0];
      assert.ok(row, "order row must exist");
      return Object.freeze({
        business_date: row.business_date,
        original_cents: row.original_cents,
        discount_cents: row.discount_cents,
        addon_cents: row.addon_cents,
        urgent_cents: row.urgent_cents,
        freight_cents: row.freight_cents,
        payable_cents: row.payable_cents,
        paid_cents: row.paid_cents,
        balance_cents: row.balance_cents,
        garment_count: Number(garments.rows[0]?.total ?? "0"),
        picked_up_count: Number(garments.rows[0]?.picked ?? "0"),
        payment_count: Number(payments.rows[0]?.count ?? "0"),
      });
    }),
  );
}
