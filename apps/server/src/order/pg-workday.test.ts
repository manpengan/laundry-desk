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
    const shiftStore = createPgShiftStore(appPool, {
      orgId: DEMO_ORG_ID,
      storeId: DEMO_STORE_ID,
    });
    const statsSource = createPgStatsQuery(appPool);
    const { registry, chainHooks } = createRegisteredM1Bus({
      order: Object.freeze({
        store: orderStore,
        customer: createPgCustomerStore(appPool, { orgId: DEMO_ORG_ID }),
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

    // Receive two garments (2000 cents) paying 600 in cash — 1400 stays as debt.
    const received = (
      await run("order.receive", {
        customer_phone: phone,
        customer_name: "验收顾客",
        lines: [{ service_code: serviceCode, category_code: categoryCode, qty: 2 }],
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
    assert.equal(afterReceive.payable_cents, 2 * UNIT_PRICE_CENTS, "authoritative catalog pricing");
    assert.equal(afterReceive.paid_cents, 600);
    assert.equal(afterReceive.balance_cents, 1_400);
    assert.equal(afterReceive.garment_count, 2);
    assert.equal(afterReceive.payment_count, 1, "a single ledger row for the initial payment");

    // Repay the outstanding debt.
    await run("payment.repay", {
      order_id: received.order_id,
      amount_cents: 1_400,
      method: "wechat",
    });
    const afterRepay = await readOrder(appPool, received.order_id);
    assert.equal(afterRepay.balance_cents, 0, "repay must settle the balance");
    assert.equal(afterRepay.paid_cents, 2 * UNIT_PRICE_CENTS);
    assert.equal(afterRepay.payment_count, 2, "payments are append-only");

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
    await run("shift.close", {
      business_date: afterReceive.business_date,
      counted_cash_cents: 600,
      retained_float_cents: 0,
      signature_name: "验收签字",
    });
    const closings = await withPoolClient(appPool, (sql) =>
      withTenantTransaction(sql, TENANT, (tx) =>
        tx.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM shift_closings WHERE business_date = $1",
          [afterReceive.business_date],
        ),
      ),
    );
    assert.equal(Number(closings.rows[0]?.count), 1, "shift close writes exactly one closing row");
  } finally {
    await appPool.end();
    await adminPool.end();
  }
});

type OrderSnapshot = Readonly<{
  business_date: string;
  payable_cents: number;
  paid_cents: number;
  balance_cents: number;
  garment_count: number;
  picked_up_count: number;
  payment_count: number;
}>;

async function readOrder(
  appPool: ReturnType<typeof createPgPool>,
  orderId: string,
): Promise<OrderSnapshot> {
  return withPoolClient(appPool, (sql) =>
    withTenantTransaction(sql, TENANT, async (tx) => {
      const order = await tx.query<{
        business_date: string;
        payable_cents: number;
        paid_cents: number;
        balance_cents: number;
      }>(
        `SELECT business_date, payable_cents, paid_cents, balance_cents
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
