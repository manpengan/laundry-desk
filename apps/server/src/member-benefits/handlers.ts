import {
  MemberAssetConsumeInputSchema,
  MemberAssetGrantInputSchema,
  MemberBenefitCatalogGetInputSchema,
  MemberBenefitCatalogResultSchema,
  MemberBenefitDefinitionUpsertInputSchema,
  MemberBenefitDefinitionUpsertResultSchema,
  MemberBenefitMutationResultSchema,
  MemberBenefitsGetInputSchema,
  MemberBenefitsResultSchema,
  MemberMembershipSetInputSchema,
  MemberPointsEarnInputSchema,
  MemberPointsRedeemInputSchema,
  createCommandError,
} from "@laundry/contracts";

import type { MutableCommandRegistry } from "../bus/registry.js";
import type { MutableQueryRegistry } from "../bus/query-registry.js";
import { HandlerCommandError, type CommandHandler, type HandlerOutcome } from "../bus/types.js";
import type { OrderHandlerDeps } from "../order/handlers.js";
import { assertBusinessDayOpen, deriveBusinessDate } from "../order/server-pricing.js";
import { benefitDefinitionAuditSnapshot } from "./definition-audit.js";
import { createPgMemberBenefitsStore } from "./pg-store.js";
import type {
  BenefitMutationResult,
  MemberBenefitRejectReason,
  MemberBenefitsRuntimeDeps,
  MemberBenefitsStore,
} from "./types.js";

export type MemberBenefitsHandlerDeps = MemberBenefitsRuntimeDeps &
  Readonly<{
    order: Pick<
      OrderHandlerDeps,
      "now" | "timeZone" | "rolloverHour" | "lockBusinessDay" | "isBusinessDayClosed"
    >;
  }>;

function requirePermission(context: Parameters<CommandHandler>[0], permission: string): void {
  if (context.actor.permissions?.includes(permission) !== true) {
    throw new HandlerCommandError(createCommandError("PERMISSION_DENIED"));
  }
}

function refusal(reason: MemberBenefitRejectReason): HandlerCommandError {
  switch (reason) {
    case "account_not_found":
    case "definition_not_found":
    case "order_not_found":
    case "asset_not_found":
    case "points_policy_missing":
    case "points_zero":
      return new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
    case "account_frozen":
    case "account_closed":
    case "definition_retired":
    case "definition_version_conflict":
    case "definition_code_conflict":
    case "membership_version_conflict":
    case "past_expiry":
    case "order_customer_mismatch":
    case "order_not_settled":
    case "insufficient_points":
    case "asset_expired":
    case "insufficient_uses":
    case "coupon_already_redeemed":
    case "coupon_order_invalid":
    case "coupon_order_already_discounted":
      return new HandlerCommandError(createCommandError("INVARIANT_FAILED"));
  }
}

function storeFor(
  deps: MemberBenefitsHandlerDeps,
  context: Parameters<CommandHandler>[0],
): MemberBenefitsStore {
  return deps.persistence === "sql"
    ? createPgMemberBenefitsStore(context.client, context.tenant)
    : deps.store;
}

function clock(deps: MemberBenefitsHandlerDeps): Readonly<{ at: number; business_date: string }> {
  const at = deps.order.now?.() ?? Math.floor(Date.now() / 1000);
  return Object.freeze({
    at,
    business_date: deriveBusinessDate(at, deps.order.timeZone, deps.order.rolloverHour),
  });
}

async function mutationClock(
  deps: MemberBenefitsHandlerDeps,
  context: Parameters<CommandHandler>[0],
): Promise<Readonly<{ at: number; business_date: string }>> {
  const now = clock(deps);
  await deps.order.lockBusinessDay?.(context.client, context.tenant, now.business_date);
  await assertBusinessDayOpen(deps.order.isBusinessDayClosed, now.business_date);
  return now;
}

function mutationOutcome(
  mutation: BenefitMutationResult,
  eventType: string,
  entity: string,
  after: Readonly<Record<string, unknown>>,
): HandlerOutcome {
  const result = MemberBenefitMutationResultSchema.parse({ benefits: mutation.benefits });
  const privacySubjectCustomerId = mutation.benefits.customer_id;
  if (!mutation.changed) return Object.freeze({ result, privacySubjectCustomerId });
  return Object.freeze({
    result,
    privacySubjectCustomerId,
    audit: Object.freeze({
      entity,
      entityId: mutation.entity_id,
      afterJson: JSON.stringify(after),
    }),
    events: Object.freeze([
      Object.freeze({ type: eventType, payload: Object.freeze({ entity_id: mutation.entity_id }) }),
    ]),
  });
}

export function createMemberBenefitsHandlers(
  deps: MemberBenefitsHandlerDeps,
): Readonly<Record<string, CommandHandler>> {
  const definitionUpsert: CommandHandler = async (context) => {
    requirePermission(context, "member_rule_write");
    const input = MemberBenefitDefinitionUpsertInputSchema.parse(context.parsed);
    const now = clock(deps);
    const outcome = await storeFor(deps, context).upsertDefinition({
      definition: input.definition,
      staff_id: context.actor.staffId,
      at: now.at,
    });
    if (!outcome.ok) throw refusal(outcome.reason);
    const result = MemberBenefitDefinitionUpsertResultSchema.parse({
      catalog: outcome.value.catalog,
    });
    return Object.freeze({
      result,
      audit: Object.freeze({
        entity: "member_benefit_definition",
        entityId:
          outcome.value.definition.kind === "points_policy"
            ? outcome.value.definition.policy_id
            : outcome.value.definition.definition_id,
        afterJson: JSON.stringify(benefitDefinitionAuditSnapshot(outcome.value.definition)),
      }),
      events: Object.freeze([
        Object.freeze({
          type: "member.benefit_definition_changed",
          payload: Object.freeze({ kind: outcome.value.definition.kind }),
        }),
      ]),
    });
  };

  const membershipSet: CommandHandler = async (context) => {
    requirePermission(context, "member_lifecycle_manage");
    const input = MemberMembershipSetInputSchema.parse(context.parsed);
    const now = await mutationClock(deps, context);
    const outcome = await storeFor(deps, context).setMembership({
      ...input,
      ...now,
      store_id: context.tenant.storeId,
      staff_id: context.actor.staffId,
    });
    if (!outcome.ok) throw refusal(outcome.reason);
    return mutationOutcome(outcome.value, "member.membership_changed", "member_membership", {
      account_id: input.account_id,
      tier_id: input.tier_id,
      valid_until: input.valid_until,
      version: outcome.value.benefits.membership.version,
      reason: input.reason,
    });
  };

  const pointsEarn: CommandHandler = async (context) => {
    requirePermission(context, "order_write");
    const input = MemberPointsEarnInputSchema.parse(context.parsed);
    const now = await mutationClock(deps, context);
    const outcome = await storeFor(deps, context).earnPoints({
      ...input,
      ...now,
      store_id: context.tenant.storeId,
      staff_id: context.actor.staffId,
    });
    if (!outcome.ok) throw refusal(outcome.reason);
    return mutationOutcome(outcome.value, "member.points_earned", "points_ledger", {
      account_id: input.account_id,
      order_id: input.order_id,
      available_points: outcome.value.benefits.points.available_points,
    });
  };

  const pointsRedeem: CommandHandler = async (context) => {
    requirePermission(context, "order_write");
    const input = MemberPointsRedeemInputSchema.parse(context.parsed);
    const now = await mutationClock(deps, context);
    const outcome = await storeFor(deps, context).redeemPoints({
      ...input,
      ...now,
      store_id: context.tenant.storeId,
      staff_id: context.actor.staffId,
    });
    if (!outcome.ok) throw refusal(outcome.reason);
    return mutationOutcome(outcome.value, "member.points_redeemed", "points_ledger", {
      account_id: input.account_id,
      points: input.points,
      available_points: outcome.value.benefits.points.available_points,
    });
  };

  const assetGrant: CommandHandler = async (context) => {
    requirePermission(context, "member_rule_write");
    const input = MemberAssetGrantInputSchema.parse(context.parsed);
    const now = await mutationClock(deps, context);
    const outcome = await storeFor(deps, context).grantAsset({
      ...input,
      ...now,
      store_id: context.tenant.storeId,
      staff_id: context.actor.staffId,
    });
    if (!outcome.ok) throw refusal(outcome.reason);
    return mutationOutcome(outcome.value, "member.asset_granted", "member_asset", {
      account_id: input.account_id,
      asset_kind: input.asset_kind,
      definition_id: input.definition_id,
    });
  };

  const assetConsume: CommandHandler = async (context) => {
    requirePermission(context, "order_write");
    const input = MemberAssetConsumeInputSchema.parse(context.parsed);
    const now = await mutationClock(deps, context);
    const store = storeFor(deps, context);
    const outcome =
      input.asset.asset_kind === "punch"
        ? await store.consumePunch({
            asset_id: input.asset.asset_id,
            uses: input.asset.uses,
            reason: input.reason!,
            ...now,
            store_id: context.tenant.storeId,
            staff_id: context.actor.staffId,
          })
        : await store.consumeCoupon({
            asset_id: input.asset.asset_id,
            order_id: input.asset.order_id,
            ...now,
            store_id: context.tenant.storeId,
            staff_id: context.actor.staffId,
          });
    if (!outcome.ok) throw refusal(outcome.reason);
    return mutationOutcome(outcome.value, "member.asset_consumed", "member_asset_usage", {
      asset_kind: input.asset.asset_kind,
      asset_id: input.asset.asset_id,
    });
  };

  const catalogGet: CommandHandler = async (context) => {
    requirePermission(context, "customer_read");
    const input = MemberBenefitCatalogGetInputSchema.parse(context.parsed);
    const catalog = await storeFor(deps, context).getCatalog(input.include_retired === true);
    return Object.freeze({ result: MemberBenefitCatalogResultSchema.parse(catalog) });
  };

  const benefitsGet: CommandHandler = async (context) => {
    requirePermission(context, "customer_read");
    const input = MemberBenefitsGetInputSchema.parse(context.parsed);
    const now = clock(deps);
    const outcome = await storeFor(deps, context).getBenefits({
      customer_id: input.customer_id,
      include_expired: input.include_expired === true,
      business_date: now.business_date,
    });
    if (!outcome.ok) throw refusal(outcome.reason);
    return Object.freeze({ result: MemberBenefitsResultSchema.parse(outcome.value) });
  };

  return Object.freeze({
    "member.benefit_definition.upsert": definitionUpsert,
    "member.membership.set": membershipSet,
    "member.points.earn": pointsEarn,
    "member.points.redeem": pointsRedeem,
    "member.asset.grant": assetGrant,
    "member.asset.consume": assetConsume,
    "member.benefit_catalog.get": catalogGet,
    "member.benefits.get": benefitsGet,
  });
}

export function registerMemberBenefitsHandlers(
  commandRegistry: MutableCommandRegistry,
  queryRegistry: MutableQueryRegistry | null,
  deps: MemberBenefitsHandlerDeps,
): void {
  const handlers = createMemberBenefitsHandlers(deps);
  for (const name of [
    "member.benefit_definition.upsert",
    "member.membership.set",
    "member.points.earn",
    "member.points.redeem",
    "member.asset.grant",
    "member.asset.consume",
  ]) {
    commandRegistry.registerHandler(name, handlers[name]!);
  }
  queryRegistry?.registerHandler(
    "member.benefit_catalog.get",
    handlers["member.benefit_catalog.get"]!,
  );
  queryRegistry?.registerHandler("member.benefits.get", handlers["member.benefits.get"]!);
}
