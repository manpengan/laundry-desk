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
import { DEMO_ORG_ID, DEMO_STAFF_A_ID, DEMO_STAFF_B_ID, DEMO_STORE_ID } from "../local/demo-ids.js";
import { LOCAL_PROFILE } from "../local/profile.js";
import { seedPgTestIdentityFixture } from "../local/pg-test-fixture.js";
import { createPgShiftStore } from "../shift/pg-shift-store.js";
import { createPgStatsQuery } from "../stats/pg-source.js";
import { acquirePgBusinessDayLock } from "../workday/business-day-lock.js";
import { processPendingActionStore } from "../pending-actions/process-store.js";
import { createStepUpProof } from "../policy/step-up.js";
import { MemoryStepUpProofStore } from "../policy/step-up-proof-store.js";
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
  permissions: Object.freeze(["order_write", "payment_write", "payment_refund", "shift_close"]),
});
const APPROVER: ActorContext = Object.freeze({ ...ACTOR, staffId: DEMO_STAFF_B_ID });

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
const FIXED_BUSINESS_DATE = "2026-01-15";
const CUSTOMER_PHONE = `139${String(Date.parse("2026-07-28") % 100_000_000).padStart(8, "0")}`;
const TARGET_CUSTOMER_PHONE = `138${CUSTOMER_PHONE.slice(3)}`;

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

  try {
    await seedPgTestIdentityFixture(adminPool);
    await clearWorkdayFixture(adminPool);
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
        lockBusinessDay: acquirePgBusinessDayLock,
      }),
      shift: Object.freeze({
        store: shiftStore,
        stats: statsSource,
        timeZone: LOCAL_PROFILE.timezone,
        now: fixedNow,
        lockBusinessDay: acquirePgBusinessDayLock,
      }),
      stats: Object.freeze({ source: statsSource, timeZone: LOCAL_PROFILE.timezone }),
      fulfillment: Object.freeze({ store: fulfillmentStore, now: fixedNow }),
    });

    const issueAs = async (
      actor: ActorContext,
      tenant: TenantContext,
      name: string,
      input: unknown,
      confirmRef?: string,
    ) =>
      withPoolClient(appPool, (sql) =>
        executeCommand(sql, tenant, name, input, {
          registry,
          actor,
          chainHooks,
          ...(confirmRef === undefined ? {} : { confirmRef }),
        }),
      );
    const issue = async (name: string, input: unknown, confirmRef?: string) =>
      issueAs(ACTOR, TENANT, name, input, confirmRef);

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
        customer_phone: CUSTOMER_PHONE,
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
      FIXED_BUSINESS_DATE,
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

    const garmentRefs = await readGarmentRefs(appPool, received.order_id);
    const garmentIds = garmentRefs.map((garment) => garment.id);
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
    for (const [index, garment] of garmentRefs.entries()) {
      await run("garment.rack.assign", {
        barcode: garment.barcode,
        rack_zone: "A",
        rack_slot: String(index + 1).padStart(2, "0"),
      });
    }
    assert.deepEqual(
      await readFulfillment(appPool, received.order_id),
      { statuses: ["racked", "racked"], statusLogs: 8, incidents: 3 },
      "fulfillment transitions and incidents persist atomically on real PostgreSQL",
    );

    const sourceCustomer = await customerStore.getByPhone(CUSTOMER_PHONE);
    assert.ok(sourceCustomer);
    const targetCustomer = (
      await customerStore.upsert({
        phone: TARGET_CUSTOMER_PHONE,
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
    const redirectedCustomer = await customerStore.getByPhone(CUSTOMER_PHONE);
    assert.equal(redirectedCustomer?.customer_id, targetCustomer.customer_id);
    assert.equal(redirectedCustomer?.phone, TARGET_CUSTOMER_PHONE);
    assert.equal(redirectedCustomer?.note, "保留目标备注");
    assert.deepEqual(await readOrderCustomerLink(appPool, received.order_id), {
      customer_id: targetCustomer.customer_id,
      customer_phone: TARGET_CUSTOMER_PHONE,
    });

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
    const repayment = (
      await orderStore.listPayments?.(DEMO_ORG_ID, DEMO_STORE_ID, received.order_id)
    )?.find((payment) => payment.kind === "repay");
    assert.ok(repayment);
    const refundInput = Object.freeze({
      order_id: received.order_id,
      amount_cents: 100,
      method: repayment.method,
      ref_payment_id: repayment.payment_id,
      reason: "real PG refund acceptance",
    });
    const refundGate = await issue("payment.refund", refundInput);
    assert.equal(refundGate.ok, false, JSON.stringify(refundGate));
    if (refundGate.ok) assert.fail("refund must require another administrator");
    assert.equal(refundGate.error.code, "POLICY_STEP_UP_REQUIRED");
    const refundDetail = "detail" in refundGate.error ? refundGate.error.detail : undefined;
    if (refundDetail?.kind !== "confirmation") {
      assert.fail("payment.refund must return a step-up confirmation reference");
    }
    const pending = await processPendingActionStore.get(refundDetail.confirm_ref);
    assert.ok(pending);
    const sessionBinding = Object.freeze({ sessionId: randomUUID(), sessionVersion: 1 });
    const proofStore = new MemoryStepUpProofStore();
    await proofStore.insert(
      createStepUpProof({
        proofId: randomUUID(),
        pending,
        approverStaffId: APPROVER.staffId,
        issuedAt: Math.floor(Date.now() / 1000),
        sessionBinding,
      }),
    );
    const refunded = await withPoolClient(appPool, (sql) =>
      executeCommand(
        sql,
        TENANT,
        "payment.refund",
        {},
        {
          registry,
          actor: ACTOR,
          chainHooks,
          stepUpProofStore: proofStore,
          confirmRef: refundDetail.confirm_ref,
          sessionBinding,
        },
      ),
    );
    assert.equal(refunded.ok, true, JSON.stringify(refunded));
    if (!refunded.ok) assert.fail("approved refund must execute");
    const refundResult = refunded.data.result as {
      payment_id: string;
      kind: string;
      ref_payment_id: string;
      paid_cents: number;
      balance_cents: number;
    };
    assert.equal(refundResult.kind, "refund");
    assert.equal(refundResult.ref_payment_id, repayment.payment_id);
    assert.equal(refundResult.paid_cents, PAYABLE_CENTS - 100);
    assert.equal(refundResult.balance_cents, 100);
    const refundRows = await withPoolClient(appPool, (sql) =>
      withTenantTransaction(sql, TENANT, (tx) =>
        tx.query<{ after_json: string }>(
          `SELECT after_json
             FROM audit_log
            WHERE command = 'payment.refund' AND entity_id = $1
            ORDER BY at DESC
            LIMIT 1`,
          [refundResult.payment_id],
        ),
      ),
    );
    const refundAudit = JSON.parse(refundRows.rows[0]?.after_json ?? "null") as unknown;
    assert.deepEqual(
      refundAudit !== null && typeof refundAudit === "object"
        ? {
            initiated_by_staff_id: Reflect.get(refundAudit, "initiated_by_staff_id"),
            approved_by_staff_id: Reflect.get(refundAudit, "approved_by_staff_id"),
          }
        : null,
      {
        initiated_by_staff_id: ACTOR.staffId,
        approved_by_staff_id: APPROVER.staffId,
      },
      "R4 refund audit must persist both staff identities after process-local approval is consumed",
    );
    await run("payment.repay", {
      order_id: received.order_id,
      amount_cents: 100,
      method: "wechat",
    });
    const afterRefundRecovery = await readOrder(appPool, received.order_id);
    assert.equal(afterRefundRecovery.paid_cents, PAYABLE_CENTS);
    assert.equal(afterRefundRecovery.balance_cents, 0);
    assert.equal(afterRefundRecovery.payment_count, 4, "refund and recovery remain append-only");
    assert.deepEqual(
      await statsSource.cashSummary({
        orgId: DEMO_ORG_ID,
        storeId: DEMO_STORE_ID,
        businessDate: afterReceive.business_date,
      }),
      { cash_cents: 600 },
      "cash summary must exclude the WeChat repayment",
    );

    await run("order.hold", {
      lines: [{ service_code: serviceCode, category_code: categoryCode, qty: 1 }],
    });
    const cancelCandidate = (
      await run("order.receive", {
        lines: [{ service_code: serviceCode, category_code: categoryCode, qty: 1 }],
      })
    ).data as { order_id: string };
    await run("order.cancel", {
      order_id: cancelCandidate.order_id,
      reason: "real PG shift exclusion acceptance",
    });
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
        paid_cents: PAYABLE_CENTS,
        balance_cents: 0,
        payment_cents: 600,
        picked_garment_count: 0,
      },
      "draft and cancelled orders must not enter the shift accounting snapshot",
    );

    // Pick up everything; nothing left to collect.
    await run("order.pickup", {
      order_id: received.order_id,
      garment_ids: [],
      collect_cents: 0,
      verification_barcodes: garmentRefs.map((garment) => garment.barcode),
    });
    const afterPickup = await readOrder(appPool, received.order_id);
    assert.equal(afterPickup.picked_up_count, 2, "all garments transition to picked_up");
    assert.equal(afterPickup.balance_cents, 0);
    assert.deepEqual(await readFulfillment(appPool, received.order_id), {
      statuses: ["picked_up", "picked_up"],
      statusLogs: 10,
      incidents: 3,
    });

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
    try {
      await clearWorkdayFixture(adminPool);
    } finally {
      await appPool.end();
      await adminPool.end();
    }
  }
});

async function clearWorkdayFixture(pool: ReturnType<typeof createPgPool>): Promise<void> {
  const client = await pool.connect();
  const scope = [DEMO_ORG_ID, DEMO_STORE_ID, FIXED_BUSINESS_DATE];
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE laundry_owner");
    await client.query(
      `DELETE FROM audit_log
        WHERE org_id = $1::uuid AND store_id = $2::uuid
          AND entity_id IN (
            SELECT id::text FROM orders
              WHERE org_id = $1::uuid AND store_id = $2::uuid AND business_date = $3
            UNION SELECT id::text FROM garments
              WHERE org_id = $1::uuid AND store_id = $2::uuid
                AND order_id IN (
                  SELECT id FROM orders
                    WHERE org_id = $1::uuid AND store_id = $2::uuid AND business_date = $3
                )
            UNION SELECT id::text FROM payments
              WHERE org_id = $1::uuid AND store_id = $2::uuid AND business_date = $3
            UNION SELECT id::text FROM shift_closings
              WHERE org_id = $1::uuid AND store_id = $2::uuid AND business_date = $3
            UNION SELECT id::text FROM customers
              WHERE org_id = $1::uuid AND phone IN ($4, $5)
          )`,
      [...scope, CUSTOMER_PHONE, TARGET_CUSTOMER_PHONE],
    );
    const orderIds = `SELECT id FROM orders
      WHERE org_id = $1::uuid AND store_id = $2::uuid AND business_date = $3`;
    for (const table of [
      "garment_rack_log",
      "garment_incidents",
      "garment_status_log",
      "payments",
      "garments",
      "order_lines",
    ]) {
      await client.query(
        `DELETE FROM ${table}
          WHERE org_id = $1::uuid AND store_id = $2::uuid
            AND order_id IN (${orderIds})`,
        scope,
      );
    }
    await client.query(
      "DELETE FROM orders WHERE org_id = $1::uuid AND store_id = $2::uuid AND business_date = $3",
      scope,
    );
    await client.query(
      "DELETE FROM shift_closings WHERE org_id = $1::uuid AND store_id = $2::uuid AND business_date = $3",
      scope,
    );
    await client.query(
      `DELETE FROM customers
        WHERE org_id = $1::uuid AND phone IN ($2, $3)`,
      [DEMO_ORG_ID, CUSTOMER_PHONE, TARGET_CUSTOMER_PHONE],
    );
    await client.query(
      `DELETE FROM catalog_items
        WHERE org_id = $1::uuid AND store_id = $2::uuid AND code LIKE 'acc-shirt-%'`,
      [DEMO_ORG_ID, DEMO_STORE_ID],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

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

async function readGarmentRefs(
  appPool: ReturnType<typeof createPgPool>,
  orderId: string,
): Promise<readonly Readonly<{ id: string; barcode: string }>[]> {
  return withPoolClient(appPool, (sql) =>
    withTenantTransaction(sql, TENANT, async (tx) => {
      const result = await tx.query<{ id: string; barcode: string }>(
        "SELECT id::text, barcode FROM garments WHERE order_id = $1::uuid ORDER BY id",
        [orderId],
      );
      return Object.freeze(result.rows.map((row) => Object.freeze({ ...row })));
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

async function readOrderCustomerLink(
  appPool: ReturnType<typeof createPgPool>,
  orderId: string,
): Promise<Readonly<{ customer_id: string | null; customer_phone: string | null }>> {
  return withPoolClient(appPool, (sql) =>
    withTenantTransaction(sql, TENANT, async (tx) => {
      const result = await tx.query<{
        customer_id: string | null;
        customer_phone: string | null;
      }>("SELECT customer_id::text, customer_phone FROM orders WHERE id = $1::uuid", [orderId]);
      return Object.freeze({
        customer_id: result.rows[0]?.customer_id ?? null,
        customer_phone: result.rows[0]?.customer_phone ?? null,
      });
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
