import assert from "node:assert/strict";
import test from "node:test";

import { FakeSqlClient } from "../db/fake-client.js";
import type { TenantContext } from "../db/types.js";
import { MemoryOrderStore } from "../order/memory-store.js";
import type {
  FixedCouponDiscountInput,
  FixedCouponDiscountResult,
  OrderRecord,
} from "../order/types.js";
import { createMemoryMarketingStore } from "./memory-store.js";

const ID = Object.freeze({
  org: "a1000000-0000-4000-8000-000000000001",
  store: "a1000000-0000-4000-8000-000000000002",
  staff: "a1000000-0000-4000-8000-000000000003",
  customer: "a1000000-0000-4000-8000-000000000004",
  order: "a1000000-0000-4000-8000-000000000005",
  voucher: "a1000000-0000-4000-8000-000000000006",
  redemption: "a1000000-0000-4000-8000-000000000007",
});
const NOW = new Date("2026-08-13T02:00:00.000Z");
const DIGEST = "b".repeat(64);
const TENANT: TenantContext = Object.freeze({
  orgId: ID.org,
  storeId: ID.store,
  staffId: ID.staff,
});

function order(payableCents: number): OrderRecord {
  return Object.freeze({
    order_id: ID.order,
    org_id: ID.org,
    store_id: ID.store,
    ticket_no: "I9-MEMORY",
    pickup_code: "I9MEMORY",
    status: "open",
    customer_id: ID.customer,
    customer_phone: "19900000093",
    customer_name: "Memory customer",
    note: null,
    lines: Object.freeze([]),
    subtotal_cents: 8_000,
    original_cents: 8_000,
    discount_cents: 0,
    discount_source: "none",
    addon_cents: 0,
    urgent_cents: 0,
    freight_cents: 0,
    payable_cents: payableCents,
    paid_cents: 0,
    balance_cents: payableCents,
    created_at: Math.floor(NOW.getTime() / 1_000),
    updated_at: Math.floor(NOW.getTime() / 1_000),
    business_date: "2026-08-13",
    created_by_staff_id: ID.staff,
  });
}

class AuthorityChangingOrderStore extends MemoryOrderStore {
  private current = order(8_000);

  setPayableCents(payableCents: number): void {
    this.current = order(payableCents);
  }

  override async getOrder(orgId: string, storeId: string, orderId: string) {
    if (orgId === ID.org && storeId === ID.store && orderId === ID.order) return this.current;
    return super.getOrder(orgId, storeId, orderId);
  }

  override async applyFixedCouponDiscount(
    input: FixedCouponDiscountInput,
  ): Promise<FixedCouponDiscountResult | null> {
    const current = await this.getOrder(input.org_id, input.store_id, input.order_id);
    if (
      current === null ||
      current.status !== "open" ||
      current.customer_id !== input.customer_id ||
      current.paid_cents !== 0 ||
      current.discount_cents !== 0
    ) {
      return null;
    }
    const applied = Math.min(input.discount_cents, current.original_cents);
    if (applied <= 0 || applied > current.payable_cents) return null;
    const next = Object.freeze({
      ...current,
      discount_cents: applied,
      discount_source: "manual" as const,
      payable_cents: current.payable_cents - applied,
      balance_cents: current.payable_cents - applied,
      updated_at: input.at,
    });
    this.current = next;
    return Object.freeze({ order: next, applied_discount_cents: applied });
  }
}

test("memory redemption rejects an old frozen card after another authority completes", async () => {
  const orderStore = new AuthorityChangingOrderStore();
  const generatedIds = [ID.voucher, ID.redemption];
  const store = createMemoryMarketingStore({
    orderStore,
    newId: () => generatedIds.shift()!,
  });
  const client = new FakeSqlClient();
  const registrationInput = Object.freeze({
    provider: "meituan" as const,
    external_order_ref: "memory-mt-1",
    voucher_code_digest: DIGEST,
    voucher_code_last4: "BBBB",
    label: "Memory group buy",
    face_value_cents: 3_000,
    expires_at: "2026-09-13T02:00:00.000Z",
    reason: "memory registration",
    at: NOW,
  });
  const registrationPreview = await store.previewGroupBuyRegistration(
    client,
    TENANT,
    registrationInput,
  );
  assert.equal(registrationPreview.ok, true, JSON.stringify(registrationPreview));
  if (!registrationPreview.ok) return;
  const registration = await store.registerGroupBuyVoucher(client, TENANT, {
    ...registrationInput,
    frozenAuthority: registrationPreview.authority,
  });
  assert.equal(registration.ok, true, JSON.stringify(registration));

  const redemptionInput = Object.freeze({
    voucher_code_digest: DIGEST,
    order_id: ID.order,
    reason: "memory redemption",
    at: NOW,
  });
  const oldPreview = await store.previewGroupBuyRedemption(client, TENANT, redemptionInput);
  assert.equal(oldPreview.ok, true, JSON.stringify(oldPreview));
  if (!oldPreview.ok) return;
  orderStore.setPayableCents(7_000);
  const currentPreview = await store.previewGroupBuyRedemption(client, TENANT, redemptionInput);
  assert.equal(currentPreview.ok, true, JSON.stringify(currentPreview));
  if (!currentPreview.ok) return;
  assert.equal(oldPreview.authority.order_payable_before_cents, 8_000);
  assert.equal(currentPreview.authority.order_payable_before_cents, 7_000);

  const redeemed = await store.redeemGroupBuyVoucher(client, TENANT, {
    ...redemptionInput,
    frozenAuthority: currentPreview.authority,
  });
  assert.equal(redeemed.ok, true, JSON.stringify(redeemed));
  const staleCardResume = await store.redeemGroupBuyVoucher(client, TENANT, {
    ...redemptionInput,
    frozenAuthority: oldPreview.authority,
  });
  assert.deepEqual(staleCardResume, { ok: false, reason: "authority_drift" });
  const exactReplay = await store.redeemGroupBuyVoucher(client, TENANT, {
    ...redemptionInput,
    frozenAuthority: currentPreview.authority,
  });
  assert.equal(exactReplay.ok, true, JSON.stringify(exactReplay));
  if (exactReplay.ok) assert.equal(exactReplay.redemption.replayed, true);
});
