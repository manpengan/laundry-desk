import {
  MarketingAudienceFreezeConfirmationSummarySchema,
  MarketingCampaignSetConfirmationSummarySchema,
  type MarketingAudienceFreezeConfirmationSummary,
  type MarketingCampaignSetConfirmationSummary,
  type MarketingCampaignSetInput,
} from "@laundry/contracts";

import type { SessionView } from "../auth/types.js";
import {
  createStepUpAttemptAuthority,
  type StepUpAttemptToken,
} from "../shell/step-up-attempt-authority.js";

export type MarketingFreezeInput = Readonly<{
  campaign_id: string;
  expected_version: number;
  preview_digest: string;
  expected_recipient_count: number;
}>;
export type MarketingCampaignRequest =
  | Readonly<{ action: "marketing.campaign.set"; input: MarketingCampaignSetInput }>
  | Readonly<{
      action: "marketing.campaign.audience.freeze";
      input: MarketingFreezeInput;
    }>;
export type MarketingCampaignPending =
  | Readonly<{
      request: Extract<MarketingCampaignRequest, { action: "marketing.campaign.set" }>;
      confirmRef: string;
      stepUp: boolean;
      actionGeneration: number;
      summary: MarketingCampaignSetConfirmationSummary;
    }>
  | Readonly<{
      request: Extract<MarketingCampaignRequest, { action: "marketing.campaign.audience.freeze" }>;
      confirmRef: string;
      stepUp: boolean;
      actionGeneration: number;
      summary: MarketingAudienceFreezeConfirmationSummary;
    }>;

export type MarketingRequestToken = Readonly<{
  generation: number;
  sessionScope: string;
  authorityKey: string;
}>;

export type MarketingPendingAuthority = Readonly<{
  begin(pending: MarketingCampaignPending, sessionScope: string): void;
  currentStepUp(): StepUpAttemptToken | null;
  invalidate(): void;
  matches(
    pending: MarketingCampaignPending,
    sessionScope: string,
    actionGeneration: number,
    expectedStepUp?: StepUpAttemptToken,
  ): boolean;
}>;

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

export function marketingSessionScope(session: SessionView): string {
  return [
    session.session.session_id,
    session.session.session_version,
    session.session.org_id,
    session.session.store_id,
    session.session.staff_id,
    session.session.permission_version,
  ].join(":");
}

export function marketingAuthorityKey(value: unknown): string {
  return canonical(value);
}

export function marketingPendingAuthorityKey(
  sessionScope: string,
  pending: MarketingCampaignPending,
): string {
  return canonical({ sessionScope, pending });
}

export function createMarketingPendingAuthority(): MarketingPendingAuthority {
  const stepUp = createStepUpAttemptAuthority();
  let authorityKey: string | null = null;
  let generation: number | null = null;
  return Object.freeze({
    begin(pending, sessionScope) {
      authorityKey = marketingPendingAuthorityKey(sessionScope, pending);
      generation = pending.actionGeneration;
      if (pending.stepUp) stepUp.begin(authorityKey);
      else stepUp.invalidate();
    },
    currentStepUp() {
      return stepUp.current();
    },
    invalidate() {
      authorityKey = null;
      generation = null;
      stepUp.invalidate();
    },
    matches(pending, sessionScope, actionGeneration, expectedStepUp) {
      const expectedKey = marketingPendingAuthorityKey(sessionScope, pending);
      return (
        authorityKey === expectedKey &&
        generation === actionGeneration &&
        pending.actionGeneration === actionGeneration &&
        (expectedStepUp === undefined || stepUp.isCurrent(expectedStepUp, expectedKey))
      );
    },
  });
}

export function createMarketingRequestToken(
  generation: number,
  sessionScope: string,
  authorityKey: string,
): MarketingRequestToken {
  return Object.freeze({ generation, sessionScope, authorityKey });
}

export function marketingRequestMatches(
  token: MarketingRequestToken,
  generation: number,
  sessionScope: string,
  authorityKey: string,
): boolean {
  return (
    token.generation === generation &&
    token.sessionScope === sessionScope &&
    token.authorityKey === authorityKey
  );
}

export function readMarketingCampaignSummary(
  request: MarketingCampaignRequest,
  value: unknown,
): MarketingCampaignPending["summary"] | null {
  if (request.action === "marketing.campaign.set") {
    const parsed = MarketingCampaignSetConfirmationSummarySchema.safeParse(value);
    const expected = MarketingCampaignSetConfirmationSummarySchema.parse({
      kind: "marketing_campaign_set",
      ...request.input,
    });
    return parsed.success && marketingAuthorityKey(parsed.data) === marketingAuthorityKey(expected)
      ? Object.freeze(parsed.data)
      : null;
  }
  const parsed = MarketingAudienceFreezeConfirmationSummarySchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.campaign_id !== request.input.campaign_id ||
    parsed.data.campaign_version !== request.input.expected_version ||
    parsed.data.audience_digest !== request.input.preview_digest ||
    parsed.data.recipient_count !== request.input.expected_recipient_count
  ) {
    return null;
  }
  return Object.freeze(parsed.data);
}
