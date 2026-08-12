import { randomUUID } from "node:crypto";

import { MarketingAudienceRuleSchema } from "@laundry/contracts";

import type { SqlClient, TenantContext } from "../db/types.js";
import { audienceDigest } from "./audience.js";
import { createPgMarketingCouponOperations } from "./pg-coupons.js";
import type {
  MarketingAudienceSnapshotRecord,
  MarketingAudienceEvaluation,
  MarketingAudienceSelection,
  MarketingCampaignRecord,
  MarketingStore,
} from "./types.js";

type CampaignRow = Readonly<{
  id: string;
  code: string;
  name: string;
  status: MarketingCampaignRecord["status"];
  starts_at: Date | string;
  ends_at: Date | string;
  audience_rule: unknown;
  audience_rule_sha256: string;
  recipient_limit: number;
  budget_limit_cents: number;
  budget_used_cents: number | string;
  version: number;
  updated_at: Date | string;
}>;

type SnapshotRow = Readonly<{
  id: string;
  campaign_version: number;
  audience_rule_sha256: string;
  audience_digest: string;
  recipient_count: number;
  created_at: Date | string;
}>;

const CAMPAIGN_BASE_SELECT = `
  SELECT campaign.id, campaign.code, campaign.name, campaign.status,
         campaign.starts_at, campaign.ends_at, campaign.audience_rule,
         campaign.audience_rule_sha256, campaign.recipient_limit,
         campaign.budget_limit_cents, campaign.version, campaign.updated_at`;

const CAMPAIGN_SELECT = `${CAMPAIGN_BASE_SELECT},
         COALESCE((SELECT sum(ledger.amount_cents)
                     FROM campaign_budget_ledger ledger
                    WHERE ledger.org_id = campaign.org_id
                      AND ledger.store_id = campaign.store_id
                      AND ledger.campaign_id = campaign.id), 0)::bigint AS budget_used_cents
    FROM campaigns campaign`;

function date(value: Date | string): Date {
  return value instanceof Date ? new Date(value) : new Date(value);
}

function integer(value: number | string, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} must be a safe integer`);
  return parsed;
}

function campaign(row: CampaignRow): MarketingCampaignRecord {
  return Object.freeze({
    campaignId: row.id,
    code: row.code,
    name: row.name,
    status: row.status,
    startsAt: date(row.starts_at),
    endsAt: date(row.ends_at),
    audienceRule: MarketingAudienceRuleSchema.parse(row.audience_rule),
    audienceRuleSha256: row.audience_rule_sha256,
    recipientLimit: row.recipient_limit,
    budgetLimitCents: row.budget_limit_cents,
    budgetUsedCents: integer(row.budget_used_cents, "campaign budget used"),
    version: row.version,
    updatedAt: date(row.updated_at),
  });
}

function snapshot(row: SnapshotRow): MarketingAudienceSnapshotRecord {
  return Object.freeze({
    snapshotId: row.id,
    campaignVersion: row.campaign_version,
    audienceRuleSha256: row.audience_rule_sha256,
    audienceDigest: row.audience_digest,
    recipientCount: row.recipient_count,
    createdAt: date(row.created_at),
  });
}

export async function loadCampaign(
  client: SqlClient,
  tenant: TenantContext,
  campaignId: string,
  lock: boolean,
): Promise<MarketingCampaignRecord | null> {
  if (lock) {
    const locked = await client.query<Omit<CampaignRow, "budget_used_cents">>(
      `${CAMPAIGN_BASE_SELECT}
         FROM campaigns campaign
        WHERE campaign.org_id = $1 AND campaign.store_id = $2 AND campaign.id = $3
        FOR UPDATE OF campaign`,
      [tenant.orgId, tenant.storeId, campaignId],
    );
    const row = locked.rows[0];
    if (row === undefined) return null;
    const budget = await client.query<Readonly<{ budget_used_cents: number | string }>>(
      `SELECT COALESCE(sum(amount_cents), 0)::bigint AS budget_used_cents
         FROM campaign_budget_ledger
        WHERE org_id=$1::uuid AND store_id=$2::uuid AND campaign_id=$3::uuid`,
      [tenant.orgId, tenant.storeId, campaignId],
    );
    return campaign(
      Object.freeze({
        ...row,
        budget_used_cents: budget.rows[0]?.budget_used_cents ?? 0,
      }),
    );
  }
  const result = await client.query<CampaignRow>(
    `${CAMPAIGN_SELECT}
      WHERE campaign.org_id = $1 AND campaign.store_id = $2 AND campaign.id = $3
      `,
    [tenant.orgId, tenant.storeId, campaignId],
  );
  return result.rows[0] === undefined ? null : campaign(result.rows[0]);
}

export async function evaluateAudienceSelection(
  client: SqlClient,
  tenant: TenantContext,
  value: MarketingCampaignRecord,
  at: Date,
): Promise<MarketingAudienceSelection> {
  const rule = value.audienceRule;
  const ageDays = rule.customer_age.kind === "within_days" ? rule.customer_age.days : null;
  const activityDays = rule.order_activity.kind === "within_days" ? rule.order_activity.days : null;
  const tierIds = rule.membership.kind === "tiers" ? rule.membership.tier_ids : [];
  const result = await client.query<{ customer_id: string; matched_count: number }>(
    `SELECT customer_row.id::text AS customer_id,
            count(*) OVER()::integer AS matched_count
       FROM customers customer_row
       JOIN stores store_row ON store_row.org_id = customer_row.org_id AND store_row.id = $2
       LEFT JOIN member_accounts account
         ON account.org_id = customer_row.org_id
        AND account.customer_id = customer_row.id
        AND account.status = 'active'
       LEFT JOIN member_memberships membership
         ON membership.org_id = account.org_id AND membership.account_id = account.id
      WHERE customer_row.org_id = $1
        AND customer_row.merged_into_id IS NULL
        AND customer_row.anonymized_at IS NULL
        AND ($4 = 'any' OR customer_row.created_at >= $3::timestamptz - make_interval(days => $5))
        AND (
          $6 = 'any'
          OR ($6 = 'none' AND NOT EXISTS (
            SELECT 1 FROM orders order_row
             WHERE order_row.org_id = $1 AND order_row.store_id = $2
               AND order_row.customer_id = customer_row.id
          ))
          OR ($6 = 'within_days' AND EXISTS (
            SELECT 1 FROM orders order_row
             WHERE order_row.org_id = $1 AND order_row.store_id = $2
               AND order_row.customer_id = customer_row.id
               AND order_row.created_at >= $3::timestamptz - make_interval(days => $7)
          ))
        )
        AND (
          $8 = 'any'
          OR ($8 = 'member' AND account.id IS NOT NULL)
          OR ($8 = 'non_member' AND account.id IS NULL)
          OR ($8 = 'tiers' AND account.id IS NOT NULL
            AND membership.tier_id = ANY($9::uuid[])
            AND membership.valid_until >= ($3::timestamptz AT TIME ZONE store_row.timezone)::date)
        )
      ORDER BY customer_row.id
      LIMIT $10`,
    [
      tenant.orgId,
      tenant.storeId,
      at.toISOString(),
      rule.customer_age.kind,
      ageDays,
      rule.order_activity.kind,
      activityDays,
      rule.membership.kind,
      tierIds,
      value.recipientLimit,
    ],
  );
  const customerIds = result.rows.map((row) => row.customer_id);
  return Object.freeze({
    campaign: value,
    audienceDigest: audienceDigest(
      value.campaignId,
      value.version,
      value.audienceRuleSha256,
      customerIds,
    ),
    customerIds: Object.freeze(customerIds),
    recipientCount: customerIds.length,
    matchedCount: result.rows[0]?.matched_count ?? 0,
    evaluatedAt: new Date(at),
  });
}

function publicEvaluation(value: MarketingAudienceSelection): MarketingAudienceEvaluation {
  return Object.freeze({
    campaign: value.campaign,
    audienceDigest: value.audienceDigest,
    recipientCount: value.recipientCount,
    matchedCount: value.matchedCount,
    evaluatedAt: value.evaluatedAt,
  });
}

function errorText(error: unknown): string {
  if (typeof error !== "object" || error === null) return "";
  const message = Reflect.get(error, "message");
  const constraint = Reflect.get(error, "constraint");
  return `${typeof message === "string" ? message : ""} ${
    typeof constraint === "string" ? constraint : ""
  }`;
}

export function createPgMarketingStore(
  options: Readonly<{ newId?: () => string }> = {},
): MarketingStore {
  const newId = options.newId ?? randomUUID;
  return Object.freeze({
    ...createPgMarketingCouponOperations(
      Object.freeze({ load: loadCampaign, evaluate: evaluateAudienceSelection }),
      newId,
    ),
    async setCampaign(client, tenant, input) {
      const id = input.campaign_id ?? newId();
      const before =
        input.campaign_id === undefined ? null : await loadCampaign(client, tenant, id, false);
      if (input.expected_version > 0 && before === null) {
        return Object.freeze({ ok: false as const, reason: "missing" as const });
      }
      if (before !== null && input.code !== before.code) {
        return Object.freeze({ ok: false as const, reason: "conflict" as const });
      }
      if (before?.status === "cancelled" || (before !== null && input.at >= before.endsAt)) {
        return Object.freeze({ ok: false as const, reason: "terminal" as const });
      }
      try {
        const params = [
          id,
          tenant.orgId,
          tenant.storeId,
          input.code,
          input.name,
          input.status,
          input.starts_at,
          input.ends_at,
          JSON.stringify(input.audience_rule),
          "0".repeat(64),
          input.recipient_limit,
          input.budget_limit_cents,
          tenant.staffId,
          input.at.toISOString(),
          input.expected_version,
        ];
        const result =
          input.expected_version === 0
            ? await client.query<{ id: string }>(
                `INSERT INTO campaigns
                 (id, org_id, store_id, code, name, status, starts_at, ends_at,
                  audience_rule, audience_rule_sha256, recipient_limit, budget_limit_cents,
                  version, created_by_staff_id, created_at, updated_by_staff_id, updated_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,1,$13,$14,$13,$14)
               RETURNING id`,
                params.slice(0, 14),
              )
            : await client.query<{ id: string }>(
                `UPDATE campaigns SET name=$5, status=$6, starts_at=$7, ends_at=$8,
                      audience_rule=$9::jsonb, audience_rule_sha256=$10,
                      recipient_limit=$11, budget_limit_cents=$12,
                      version=version+1, updated_by_staff_id=$13, updated_at=$14
                WHERE org_id=$2 AND store_id=$3 AND id=$1 AND version=$15
                RETURNING id`,
                params,
              );
        if (result.rowCount !== 1) {
          return Object.freeze({ ok: false as const, reason: "stale" as const });
        }
        const after = await loadCampaign(client, tenant, id, false);
        if (after === null)
          return Object.freeze({ ok: false as const, reason: "missing" as const });
        return Object.freeze({ ok: true as const, before, after });
      } catch (error) {
        const text = errorText(error);
        if (text.includes("MARKETING_CAMPAIGN_TERMINAL")) {
          return Object.freeze({ ok: false as const, reason: "terminal" as const });
        }
        if (text.includes("campaigns_code_uidx") || text.includes("duplicate key")) {
          return Object.freeze({ ok: false as const, reason: "conflict" as const });
        }
        throw error;
      }
    },
    async listCampaigns(client, tenant, limit) {
      const result = await client.query<CampaignRow>(
        `${CAMPAIGN_SELECT}
          WHERE campaign.org_id=$1 AND campaign.store_id=$2
          ORDER BY campaign.updated_at DESC, campaign.id LIMIT $3`,
        [tenant.orgId, tenant.storeId, limit],
      );
      return Object.freeze(result.rows.map(campaign));
    },
    async getCampaign(client, tenant, campaignId) {
      const value = await loadCampaign(client, tenant, campaignId, false);
      if (value === null) return null;
      const result = await client.query<SnapshotRow>(
        `SELECT id, campaign_version, audience_rule_sha256, audience_digest,
                recipient_count, created_at
           FROM campaign_audience_snapshots
          WHERE org_id=$1 AND store_id=$2 AND campaign_id=$3
          ORDER BY created_at DESC, id LIMIT 20`,
        [tenant.orgId, tenant.storeId, campaignId],
      );
      return Object.freeze({
        campaign: value,
        snapshots: Object.freeze(result.rows.map(snapshot)),
      });
    },
    async previewAudience(client, tenant, campaignId, expectedVersion, at) {
      const value = await loadCampaign(client, tenant, campaignId, false);
      return value === null || value.version !== expectedVersion
        ? null
        : publicEvaluation(await evaluateAudienceSelection(client, tenant, value, at));
    },
    async freezeAudience(client, tenant, input) {
      const value = await loadCampaign(client, tenant, input.campaignId, true);
      if (value === null) return Object.freeze({ ok: false as const, reason: "missing" as const });
      if (value.version !== input.expectedVersion) {
        return Object.freeze({ ok: false as const, reason: "stale" as const });
      }
      const evaluated = await evaluateAudienceSelection(client, tenant, value, input.at);
      if (
        evaluated.audienceDigest !== input.previewDigest ||
        evaluated.recipientCount !== input.expectedRecipientCount
      ) {
        return Object.freeze({ ok: false as const, reason: "preview_drift" as const });
      }
      const id = newId();
      const inserted = await client.query<SnapshotRow>(
        `INSERT INTO campaign_audience_snapshots
           (id, org_id, store_id, campaign_id, campaign_version, audience_rule_sha256,
            audience_digest, recipient_count, created_by_staff_id, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (org_id, store_id, campaign_id, campaign_version, audience_digest)
         DO NOTHING
         RETURNING id, campaign_version, audience_rule_sha256, audience_digest,
                   recipient_count, created_at`,
        [
          id,
          tenant.orgId,
          tenant.storeId,
          value.campaignId,
          value.version,
          value.audienceRuleSha256,
          evaluated.audienceDigest,
          evaluated.recipientCount,
          tenant.staffId,
          input.at.toISOString(),
        ],
      );
      let row = inserted.rows[0];
      if (row === undefined) {
        const existing = await client.query<SnapshotRow>(
          `SELECT id, campaign_version, audience_rule_sha256, audience_digest,
                  recipient_count, created_at FROM campaign_audience_snapshots
            WHERE org_id=$1 AND store_id=$2 AND campaign_id=$3
              AND campaign_version=$4 AND audience_digest=$5 LIMIT 1`,
          [tenant.orgId, tenant.storeId, value.campaignId, value.version, evaluated.audienceDigest],
        );
        row = existing.rows[0];
      }
      if (row === undefined) return Object.freeze({ ok: false as const, reason: "stale" as const });
      return Object.freeze({ ok: true as const, snapshot: snapshot(row) });
    },
  });
}
