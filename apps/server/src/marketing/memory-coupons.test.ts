import assert from "node:assert/strict";
import test from "node:test";

import { FakeSqlClient } from "../db/fake-client.js";
import type { TenantContext } from "../db/types.js";
import { createMemoryMemberBenefitsStore } from "../member-benefits/memory-store.js";
import { createMemoryMemberStore } from "../member/memory-store.js";
import { createMemoryOrderStore } from "../order/memory-store.js";
import { couponIssueConfirmationSummary } from "./coupon-authority.js";
import { createMemoryMarketingStore } from "./memory-store.js";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STORE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const STAFF = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CUSTOMER_A = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const CUSTOMER_B = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const NOW = new Date("2026-08-13T02:00:00.000Z");
const TENANT: TenantContext = Object.freeze({ orgId: ORG, storeId: STORE, staffId: STAFF });

function ids(prefix: string) {
  let value = 1;
  return () => `${prefix}0000000-0000-4000-8000-${String(value++).padStart(12, "0")}`;
}

test("memory campaign issue reuses the member coupon ledger and is semantically idempotent", async () => {
  const memberStore = createMemoryMemberStore({
    customerIds: [CUSTOMER_A, CUSTOMER_B],
    newId: ids("1"),
  });
  const opened = await memberStore.openAccount({
    customer_id: CUSTOMER_A,
    store_id: STORE,
    at: Math.floor(NOW.getTime() / 1_000),
  });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const benefits = createMemoryMemberBenefitsStore({
    orgId: ORG,
    memberStore,
    orderStore: createMemoryOrderStore(),
    newId: ids("2"),
  });
  const coupon = await benefits.upsertDefinition({
    staff_id: STAFF,
    at: Math.floor(NOW.getTime() / 1_000),
    definition: {
      kind: "coupon_type",
      expected_version: 0,
      code: "return_5",
      name: "回访五元券",
      discount_cents: 500,
      min_order_cents: 2_000,
      valid_days: 30,
      status: "active",
    },
  });
  assert.equal(coupon.ok, true);
  if (!coupon.ok || coupon.value.definition.kind !== "coupon_type") return;
  const store = createMemoryMarketingStore({
    memberStore,
    memberBenefits: benefits,
    newId: ids("3"),
    customers: [CUSTOMER_A, CUSTOMER_B].map((customerId) =>
      Object.freeze({
        customerId,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        lastOrderAt: null,
        activeMember: customerId === CUSTOMER_A,
        tierId: null,
        tierValidUntil: null,
      }),
    ),
  });
  const client = new FakeSqlClient();
  const created = await store.setCampaign(client, TENANT, {
    expected_version: 0,
    code: "august_return",
    name: "八月回访",
    status: "scheduled",
    starts_at: "2026-08-13T00:00:00.000Z",
    ends_at: "2026-08-14T00:00:00.000Z",
    budget_limit_cents: 10_000,
    recipient_limit: 2,
    audience_rule: {
      customer_age: { kind: "any" },
      order_activity: { kind: "any" },
      membership: { kind: "any" },
    },
    at: NOW,
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const audience = await store.previewAudience(client, TENANT, created.after.campaignId, 1, NOW);
  assert.notEqual(audience, null);
  if (audience === null) return;
  const frozen = await store.freezeAudience(client, TENANT, {
    campaignId: created.after.campaignId,
    expectedVersion: 1,
    previewDigest: audience.audienceDigest,
    expectedRecipientCount: audience.recipientCount,
    at: NOW,
  });
  assert.equal(frozen.ok, true);
  if (!frozen.ok) return;
  const input = Object.freeze({
    campaign_id: created.after.campaignId,
    expected_version: 1,
    snapshot_id: frozen.snapshot.snapshotId,
    coupon_definition_id: coupon.value.definition.definition_id,
    reason: "八月回访",
    at: NOW,
  });
  const preview = await store.previewCouponIssue(client, TENANT, input);
  assert.equal(preview.ok, true);
  if (!preview.ok) return;
  assert.equal(preview.preview.audience_recipient_count, 2);
  assert.equal(preview.preview.eligible_recipient_count, 1);
  assert.equal(preview.preview.ineligible_recipient_count, 1);

  const confirmedInput = Object.freeze({
    ...input,
    frozenAuthority: couponIssueConfirmationSummary(input, preview.preview),
  });
  const issued = await store.issueCoupons(client, TENANT, confirmedInput);
  assert.equal(issued.ok, true);
  if (!issued.ok) return;
  const replayed = await store.issueCoupons(client, TENANT, confirmedInput);
  assert.equal(replayed.ok, true);
  if (!replayed.ok) return;
  assert.equal(replayed.batch.batch_id, issued.batch.batch_id);
  assert.equal(replayed.batch.replayed, true);
  const wallet = await benefits.getBenefits({
    customer_id: CUSTOMER_A,
    include_expired: true,
    business_date: "2026-08-13",
  });
  assert.equal(wallet.ok, true);
  if (!wallet.ok) return;
  assert.equal(wallet.value.coupons.length, 1);
  assert.equal(wallet.value.coupons[0]?.definition_id, coupon.value.definition.definition_id);
  const campaigns = await store.listCampaigns(client, TENANT, 10);
  assert.equal(campaigns[0]?.budgetUsedCents, 500);
});
