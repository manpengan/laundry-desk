import {
  MarketingCampaignAudienceFreezeResultSchema,
  MarketingCampaignAudiencePreviewResultSchema,
  MarketingCampaignSetInputSchema,
  MarketingCampaignSetResultSchema,
  MarketingCampaignsListResultSchema,
  type MarketingCampaign,
  type MarketingCampaignSetInput,
} from "@laundry/contracts";

import type { CommandPort, QueryPort } from "../commands/types.js";
import { unwrapQueryResult } from "../pages/customer-model.js";

export type MarketingCampaignDraft = Readonly<{
  campaignId?: string | undefined;
  expectedVersion: number;
  code: string;
  name: string;
  status: "draft" | "scheduled" | "paused" | "cancelled";
  startsAt: string;
  endsAt: string;
  budgetYuan: string;
  recipientLimit: string;
  customerAgeDays: string;
  orderActivity: "any" | "none" | "within_days";
  orderActivityDays: string;
  membership: "any" | "member" | "non_member" | "tiers";
  tierIds: string;
}>;

type BuildResult =
  | Readonly<{ ok: true; input: MarketingCampaignSetInput }>
  | Readonly<{ ok: false; message: string }>;

function integer(value: string): number | null {
  return /^[1-9][0-9]*$/u.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
}

function cents(value: string): number | null {
  const match = /^([0-9]+)(?:\.([0-9]{1,2}))?$/u.exec(value.trim());
  if (match === null) return null;
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? "").padEnd(2, "0"));
  const result = whole * 100 + fraction;
  return Number.isSafeInteger(result) && result > 0 ? result : null;
}

function utc(value: string): string | null {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

export function emptyMarketingDraft(at = new Date()): MarketingCampaignDraft {
  const local = (value: Date) => {
    const shifted = new Date(value.getTime() - value.getTimezoneOffset() * 60_000);
    return shifted.toISOString().slice(0, 16);
  };
  return Object.freeze({
    expectedVersion: 0,
    code: "",
    name: "",
    status: "draft",
    startsAt: local(at),
    endsAt: local(new Date(at.getTime() + 30 * 86_400_000)),
    budgetYuan: "500",
    recipientLimit: "100",
    customerAgeDays: "",
    orderActivity: "any",
    orderActivityDays: "",
    membership: "any",
    tierIds: "",
  });
}

export function campaignToDraft(value: MarketingCampaign): MarketingCampaignDraft {
  const local = (timestamp: string) => {
    const date = new Date(timestamp);
    return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  };
  const age = value.audience_rule.customer_age;
  const activity = value.audience_rule.order_activity;
  const membership = value.audience_rule.membership;
  return Object.freeze({
    campaignId: value.campaign_id,
    expectedVersion: value.version,
    code: value.code,
    name: value.name,
    status: value.status,
    startsAt: local(value.starts_at),
    endsAt: local(value.ends_at),
    budgetYuan: (value.budget_limit_cents / 100).toFixed(2),
    recipientLimit: String(value.recipient_limit),
    customerAgeDays: age.kind === "within_days" ? String(age.days) : "",
    orderActivity: activity.kind,
    orderActivityDays: activity.kind === "within_days" ? String(activity.days) : "",
    membership: membership.kind,
    tierIds: membership.kind === "tiers" ? membership.tier_ids.join(",") : "",
  });
}

export function buildMarketingCampaignInput(draft: MarketingCampaignDraft): BuildResult {
  const startsAt = utc(draft.startsAt);
  const endsAt = utc(draft.endsAt);
  const budget = cents(draft.budgetYuan);
  const recipientLimit = integer(draft.recipientLimit);
  const ageDays = draft.customerAgeDays === "" ? null : integer(draft.customerAgeDays);
  const activityDays = draft.orderActivityDays === "" ? null : integer(draft.orderActivityDays);
  const tierIds = draft.tierIds
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (startsAt === null || endsAt === null || budget === null || recipientLimit === null) {
    return Object.freeze({ ok: false as const, message: "请检查时间、预算和人数上限" });
  }
  if (draft.customerAgeDays !== "" && ageDays === null) {
    return Object.freeze({ ok: false as const, message: "顾客创建天数必须是正整数" });
  }
  if (draft.orderActivity === "within_days" && activityDays === null) {
    return Object.freeze({ ok: false as const, message: "下单活跃天数必须是正整数" });
  }
  const parsed = MarketingCampaignSetInputSchema.safeParse({
    ...(draft.campaignId === undefined ? {} : { campaign_id: draft.campaignId }),
    expected_version: draft.expectedVersion,
    code: draft.code.trim(),
    name: draft.name.trim(),
    status: draft.status,
    starts_at: startsAt,
    ends_at: endsAt,
    budget_limit_cents: budget,
    recipient_limit: recipientLimit,
    audience_rule: {
      customer_age: ageDays === null ? { kind: "any" } : { kind: "within_days", days: ageDays },
      order_activity:
        draft.orderActivity === "within_days"
          ? { kind: "within_days", days: activityDays }
          : { kind: draft.orderActivity },
      membership:
        draft.membership === "tiers"
          ? { kind: "tiers", tier_ids: tierIds }
          : { kind: draft.membership },
    },
  });
  return parsed.success
    ? Object.freeze({ ok: true as const, input: parsed.data })
    : Object.freeze({ ok: false as const, message: "活动字段不完整或超出安全上限" });
}

export function parseCampaignList(value: unknown): readonly MarketingCampaign[] | null {
  const parsed = MarketingCampaignsListResultSchema.safeParse(unwrapQueryResult(value));
  return parsed.success
    ? Object.freeze(parsed.data.campaigns.map((row) => Object.freeze(row)))
    : null;
}

export function parseSetCampaign(value: unknown): MarketingCampaign | null {
  const parsed = MarketingCampaignSetResultSchema.safeParse(unwrapQueryResult(value));
  return parsed.success ? Object.freeze(parsed.data.campaign) : null;
}

export function parseAudiencePreview(value: unknown) {
  const parsed = MarketingCampaignAudiencePreviewResultSchema.safeParse(unwrapQueryResult(value));
  return parsed.success ? Object.freeze(parsed.data) : null;
}

export function parseAudienceFreeze(value: unknown) {
  const parsed = MarketingCampaignAudienceFreezeResultSchema.safeParse(unwrapQueryResult(value));
  return parsed.success ? Object.freeze(parsed.data.snapshot) : null;
}

export async function loadMarketingCampaigns(queryClient: QueryPort) {
  return await queryClient.execute<unknown>("marketing.campaigns.list", { limit: 50 });
}

export async function previewMarketingAudience(
  queryClient: QueryPort,
  campaign: MarketingCampaign,
) {
  return await queryClient.execute<unknown>("marketing.campaign.audience.preview", {
    campaign_id: campaign.campaign_id,
    expected_version: campaign.version,
  });
}

export function setMarketingCampaign(commandClient: CommandPort, input: MarketingCampaignSetInput) {
  return commandClient.execute<unknown>("marketing.campaign.set", input);
}

export function freezeMarketingAudience(
  commandClient: CommandPort,
  input: Readonly<{
    campaign_id: string;
    expected_version: number;
    preview_digest: string;
    expected_recipient_count: number;
  }>,
) {
  return commandClient.execute<unknown>("marketing.campaign.audience.freeze", input);
}
