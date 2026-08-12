import { randomUUID } from "node:crypto";

import type {
  MarketingCouponBatch,
  MarketingCouponIssueAuthorityInput,
  MarketingCouponIssuePreview,
} from "@laundry/contracts";

import type { SqlClient, TenantContext } from "../db/types.js";
import type {
  MarketingAudienceSelection,
  MarketingCampaignRecord,
  MarketingCouponBatchResult,
  MarketingCouponIssueStoreInput,
  MarketingCouponRejectReason,
  MarketingStore,
} from "./types.js";
import { sameCouponIssueAuthority } from "./coupon-authority.js";
import {
  previewPgMarketingCouponRedemption,
  reversePgMarketingCouponRedemption,
} from "./pg-coupon-reversal.js";

type CampaignAccess = Readonly<{
  load: (
    client: SqlClient,
    tenant: TenantContext,
    campaignId: string,
    lock: boolean,
  ) => Promise<MarketingCampaignRecord | null>;
  evaluate: (
    client: SqlClient,
    tenant: TenantContext,
    campaign: MarketingCampaignRecord,
    at: Date,
  ) => Promise<MarketingAudienceSelection>;
}>;

type CouponRow = Readonly<{
  id: string;
  code: string;
  name: string;
  discount_cents: number | string;
  min_order_cents: number | string;
  valid_days: number | string;
  version: number | string;
  status: string;
}>;
type SnapshotRow = Readonly<{
  id: string;
  campaign_id: string;
  campaign_version: number;
  audience_digest: string;
  recipient_count: number;
}>;
type AccountRow = Readonly<{ account_id: string; customer_id: string }>;
type BatchRow = Readonly<Omit<MarketingCouponBatch, "replayed" | "created_at">> &
  Readonly<{ created_at: Date | string }>;

type Authority = Readonly<{
  preview: MarketingCouponIssuePreview;
  coupon: CouponRow;
  accountIds: readonly string[];
}>;
type AuthorityResult =
  | (Readonly<{ ok: true }> & Authority)
  | Readonly<{ ok: false; reason: MarketingCouponRejectReason }>;

function integer(value: number | string, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} must be a safe integer`);
  return parsed;
}

function date(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error("invalid coupon evidence timestamp");
  return parsed.toISOString();
}

function batch(row: BatchRow, replayed: boolean): MarketingCouponBatch {
  return Object.freeze({ ...row, created_at: date(row.created_at), replayed });
}

async function readBatch(
  client: SqlClient,
  tenant: TenantContext,
  where: Readonly<{ batchId?: string; semantic?: MarketingCouponIssueAuthorityInput }>,
): Promise<MarketingCouponBatch | null> {
  const semantic = where.semantic;
  const result = await client.query<BatchRow>(
    `SELECT id::text AS batch_id, campaign_id::text, campaign_version,
            audience_snapshot_id::text AS snapshot_id, audience_digest,
            coupon_definition_id::text, coupon_code, coupon_discount_cents,
            audience_recipient_count, eligible_recipient_count, granted_count,
            budget_committed_cents, created_at
       FROM campaign_coupon_batches
      WHERE org_id=$1::uuid AND store_id=$2::uuid
        AND ($3::uuid IS NULL OR id=$3::uuid)
        AND ($4::uuid IS NULL OR (campaign_id=$4::uuid AND campaign_version=$5
          AND audience_snapshot_id=$6::uuid AND coupon_definition_id=$7::uuid))
      LIMIT 1`,
    [
      tenant.orgId,
      tenant.storeId,
      where.batchId ?? null,
      semantic?.campaign_id ?? null,
      semantic?.expected_version ?? null,
      semantic?.snapshot_id ?? null,
      semantic?.coupon_definition_id ?? null,
    ],
  );
  return result.rows[0] === undefined ? null : batch(result.rows[0], semantic !== undefined);
}

async function resolveAuthority(
  client: SqlClient,
  tenant: TenantContext,
  input: MarketingCouponIssueAuthorityInput & Readonly<{ at: Date }>,
  lock: boolean,
  access: CampaignAccess,
): Promise<AuthorityResult> {
  const campaign = await access.load(client, tenant, input.campaign_id, lock);
  if (campaign === null) return Object.freeze({ ok: false, reason: "missing" });
  if (campaign.version !== input.expected_version) {
    return Object.freeze({ ok: false, reason: "stale" });
  }
  if (campaign.status !== "scheduled") {
    return Object.freeze({ ok: false, reason: "campaign_inactive" });
  }
  if (input.at < campaign.startsAt || input.at >= campaign.endsAt) {
    return Object.freeze({ ok: false, reason: "campaign_outside_window" });
  }
  const snapshotResult = await client.query<SnapshotRow>(
    `SELECT id::text, campaign_id::text, campaign_version, audience_digest, recipient_count
       FROM campaign_audience_snapshots
      WHERE org_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
      ${lock ? "FOR SHARE" : ""}`,
    [tenant.orgId, tenant.storeId, input.snapshot_id],
  );
  const snapshot = snapshotResult.rows[0];
  if (
    snapshot === undefined ||
    snapshot.campaign_id !== campaign.campaignId ||
    snapshot.campaign_version !== campaign.version
  ) {
    return Object.freeze({ ok: false, reason: "snapshot_stale" });
  }
  const evaluated = await access.evaluate(client, tenant, campaign, input.at);
  if (
    evaluated.audienceDigest !== snapshot.audience_digest ||
    evaluated.recipientCount !== snapshot.recipient_count
  ) {
    return Object.freeze({ ok: false, reason: "audience_drift" });
  }
  const couponResult = await client.query<CouponRow>(
    `SELECT id::text, code, name, discount_cents, min_order_cents, valid_days, version, status
       FROM coupons WHERE org_id=$1::uuid AND id=$2::uuid ${lock ? "FOR SHARE" : ""}`,
    [tenant.orgId, input.coupon_definition_id],
  );
  const coupon = couponResult.rows[0];
  if (coupon === undefined) return Object.freeze({ ok: false, reason: "coupon_missing" });
  if (coupon.status !== "active") return Object.freeze({ ok: false, reason: "coupon_retired" });
  const accountResult = await client.query<AccountRow>(
    `SELECT id::text AS account_id, customer_id::text
       FROM member_accounts
      WHERE org_id=$1::uuid AND customer_id=ANY($2::uuid[]) AND status='active'
      ORDER BY customer_id ${lock ? "FOR UPDATE" : ""}`,
    [tenant.orgId, evaluated.customerIds],
  );
  const accountIds = Object.freeze(accountResult.rows.map((row) => row.account_id));
  const discount = integer(coupon.discount_cents, "coupon discount");
  const required = discount * accountIds.length;
  if (!Number.isSafeInteger(required)) throw new Error("coupon batch budget is not a safe integer");
  const remaining = campaign.budgetLimitCents - campaign.budgetUsedCents;
  const preview = Object.freeze({
    campaign_id: campaign.campaignId,
    campaign_version: campaign.version,
    snapshot_id: snapshot.id,
    audience_digest: snapshot.audience_digest,
    coupon_definition_id: coupon.id,
    coupon_version: integer(coupon.version, "coupon version"),
    coupon_code: coupon.code,
    coupon_name: coupon.name,
    coupon_discount_cents: discount,
    coupon_min_order_cents: integer(coupon.min_order_cents, "coupon minimum"),
    coupon_valid_days: integer(coupon.valid_days, "coupon validity"),
    audience_recipient_count: snapshot.recipient_count,
    eligible_recipient_count: accountIds.length,
    ineligible_recipient_count: snapshot.recipient_count - accountIds.length,
    budget_required_cents: required,
    budget_remaining_cents: remaining,
    evaluated_at: input.at.toISOString(),
  });
  return Object.freeze({ ok: true, preview, coupon, accountIds });
}

function databaseReason(error: unknown): "budget_exceeded" | "stale" | null {
  if (typeof error !== "object" || error === null) return null;
  const text = `${String(Reflect.get(error, "message") ?? "")} ${String(
    Reflect.get(error, "constraint") ?? "",
  )}`;
  if (text.includes("MARKETING_BUDGET_EXCEEDED")) return "budget_exceeded";
  return text.includes("campaign_coupon_batches_semantic_uidx") ? "stale" : null;
}

async function issue(
  client: SqlClient,
  tenant: TenantContext,
  input: MarketingCouponIssueStoreInput,
  newId: () => string,
  access: CampaignAccess,
): Promise<MarketingCouponBatchResult> {
  const replay = await readBatch(client, tenant, { semantic: input });
  if (replay !== null) return Object.freeze({ ok: true, batch: replay });
  const authority = await resolveAuthority(client, tenant, input, true, access);
  if (!authority.ok) {
    return authority.reason === "coupon_missing" || authority.reason === "coupon_retired"
      ? Object.freeze({ ok: false, reason: "authority_drift" })
      : authority;
  }
  if (!sameCouponIssueAuthority(input, authority.preview, input.frozenAuthority)) {
    return Object.freeze({ ok: false, reason: "authority_drift" });
  }
  if (authority.preview.eligible_recipient_count === 0) {
    return Object.freeze({ ok: false, reason: "eligibility_empty" });
  }
  if (authority.preview.budget_required_cents > authority.preview.budget_remaining_cents) {
    return Object.freeze({ ok: false, reason: "budget_exceeded" });
  }
  const raced = await readBatch(client, tenant, { semantic: input });
  if (raced !== null) return Object.freeze({ ok: true, batch: raced });
  const batchId = newId();
  const grantIds = authority.accountIds.map(() => newId());
  const mappingIds = authority.accountIds.map(() => newId());
  try {
    const inserted = await client.query<Readonly<{ created_at: Date | string }>>(
      `INSERT INTO campaign_coupon_batches (
         id, org_id, store_id, campaign_id, campaign_version, audience_snapshot_id,
         audience_digest, coupon_definition_id, coupon_version, coupon_code, coupon_name,
         coupon_discount_cents, coupon_min_order_cents, coupon_valid_days,
         audience_recipient_count, eligible_recipient_count, granted_count,
         budget_committed_cents, reason, created_by_staff_id, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16,$17,$18,$19,$20)
       RETURNING created_at`,
      [
        batchId,
        tenant.orgId,
        tenant.storeId,
        input.campaign_id,
        input.expected_version,
        input.snapshot_id,
        authority.preview.audience_digest,
        input.coupon_definition_id,
        authority.preview.coupon_version,
        authority.coupon.code,
        authority.coupon.name,
        authority.preview.coupon_discount_cents,
        integer(authority.coupon.min_order_cents, "coupon minimum"),
        integer(authority.coupon.valid_days, "coupon validity"),
        authority.preview.audience_recipient_count,
        authority.preview.eligible_recipient_count,
        authority.preview.budget_required_cents,
        input.reason,
        tenant.staffId,
        input.at.toISOString(),
      ],
    );
    const businessDate = await client.query<Readonly<{ value: string }>>(
      `SELECT (($3::timestamptz AT TIME ZONE timezone)::date)::text AS value
         FROM stores WHERE org_id=$1::uuid AND id=$2::uuid`,
      [tenant.orgId, tenant.storeId, input.at.toISOString()],
    );
    const issuedOn = businessDate.rows[0]?.value;
    if (issuedOn === undefined) throw new Error("store timezone is unavailable");
    await client.query(
      `INSERT INTO coupon_grants (
         id, org_id, account_id, definition_id, code, name, discount_cents,
         min_order_cents, granted_on, expires_on, granted_at,
         granted_store_id, granted_by_staff_id, reason
       ) SELECT issued.grant_id, $3::uuid, issued.account_id, $4::uuid, $5, $6, $7,
                $8, $9::date, $9::date + $10::integer,
                $11::timestamptz, $12::uuid, $13::uuid, $14
           FROM unnest($1::uuid[], $2::uuid[]) AS issued(grant_id, account_id)`,
      [
        grantIds,
        authority.accountIds,
        tenant.orgId,
        input.coupon_definition_id,
        authority.coupon.code,
        authority.coupon.name,
        authority.preview.coupon_discount_cents,
        integer(authority.coupon.min_order_cents, "coupon minimum"),
        issuedOn,
        integer(authority.coupon.valid_days, "coupon validity"),
        input.at.toISOString(),
        tenant.storeId,
        tenant.staffId,
        input.reason,
      ],
    );
    await client.query(
      `INSERT INTO campaign_coupon_grants (
         id, org_id, store_id, batch_id, campaign_id, audience_snapshot_id,
         coupon_grant_id, account_id, created_at
       ) SELECT mapped.mapping_id, $4::uuid, $5::uuid, $6::uuid, $7::uuid, $8::uuid,
                mapped.grant_id, mapped.account_id, $9::timestamptz
           FROM unnest($1::uuid[], $2::uuid[], $3::uuid[])
             AS mapped(mapping_id, grant_id, account_id)`,
      [
        mappingIds,
        grantIds,
        authority.accountIds,
        tenant.orgId,
        tenant.storeId,
        batchId,
        input.campaign_id,
        input.snapshot_id,
        input.at.toISOString(),
      ],
    );
    await client.query(
      `INSERT INTO campaign_budget_ledger
         (id, org_id, store_id, campaign_id, kind, source_id, amount_cents, staff_id, at)
       VALUES ($1,$2,$3,$4,'coupon_issue',$5,$6,$7,$8)`,
      [
        newId(),
        tenant.orgId,
        tenant.storeId,
        input.campaign_id,
        batchId,
        authority.preview.budget_required_cents,
        tenant.staffId,
        input.at.toISOString(),
      ],
    );
    return Object.freeze({
      ok: true,
      batch: Object.freeze({
        batch_id: batchId,
        campaign_id: input.campaign_id,
        campaign_version: input.expected_version,
        snapshot_id: input.snapshot_id,
        audience_digest: authority.preview.audience_digest,
        coupon_definition_id: input.coupon_definition_id,
        coupon_code: authority.coupon.code,
        coupon_discount_cents: authority.preview.coupon_discount_cents,
        audience_recipient_count: authority.preview.audience_recipient_count,
        eligible_recipient_count: authority.preview.eligible_recipient_count,
        granted_count: authority.preview.eligible_recipient_count,
        budget_committed_cents: authority.preview.budget_required_cents,
        created_at: date(inserted.rows[0]?.created_at ?? input.at),
        replayed: false,
      }),
    });
  } catch (error) {
    const reason = databaseReason(error);
    if (reason !== null) return Object.freeze({ ok: false, reason });
    throw error;
  }
}

export function createPgMarketingCouponOperations(
  access: CampaignAccess,
  newId: () => string = randomUUID,
): Pick<
  MarketingStore,
  | "previewCouponIssue"
  | "issueCoupons"
  | "getCouponBatch"
  | "previewCouponRedemptionReversal"
  | "reverseCouponRedemption"
> {
  return Object.freeze({
    previewCouponIssue: (client, tenant, input) =>
      resolveAuthority(client, tenant, input, false, access),
    issueCoupons: (client, tenant, input) => issue(client, tenant, input, newId, access),
    getCouponBatch: (client, tenant, batchId) => readBatch(client, tenant, { batchId }),
    previewCouponRedemptionReversal: (client, tenant, redemptionId) =>
      previewPgMarketingCouponRedemption(client, tenant, redemptionId),
    reverseCouponRedemption: (client, tenant, input) =>
      reversePgMarketingCouponRedemption(client, tenant, input, newId),
  });
}
