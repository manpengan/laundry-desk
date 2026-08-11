import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { executeCommand } from "../bus/executor.js";
import { executeQuery } from "../bus/execute-query.js";
import type { ActorContext } from "../bus/types.js";
import { createPgPool, resolvePgUrls } from "../db/pg-pool.js";
import { withPoolClient } from "../db/pg-sql-client.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import type { TenantContext } from "../db/types.js";
import { createRegisteredM1Bus } from "../handlers/register-m1.js";
import { createPgCatalogStore } from "../catalog/pg-catalog-store.js";
import { createPgCustomerStore } from "../customer/pg-customer-store.js";
import { createPgFulfillmentStore } from "../fulfillment/pg-store.js";
import { DEMO_ORG_ID, DEMO_STORE_ID } from "../local/demo-ids.js";
import { PG_TEST_STAFF_B_ID } from "../local/pg-test-fixture.js";
import { LOCAL_PROFILE } from "../local/profile.js";
import { seedPgTestIdentityFixture } from "../local/pg-test-fixture.js";
import { createPgMemberDeps } from "../member/runtime.js";
import { createPgPricingPolicyStore } from "../pricing/pg-store.js";
import { createPgShiftStore } from "../shift/pg-shift-store.js";
import { createPgStatsQuery } from "../stats/pg-source.js";
import { acquirePgBusinessDayLock } from "../workday/business-day-lock.js";
import { processPendingActionStore } from "../pending-actions/process-store.js";
import { createStepUpProof } from "../policy/step-up.js";
import { MemoryStepUpProofStore } from "../policy/step-up-proof-store.js";
import { createPgOrderStore } from "./pg-order-store.js";
import {
  ACTOR,
  CUSTOMER_PHONE,
  FIXED_BUSINESS_DATE,
  PAYABLE_CENTS,
  PRICING,
  TARGET_CUSTOMER_PHONE,
  TENANT,
  UNIT_PRICE_CENTS,
  fixedNow,
} from "./pg-workday-test-context.js";
import {
  clearWorkdayFixture,
  readClosedWriteCounts,
  readFulfillment,
  readGarmentRefs,
  readOrder,
  readOrderCustomerLink,
} from "./pg-workday-test-helpers.js";

const APPROVER: ActorContext = Object.freeze({ ...ACTOR, staffId: PG_TEST_STAFF_B_ID });

const urls =
  process.env.LAUNDRY_USE_LOCAL_PG === "1" || process.env.LAUNDRY_USE_LOCAL_PG === "true"
    ? resolvePgUrls(process.env)
    : null;
const maybe = urls === null ? test.skip : test;

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

    const pricingStore = createPgPricingPolicyStore(appPool);
    const pricingChange = await pricingStore.set({
      org_id: DEMO_ORG_ID,
      store_id: DEMO_STORE_ID,
      staff_id: ACTOR.staffId,
      expected_version: 0,
      urgent_cents: PRICING.urgent_cents,
      freight_cents: PRICING.freight_cents,
      addons: Object.freeze([
        Object.freeze({
          code: "stain",
          name: "验收去渍",
          unit_price_cents: PRICING.addon_cents,
          is_active: true,
          sort_order: 0,
        }),
      ]),
      updated_at: fixedNow(),
    });
    assert.ok(pricingChange);

    const orderStore = createPgOrderStore(appPool);
    const customerStore = createPgCustomerStore(appPool, { orgId: DEMO_ORG_ID });
    const fulfillmentStore = createPgFulfillmentStore(appPool);
    const shiftStore = createPgShiftStore(appPool, {
      orgId: DEMO_ORG_ID,
      storeId: DEMO_STORE_ID,
    });
    const statsSource = createPgStatsQuery(appPool);
    const { registry, queryRegistry, chainHooks } = createRegisteredM1Bus({
      order: Object.freeze({
        store: orderStore,
        customer: customerStore,
        catalog: createPgCatalogStore(appPool, {
          orgId: DEMO_ORG_ID,
          storeId: DEMO_STORE_ID,
        }),
        pricing: pricingStore,
        timeZone: LOCAL_PROFILE.timezone,
        now: fixedNow,
        lockBusinessDay: acquirePgBusinessDayLock,
        isBusinessDayClosed: async (businessDate) =>
          (await shiftStore.getByBusinessDate(DEMO_ORG_ID, DEMO_STORE_ID, businessDate)) !== null,
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
      member: createPgMemberDeps(),
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
    const query = async (name: string, input: unknown) =>
      withPoolClient(appPool, (sql) =>
        executeQuery(sql, TENANT, name, input, { registry: queryRegistry, actor: ACTOR }),
      );

    // Replay policy-gated commands with the server-issued frozen confirmation reference.
    const dispatch = async (name: string, input: unknown) => {
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
      return result;
    };
    const run = async (name: string, input: unknown): Promise<{ ok: boolean; data?: unknown }> => {
      const result = await dispatch(name, input);
      assert.equal(result.ok, true, `${name}: ${JSON.stringify(result)}`);
      return result.ok ? { ok: true, data: result.data.result } : { ok: false };
    };

    const received = (
      await run("order.receive", {
        customer_phone: CUSTOMER_PHONE,
        customer_name: "验收顾客",
        lines: [
          {
            service_code: serviceCode,
            category_code: categoryCode,
            qty: 2,
            garments: [
              {
                color: "白",
                brand: "甲牌",
                defects: ["袖口污渍", "纽扣松动"],
                accessories: ["腰带"],
                note: "单独去渍",
                addon_codes: ["stain"],
              },
              {
                color: "蓝",
                brand: "乙牌",
                defects: ["下摆磨损"],
                accessories: ["衣架"],
                note: "低温处理",
              },
            ],
          },
        ],
        discount_cents: PRICING.discount_cents,
        urgent: true,
        freight: true,
        // Compatibility amounts are accepted then ignored by ADR-38.
        addon_cents: 999_999,
        urgent_cents: 999_999,
        freight_cents: 999_999,
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
    assert.equal(afterReceive.pricing_policy_version, 1);
    assert.equal(afterReceive.urgent_selected, true);
    assert.equal(afterReceive.freight_selected, true);
    assert.equal(afterReceive.payable_cents, PAYABLE_CENTS, "authoritative catalog pricing");
    assert.equal(afterReceive.paid_cents, 600);
    assert.equal(afterReceive.balance_cents, PAYABLE_CENTS - 600);
    assert.equal(afterReceive.garment_count, 2);
    assert.equal(afterReceive.payment_count, 1, "a single ledger row for the initial payment");
    const detailedOrder = await query("order.get", { order_id: received.order_id });
    assert.equal(detailedOrder.ok, true, JSON.stringify(detailedOrder));
    if (!detailedOrder.ok) assert.fail("order.get must load the received PG order");
    const detailedResult = detailedOrder.data.result as {
      lines: readonly {
        garments: readonly {
          color: string | null;
          defects: readonly string[];
          addons: readonly { code: string; name: string; unit_price_cents: number }[];
        }[];
      }[];
      garments: readonly {
        color: string | null;
        brand: string | null;
        defects: readonly string[];
        accessories: readonly string[];
        note: string | null;
      }[];
    };
    assert.deepEqual(detailedResult.lines[0]?.garments[0], {
      color: "白",
      brand: "甲牌",
      defects: ["袖口污渍", "纽扣松动"],
      accessories: ["腰带"],
      note: "单独去渍",
      addons: [{ code: "stain", name: "验收去渍", unit_price_cents: PRICING.addon_cents }],
    });
    assert.deepEqual(
      detailedResult.garments.map((garment) => ({
        color: garment.color,
        brand: garment.brand,
        defects: garment.defects,
        accessories: garment.accessories,
        note: garment.note,
      })),
      [
        {
          color: "白",
          brand: "甲牌",
          defects: ["袖口污渍", "纽扣松动"],
          accessories: ["腰带"],
          note: "单独去渍",
        },
        {
          color: "蓝",
          brand: "乙牌",
          defects: ["下摆磨损"],
          accessories: ["衣架"],
          note: "低温处理",
        },
      ],
    );
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
    const member = (await run("member.account.open", { customer_id: targetCustomer.customer_id }))
      .data as { account_id: string };

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
    const ledgerBeforeRefund = await query("payment.ledger.list", {
      order_id: received.order_id,
    });
    assert.equal(ledgerBeforeRefund.ok, true, JSON.stringify(ledgerBeforeRefund));
    if (!ledgerBeforeRefund.ok) assert.fail("payment ledger query must succeed before refund");
    const repaymentProjection = (
      ledgerBeforeRefund.data.result as {
        payments: readonly Readonly<{ payment_id: string; refundable_cents: number }>[];
      }
    ).payments.find((payment) => payment.payment_id === repayment.payment_id);
    assert.equal(repaymentProjection?.refundable_cents, PAYABLE_CENTS - 600);
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
    const ledgerAfterRefund = await query("payment.ledger.list", {
      order_id: received.order_id,
    });
    assert.equal(ledgerAfterRefund.ok, true, JSON.stringify(ledgerAfterRefund));
    if (!ledgerAfterRefund.ok) assert.fail("payment ledger query must succeed after refund");
    const projectedRows = (
      ledgerAfterRefund.data.result as {
        payments: readonly Readonly<{
          payment_id: string;
          kind: string;
          signed_cents: number;
          refundable_cents: number;
        }>[];
      }
    ).payments;
    assert.equal(
      projectedRows.find((payment) => payment.payment_id === repayment.payment_id)
        ?.refundable_cents,
      PAYABLE_CENTS - 700,
    );
    const refundProjection = projectedRows.find(
      (payment) => payment.payment_id === refundResult.payment_id,
    );
    assert.equal(refundProjection?.kind, "refund");
    assert.equal(refundProjection?.signed_cents, -100);
    assert.equal(refundProjection?.refundable_cents, 0);
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

    const held = (
      await run("order.hold", {
        customer_name: "真实 PG 挂单",
        note: "刷新后恢复",
        urgent: true,
        lines: [
          {
            service_code: serviceCode,
            category_code: categoryCode,
            qty: 1,
            garments: [
              {
                color: "黑",
                brand: "挂单牌",
                defects: ["左袖破损"],
                accessories: ["衣架"],
                note: "保持低温",
                addon_codes: ["stain"],
              },
            ],
          },
        ],
      })
    ).data as { draft_id: string };
    const heldQuery = await query("order.get", { order_id: held.draft_id });
    assert.equal(heldQuery.ok, true, JSON.stringify(heldQuery));
    if (!heldQuery.ok) assert.fail("order.get must load the PG draft snapshot");
    const heldSnapshot = heldQuery.data.result as {
      status: string;
      ticket_no: string | null;
      paid_cents: number;
      note: string | null;
      lines: readonly { garments: readonly Record<string, unknown>[] }[];
      garments: readonly unknown[];
    };
    assert.equal(heldSnapshot.status, "draft");
    assert.equal(heldSnapshot.ticket_no, null);
    assert.equal(heldSnapshot.paid_cents, 0);
    assert.equal(heldSnapshot.note, "刷新后恢复");
    assert.deepEqual(heldSnapshot.lines[0]?.garments[0], {
      color: "黑",
      brand: "挂单牌",
      defects: ["左袖破损"],
      accessories: ["衣架"],
      note: "保持低温",
      addons: [{ code: "stain", name: "验收去渍", unit_price_cents: PRICING.addon_cents }],
    });
    assert.deepEqual(heldSnapshot.garments, []);
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

    const beforeClosedWrites = await readClosedWriteCounts(appPool);
    const denyClosed = async (name: string, input: unknown): Promise<void> => {
      const result = await dispatch(name, input);
      assert.equal(result.ok, false, `${name} must reject a closed business day`);
      if (result.ok) assert.fail(`${name} unexpectedly wrote after shift close`);
      assert.equal(result.error.code, "SHIFT_CLOSED", JSON.stringify(result));
    };
    await denyClosed("order.receive", {
      customer_phone: CUSTOMER_PHONE,
      lines: [{ service_code: serviceCode, category_code: categoryCode, qty: 1 }],
    });
    await denyClosed("payment.repay", {
      order_id: received.order_id,
      amount_cents: 1,
      method: "cash",
    });
    await denyClosed("member.topup", {
      account_id: member.account_id,
      amount_cents: 100,
      method: "cash",
    });
    await denyClosed("member.balance.pay", {
      account_id: member.account_id,
      order_id: received.order_id,
      amount_cents: 1,
    });
    assert.deepEqual(
      await readClosedWriteCounts(appPool),
      beforeClosedWrites,
      "closed-day order/payment/member attempts must leave business and audit rows unchanged",
    );
  } finally {
    try {
      await clearWorkdayFixture(adminPool);
    } finally {
      await appPool.end();
      await adminPool.end();
    }
  }
});
