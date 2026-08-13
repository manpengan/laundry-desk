import {
  MarketingCouponIssueConfirmationSummarySchema,
  MarketingCouponIssueInputSchema,
  MarketingCouponRedemptionReverseInputSchema,
  MarketingCouponReversalConfirmationSummarySchema,
  createCommandError,
  type MarketingCouponIssueConfirmationSummary,
  type MarketingCouponReversalConfirmationSummary,
} from "@laundry/contracts";

import type { HandlerContext } from "../bus/types.js";
import { HandlerCommandError } from "../bus/types.js";
import type { PendingActionPreparer } from "../handlers/default-chain-hooks.js";
import { createSqlFeaturesStore } from "../platform/features.js";
import {
  couponIssueConfirmationSummary,
  couponReversalConfirmationSummary,
} from "./coupon-authority.js";
import type { MarketingCouponRejectReason, MarketingHandlerDeps } from "./types.js";

function fail(
  code:
    | "RESOURCE_UNAVAILABLE"
    | "PERMISSION_DENIED"
    | "VALIDATION_FAILED"
    | "INVARIANT_FAILED"
    | "POLICY_DENIED",
): never {
  throw new HandlerCommandError(createCommandError(code));
}

function reject(reason: MarketingCouponRejectReason): never {
  if (
    reason === "missing" ||
    reason === "coupon_missing" ||
    reason === "redemption_missing" ||
    reason === "not_campaign_coupon"
  ) {
    fail("VALIDATION_FAILED");
  }
  fail(reason === "authority_drift" ? "POLICY_DENIED" : "INVARIANT_FAILED");
}

function transactionClient(context: Parameters<PendingActionPreparer>[1]) {
  if (context.transactionClient === undefined) fail("RESOURCE_UNAVAILABLE");
  return context.transactionClient;
}

function currentTime(deps: MarketingHandlerDeps): Date {
  const value = deps.now?.() ?? new Date();
  if (!Number.isFinite(value.getTime())) fail("INVARIANT_FAILED");
  return value;
}

async function authorize(
  deps: MarketingHandlerDeps,
  context: Parameters<PendingActionPreparer>[1],
): Promise<void> {
  if (context.actor.permissions?.includes("marketing_manage") !== true) {
    fail("PERMISSION_DENIED");
  }
  const client = transactionClient(context);
  const features =
    deps.persistence === "sql" ? createSqlFeaturesStore(client, context.tenant) : deps.features;
  if (!(await features.get(context.tenant.storeId)).marketing) fail("RESOURCE_UNAVAILABLE");
}

export function createMarketingCouponConfirmationPreparer(
  deps: MarketingHandlerDeps,
): PendingActionPreparer {
  return async (parsed, context) => {
    if (
      context.definition.name !== "marketing.campaign.coupons.issue" &&
      context.definition.name !== "marketing.coupon.redemption.reverse"
    ) {
      return null;
    }
    await authorize(deps, context);
    const client = transactionClient(context);
    if (context.definition.name === "marketing.campaign.coupons.issue") {
      const input = MarketingCouponIssueInputSchema.parse(parsed);
      const resolved = await deps.store.previewCouponIssue(client, context.tenant, {
        campaign_id: input.campaign_id,
        expected_version: input.expected_version,
        snapshot_id: input.snapshot_id,
        coupon_definition_id: input.coupon_definition_id,
        at: currentTime(deps),
      });
      if (!resolved.ok) reject(resolved.reason);
      const summary = couponIssueConfirmationSummary(input, resolved.preview);
      return Object.freeze({ authority: summary, summary });
    }
    const input = MarketingCouponRedemptionReverseInputSchema.parse(parsed);
    const resolved = await deps.store.previewCouponRedemptionReversal(
      client,
      context.tenant,
      input.redemption_id,
    );
    if (!resolved.ok) reject(resolved.reason);
    const summary = couponReversalConfirmationSummary(input, resolved.preview);
    return Object.freeze({ authority: summary, summary });
  };
}

export function requireFrozenCouponIssue(
  context: HandlerContext,
  parsed: unknown,
): MarketingCouponIssueConfirmationSummary {
  const input = MarketingCouponIssueInputSchema.parse(parsed);
  const frozen = MarketingCouponIssueConfirmationSummarySchema.safeParse(
    context.confirmationAuthority,
  );
  if (
    context.request.confirmRef === undefined ||
    !frozen.success ||
    frozen.data.campaign_id !== input.campaign_id ||
    frozen.data.campaign_version !== input.expected_version ||
    frozen.data.snapshot_id !== input.snapshot_id ||
    frozen.data.coupon_definition_id !== input.coupon_definition_id ||
    frozen.data.reason !== input.reason
  ) {
    fail("POLICY_DENIED");
  }
  return Object.freeze(frozen.data);
}

export function requireFrozenCouponReversal(
  context: HandlerContext,
  parsed: unknown,
): MarketingCouponReversalConfirmationSummary {
  const input = MarketingCouponRedemptionReverseInputSchema.parse(parsed);
  const frozen = MarketingCouponReversalConfirmationSummarySchema.safeParse(
    context.confirmationAuthority,
  );
  if (
    context.request.confirmRef === undefined ||
    !frozen.success ||
    frozen.data.redemption_id !== input.redemption_id ||
    frozen.data.reason !== input.reason
  ) {
    fail("POLICY_DENIED");
  }
  return Object.freeze(frozen.data);
}
