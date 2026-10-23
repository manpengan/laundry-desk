import assert from "node:assert/strict";
import test from "node:test";
import { resolvePgUrls } from "../db/pg-pool.js";
import { createCancellationFixture } from "../member/pg-cancellation-test-support.js";
import {
  CANCEL_AT,
  CANCEL_DAY,
  seedCancellationOrder,
} from "../member/order-cancellation-test-support.js";
import { createPgMemberBenefitsStore } from "./pg-store.js";
import type { MemberBenefitsStore } from "./types.js";

const urls = process.env.LAUNDRY_USE_LOCAL_PG === "1" ? resolvePgUrls() : null;
const maybe = urls === null ? test.skip : test;

maybe(
  "PG refunded payment history refuses coupon without changing order, asset or later payment replay",
  async () => {
    assert.ok(urls);
    const f = await createCancellationFixture(urls);
    const evidence = {
      store_id: f.tenant.storeId,
      staff_id: f.tenant.staffId,
      at: CANCEL_AT,
      business_date: CANCEL_DAY,
    };
    const benefit = <T>(run: (store: MemberBenefitsStore) => Promise<T>) =>
      f.transaction((_member, client) => run(createPgMemberBenefitsStore(client, f.tenant)));
    try {
      const definition = await benefit((store) =>
        store.upsertDefinition({
          staff_id: f.tenant.staffId,
          at: CANCEL_AT,
          definition: {
            kind: "coupon_type",
            expected_version: 0,
            code: "refund",
            name: "合成退款回归券",
            discount_cents: 500,
            min_order_cents: 1_000,
            valid_days: 30,
            status: "active",
          },
        }),
      );
      assert.ok(definition.ok);
      assert.ok(definition.value.definition.kind === "coupon_type");
      const definitionId = definition.value.definition.definition_id;
      const grant = await benefit((store) =>
        store.grantAsset({
          ...evidence,
          asset_kind: "coupon",
          account_id: f.accountId,
          definition_id: definitionId,
          reason: "合成回归",
        }),
      );
      assert.ok(grant.ok);
      const assetId = grant.value.benefits.coupons[0]!.asset_id;
      for (const amount of [1_000, 4_200]) {
        const orderId = await seedCancellationOrder(f.order, f.tenant, f.customerId);
        const payment = await f.order.appendPayment!({
          ...evidence,
          org_id: f.tenant.orgId,
          order_id: orderId,
          amount_cents: amount,
          kind: "pay",
          method: "cash",
          note: null,
        });
        assert.ok(payment);
        assert.ok(
          await f.order.appendRefund!({
            ...evidence,
            org_id: f.tenant.orgId,
            order_id: orderId,
            amount_cents: amount,
            expected_method: "cash",
            ref_payment_id: payment.payment.payment_id,
            reason: "退款",
          }),
        );
        const before = await f.order.getOrder(f.tenant.orgId, f.tenant.storeId, orderId);
        const ledger = await f.order.listPayments!(f.tenant.orgId, f.tenant.storeId, orderId);
        const refused = await benefit((store) =>
          store.consumeCoupon({ ...evidence, asset_id: assetId, order_id: orderId }),
        );
        assert.deepEqual(refused, { ok: false, reason: "coupon_payment_history" });
        assert.deepEqual(await f.order.getOrder(f.tenant.orgId, f.tenant.storeId, orderId), before);
        assert.deepEqual(
          await f.order.listPayments!(f.tenant.orgId, f.tenant.storeId, orderId),
          ledger,
        );
        assert.ok(
          await f.order.appendPayment!({
            ...evidence,
            org_id: f.tenant.orgId,
            order_id: orderId,
            amount_cents: 4_200,
            kind: "pay",
            method: "cash",
            note: null,
          }),
        );
        assert.ok(
          await f.order.cancelOpenOrder!(
            f.tenant.orgId,
            f.tenant.storeId,
            orderId,
            "仍能撤单",
            f.tenant.staffId,
            CANCEL_AT,
            CANCEL_DAY,
          ),
        );
      }
      // The rejected coupon remains available on the original never-paid order.
      assert.equal(
        (
          await benefit((store) =>
            store.consumeCoupon({ ...evidence, asset_id: assetId, order_id: f.orderId }),
          )
        ).ok,
        true,
      );
      assert.equal(
        (await f.order.getOrder(f.tenant.orgId, f.tenant.storeId, f.orderId))?.payable_cents,
        3_700,
      );
    } finally {
      for (const table of ["coupon_redemptions", "coupon_grants", "coupons"]) {
        await f.adminPool.query(`DELETE FROM ${table} WHERE org_id = $1`, [f.tenant.orgId]);
      }
      await f.cleanup();
    }
  },
);
