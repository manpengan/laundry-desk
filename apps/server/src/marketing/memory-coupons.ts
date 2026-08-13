import type {
  MarketingCouponBatch,
  MarketingCouponIssueAuthorityInput,
  MarketingCouponIssuePreview,
} from "@laundry/contracts";

import type { MemberBenefitsStore } from "../member-benefits/types.js";
import type { MemberStore } from "../member/types.js";
import type {
  MarketingAudienceSelection,
  MarketingAudienceSnapshotRecord,
  MarketingCampaignRecord,
  MarketingCouponIssueStoreInput,
  MarketingStore,
} from "./types.js";
import { sameCouponIssueAuthority } from "./coupon-authority.js";

type Access = Readonly<{
  newId: () => string;
  memberStore?: MemberStore;
  memberBenefits?: MemberBenefitsStore;
  getCampaign: (campaignId: string) => MarketingCampaignRecord | undefined;
  getSnapshot: (
    campaignId: string,
    snapshotId: string,
  ) => MarketingAudienceSnapshotRecord | undefined;
  preview: (
    campaign: MarketingCampaignRecord,
    expectedVersion: number,
    at: Date,
  ) => MarketingAudienceSelection | null;
  commitBudget: (campaignId: string, amountCents: number) => void;
}>;

type PreviewAuthority = Readonly<{
  preview: MarketingCouponIssuePreview;
  accountIds: readonly string[];
}>;

function semantic(input: MarketingCouponIssueAuthorityInput): string {
  return [
    input.campaign_id,
    input.expected_version,
    input.snapshot_id,
    input.coupon_definition_id,
  ].join(":");
}

async function authority(
  access: Access,
  input: MarketingCouponIssueAuthorityInput & Readonly<{ at: Date }>,
): Promise<
  | (Readonly<{ ok: true }> & PreviewAuthority)
  | Readonly<{
      ok: false;
      reason:
        | "missing"
        | "stale"
        | "campaign_inactive"
        | "campaign_outside_window"
        | "snapshot_stale"
        | "audience_drift"
        | "coupon_missing"
        | "coupon_retired";
    }>
> {
  const campaign = access.getCampaign(input.campaign_id);
  if (campaign === undefined) return Object.freeze({ ok: false, reason: "missing" });
  if (campaign.version !== input.expected_version) {
    return Object.freeze({ ok: false, reason: "stale" });
  }
  if (campaign.status !== "scheduled") {
    return Object.freeze({ ok: false, reason: "campaign_inactive" });
  }
  if (input.at < campaign.startsAt || input.at >= campaign.endsAt) {
    return Object.freeze({ ok: false, reason: "campaign_outside_window" });
  }
  const snapshot = access.getSnapshot(input.campaign_id, input.snapshot_id);
  if (snapshot === undefined || snapshot.campaignVersion !== campaign.version) {
    return Object.freeze({ ok: false, reason: "snapshot_stale" });
  }
  const evaluated = access.preview(campaign, campaign.version, input.at);
  if (
    evaluated === null ||
    evaluated.audienceDigest !== snapshot.audienceDigest ||
    evaluated.recipientCount !== snapshot.recipientCount
  ) {
    return Object.freeze({ ok: false, reason: "audience_drift" });
  }
  if (access.memberBenefits === undefined || access.memberStore === undefined) {
    return Object.freeze({ ok: false, reason: "coupon_missing" });
  }
  const catalog = await access.memberBenefits.getCatalog(true);
  const coupon = catalog.coupon_types.find(
    (candidate) => candidate.definition_id === input.coupon_definition_id,
  );
  if (coupon === undefined) return Object.freeze({ ok: false, reason: "coupon_missing" });
  if (coupon.status !== "active") return Object.freeze({ ok: false, reason: "coupon_retired" });
  const accounts = await Promise.all(
    evaluated.customerIds.map((customerId) => access.memberStore!.getByCustomer(customerId, 0)),
  );
  const accountIds = Object.freeze(
    accounts
      .filter((view) => view?.account.status === "active")
      .map((view) => view!.account.account_id),
  );
  const required = coupon.discount_cents * accountIds.length;
  return Object.freeze({
    ok: true,
    accountIds,
    preview: Object.freeze({
      campaign_id: campaign.campaignId,
      campaign_version: campaign.version,
      snapshot_id: snapshot.snapshotId,
      audience_digest: snapshot.audienceDigest,
      coupon_definition_id: coupon.definition_id,
      coupon_version: coupon.version,
      coupon_code: coupon.code,
      coupon_name: coupon.name,
      coupon_discount_cents: coupon.discount_cents,
      coupon_min_order_cents: coupon.min_order_cents,
      coupon_valid_days: coupon.valid_days,
      audience_recipient_count: snapshot.recipientCount,
      eligible_recipient_count: accountIds.length,
      ineligible_recipient_count: snapshot.recipientCount - accountIds.length,
      budget_required_cents: required,
      budget_remaining_cents: campaign.budgetLimitCents - campaign.budgetUsedCents,
      evaluated_at: input.at.toISOString(),
    }),
  });
}

export function createMemoryMarketingCouponOperations(
  access: Access,
): Pick<
  MarketingStore,
  | "previewCouponIssue"
  | "issueCoupons"
  | "getCouponBatch"
  | "previewCouponRedemptionReversal"
  | "reverseCouponRedemption"
> {
  let batches = new Map<string, MarketingCouponBatch>();
  let bySemantic = new Map<string, string>();
  return Object.freeze({
    async previewCouponIssue(_client, _tenant, input) {
      const resolved = await authority(access, input);
      return resolved.ok
        ? Object.freeze({ ok: true, preview: resolved.preview })
        : Object.freeze({ ok: false, reason: resolved.reason });
    },
    async issueCoupons(_client, tenant, input: MarketingCouponIssueStoreInput) {
      const key = semantic(input);
      const replayId = bySemantic.get(key);
      if (replayId !== undefined) {
        const replay = batches.get(replayId);
        if (replay === undefined) throw new Error("coupon batch replay index is corrupt");
        return Object.freeze({ ok: true, batch: Object.freeze({ ...replay, replayed: true }) });
      }
      const resolved = await authority(access, input);
      if (!resolved.ok) {
        return resolved.reason === "coupon_missing" || resolved.reason === "coupon_retired"
          ? Object.freeze({ ok: false, reason: "authority_drift" })
          : resolved;
      }
      if (!sameCouponIssueAuthority(input, resolved.preview, input.frozenAuthority)) {
        return Object.freeze({ ok: false, reason: "authority_drift" });
      }
      if (resolved.accountIds.length === 0) {
        return Object.freeze({ ok: false, reason: "eligibility_empty" });
      }
      if (resolved.preview.budget_required_cents > resolved.preview.budget_remaining_cents) {
        return Object.freeze({ ok: false, reason: "budget_exceeded" });
      }
      const benefits = access.memberBenefits;
      if (benefits === undefined) return Object.freeze({ ok: false, reason: "coupon_missing" });
      for (const accountId of resolved.accountIds) {
        const granted = await benefits.grantAsset({
          asset_kind: "coupon",
          account_id: accountId,
          definition_id: input.coupon_definition_id,
          reason: input.reason,
          store_id: tenant.storeId,
          staff_id: tenant.staffId,
          at: Math.floor(input.at.getTime() / 1_000),
          business_date: input.at.toISOString().slice(0, 10),
        });
        if (!granted.ok) throw new Error(`coupon grant preflight drifted: ${granted.reason}`);
      }
      const created: MarketingCouponBatch = Object.freeze({
        batch_id: access.newId(),
        campaign_id: input.campaign_id,
        campaign_version: input.expected_version,
        snapshot_id: input.snapshot_id,
        audience_digest: resolved.preview.audience_digest,
        coupon_definition_id: input.coupon_definition_id,
        coupon_code: resolved.preview.coupon_code,
        coupon_discount_cents: resolved.preview.coupon_discount_cents,
        audience_recipient_count: resolved.preview.audience_recipient_count,
        eligible_recipient_count: resolved.preview.eligible_recipient_count,
        granted_count: resolved.preview.eligible_recipient_count,
        budget_committed_cents: resolved.preview.budget_required_cents,
        created_at: input.at.toISOString(),
        replayed: false,
      });
      const next = new Map(batches);
      next.set(created.batch_id, created);
      batches = next;
      const nextSemantic = new Map(bySemantic);
      nextSemantic.set(key, created.batch_id);
      bySemantic = nextSemantic;
      access.commitBudget(input.campaign_id, created.budget_committed_cents);
      return Object.freeze({ ok: true, batch: created });
    },
    async getCouponBatch(_client, _tenant, batchId) {
      const found = batches.get(batchId);
      return found === undefined ? null : Object.freeze({ ...found, replayed: false });
    },
    async previewCouponRedemptionReversal() {
      return Object.freeze({ ok: false, reason: "not_campaign_coupon" });
    },
    async reverseCouponRedemption() {
      return Object.freeze({ ok: false, reason: "not_campaign_coupon" });
    },
  });
}
