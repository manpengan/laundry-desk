import {
  MarketingCouponBatchGetInputSchema,
  MarketingCouponBatchGetResultSchema,
  MarketingCouponIssueAuthorityInputSchema,
  MarketingCouponIssueInputSchema,
  MarketingCouponIssuePreviewResultSchema,
  MarketingCouponIssueResultSchema,
  MarketingCouponRedemptionReverseInputSchema,
  MarketingCouponRedemptionReverseResultSchema,
  createCommandError,
} from "@laundry/contracts";

import type { CommandHandler, HandlerContext, HandlerOutcome } from "../bus/types.js";
import { HandlerCommandError } from "../bus/types.js";
import { createSqlFeaturesStore } from "../platform/features.js";
import { requireFrozenCouponIssue, requireFrozenCouponReversal } from "./coupon-confirmation.js";
import type { MarketingCouponRejectReason, MarketingHandlerDeps } from "./types.js";

function fail(
  code:
    | "RESOURCE_UNAVAILABLE"
    | "PERMISSION_DENIED"
    | "VALIDATION_FAILED"
    | "INVARIANT_FAILED"
    | "IDEMPOTENCY_CONFLICT"
    | "POLICY_DENIED",
): never {
  throw new HandlerCommandError(createCommandError(code));
}

async function authorize(deps: MarketingHandlerDeps, context: HandlerContext): Promise<void> {
  if (context.actor.permissions?.includes("marketing_manage") !== true) fail("PERMISSION_DENIED");
  const features =
    deps.persistence === "sql"
      ? createSqlFeaturesStore(context.client, context.tenant)
      : deps.features;
  if (!(await features.get(context.tenant.storeId)).marketing) fail("RESOURCE_UNAVAILABLE");
}

function currentTime(deps: MarketingHandlerDeps): Date {
  const value = deps.now?.() ?? new Date();
  if (!Number.isFinite(value.getTime())) fail("INVARIANT_FAILED");
  return value;
}

function reject(reason: MarketingCouponRejectReason): never {
  if (reason === "authority_drift") fail("POLICY_DENIED");
  if (reason === "stale") fail("IDEMPOTENCY_CONFLICT");
  if (
    reason === "missing" ||
    reason === "coupon_missing" ||
    reason === "redemption_missing" ||
    reason === "not_campaign_coupon"
  ) {
    fail("VALIDATION_FAILED");
  }
  fail("INVARIANT_FAILED");
}

function previewHandler(deps: MarketingHandlerDeps): CommandHandler {
  return async (context): Promise<HandlerOutcome> => {
    await authorize(deps, context);
    const input = MarketingCouponIssueAuthorityInputSchema.parse(context.parsed);
    const resolved = await deps.store.previewCouponIssue(context.client, context.tenant, {
      ...input,
      at: currentTime(deps),
    });
    if (!resolved.ok) reject(resolved.reason);
    return Object.freeze({
      result: MarketingCouponIssuePreviewResultSchema.parse({ preview: resolved.preview }),
    });
  };
}

function issueHandler(deps: MarketingHandlerDeps): CommandHandler {
  return async (context): Promise<HandlerOutcome> => {
    await authorize(deps, context);
    const input = MarketingCouponIssueInputSchema.parse(context.parsed);
    const frozenAuthority = requireFrozenCouponIssue(context, input);
    const resolved = await deps.store.issueCoupons(context.client, context.tenant, {
      ...input,
      at: currentTime(deps),
      frozenAuthority,
    });
    if (!resolved.ok) reject(resolved.reason);
    const result = MarketingCouponIssueResultSchema.parse({ batch: resolved.batch });
    if (resolved.batch.replayed) return Object.freeze({ result });
    return Object.freeze({
      result,
      audit: Object.freeze({
        entity: "marketing_coupon_batch",
        entityId: resolved.batch.batch_id,
        afterJson: JSON.stringify({
          campaign_id: resolved.batch.campaign_id,
          campaign_version: resolved.batch.campaign_version,
          snapshot_id: resolved.batch.snapshot_id,
          coupon_definition_id: resolved.batch.coupon_definition_id,
          granted_count: resolved.batch.granted_count,
          budget_committed_cents: resolved.batch.budget_committed_cents,
        }),
      }),
      events: Object.freeze([
        Object.freeze({
          type: "marketing.coupon_batch_issued",
          payload: Object.freeze({
            campaign_id: resolved.batch.campaign_id,
            batch_id: resolved.batch.batch_id,
            granted_count: resolved.batch.granted_count,
          }),
        }),
      ]),
    });
  };
}

function batchGetHandler(deps: MarketingHandlerDeps): CommandHandler {
  return async (context): Promise<HandlerOutcome> => {
    await authorize(deps, context);
    const input = MarketingCouponBatchGetInputSchema.parse(context.parsed);
    const found = await deps.store.getCouponBatch(context.client, context.tenant, input.batch_id);
    if (found === null) fail("VALIDATION_FAILED");
    return Object.freeze({
      result: MarketingCouponBatchGetResultSchema.parse({ batch: found }),
    });
  };
}

function reversalHandler(deps: MarketingHandlerDeps): CommandHandler {
  return async (context): Promise<HandlerOutcome> => {
    await authorize(deps, context);
    const input = MarketingCouponRedemptionReverseInputSchema.parse(context.parsed);
    const frozenAuthority = requireFrozenCouponReversal(context, input);
    const resolved = await deps.store.reverseCouponRedemption(context.client, context.tenant, {
      redemptionId: input.redemption_id,
      reason: input.reason,
      at: currentTime(deps),
      frozenAuthority,
    });
    if (!resolved.ok) reject(resolved.reason);
    const result = MarketingCouponRedemptionReverseResultSchema.parse(resolved.reversal);
    if (!resolved.reversal.changed) return Object.freeze({ result });
    return Object.freeze({
      result,
      audit: Object.freeze({
        entity: "coupon_redemption_reversal",
        entityId: resolved.reversal.reversal_id,
        beforeJson: JSON.stringify({
          redemption_id: resolved.reversal.redemption_id,
          grant_id: resolved.reversal.grant_id,
          order_id: resolved.reversal.order_id,
          discount_cents: resolved.reversal.reversed_discount_cents,
        }),
        afterJson: JSON.stringify({ reversed: true }),
      }),
      events: Object.freeze([
        Object.freeze({
          type: "marketing.coupon_redemption_reversed",
          payload: Object.freeze({
            reversal_id: resolved.reversal.reversal_id,
            order_id: resolved.reversal.order_id,
          }),
        }),
      ]),
    });
  };
}

export function createMarketingCouponHandlers(
  deps: MarketingHandlerDeps,
): Readonly<Record<string, CommandHandler>> {
  return Object.freeze({
    "marketing.campaign.coupons.preview": previewHandler(deps),
    "marketing.campaign.coupons.issue": issueHandler(deps),
    "marketing.campaign.coupon_batch.get": batchGetHandler(deps),
    "marketing.coupon.redemption.reverse": reversalHandler(deps),
  });
}
