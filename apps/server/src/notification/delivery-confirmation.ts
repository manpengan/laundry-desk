import { createHash } from "node:crypto";

import {
  NotificationDeliveryBatchEnqueueInputSchema,
  NotificationDeliveryConfirmationSummarySchema,
  createCommandError,
} from "@laundry/contracts";
import { z } from "zod";

import { HandlerCommandError, type HandlerContext } from "../bus/types.js";
import type {
  PendingActionPreparer,
  PendingRiskPreparer,
} from "../handlers/default-chain-hooks.js";
import {
  NOTIFICATION_ACTIVE_PENDING_LIMIT,
  NOTIFICATION_ROLLING_PENDING_LIMIT,
} from "../pending-actions/types.js";
import type { NotificationHandlerDeps } from "./types.js";
import type { NotificationTemplateSnapshot } from "./delivery-types.js";

const AuthoritySchema = z
  .object({
    kind: z.literal("notification_delivery_batch"),
    provider_code: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/u),
    assurance: z.enum(["software_only", "external"]),
    unit_cost_cents: z.number().int().nonnegative().max(100_000),
    max_batch_cost_cents: z.number().int().nonnegative().max(100_000),
    template_id: z.uuid(),
    template_code: z.literal("pickup_reminder_v1"),
    template_version: z.number().int().positive().max(1_000_000),
    template_channel: z.literal("sms"),
    template_body_sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  })
  .strict();

const RiskReservationSchema = z
  .object({
    kind: z.literal("notification_delivery_rolling_24h"),
    units: z.number().int().min(1).max(50),
    prior_units: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    aggregate_units: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    threshold: z.literal(10),
    window_started_at_epoch: z.number().int().nonnegative(),
  })
  .strict()
  .refine((value) => value.aggregate_units === value.prior_units + value.units);

const FrozenAuthoritySchema = AuthoritySchema.extend({
  confirmation_summary: NotificationDeliveryConfirmationSummarySchema,
  risk_reservation: RiskReservationSchema,
}).strict();

function baseAuthority(value: z.infer<typeof FrozenAuthoritySchema>) {
  return AuthoritySchema.parse({
    kind: value.kind,
    provider_code: value.provider_code,
    assurance: value.assurance,
    unit_cost_cents: value.unit_cost_cents,
    max_batch_cost_cents: value.max_batch_cost_cents,
    template_id: value.template_id,
    template_code: value.template_code,
    template_version: value.template_version,
    template_channel: value.template_channel,
    template_body_sha256: value.template_body_sha256,
  });
}

const digest = (body: string): string => createHash("sha256").update(body, "utf8").digest("hex");

export function requireNotificationCostBounds(
  input: Readonly<{
    orderCount: number;
    maxCostCents: number;
    unitCostCents: number;
    capabilityMaxCostCents: number;
  }>,
): number {
  const estimatedCost = input.unitCostCents * input.orderCount;
  if (
    !Number.isSafeInteger(estimatedCost) ||
    estimatedCost > input.maxCostCents ||
    input.maxCostCents > input.capabilityMaxCostCents
  ) {
    throw new HandlerCommandError(createCommandError("INVARIANT_FAILED"));
  }
  return estimatedCost;
}

function authorityFor(deps: NotificationHandlerDeps, template: NotificationTemplateSnapshot) {
  const capability = deps.delivery?.capability;
  if (
    capability === undefined ||
    capability.state === "disabled" ||
    capability.provider_code === null ||
    capability.unit_cost_cents === null ||
    capability.max_batch_cost_cents === null
  ) {
    throw new HandlerCommandError(createCommandError("RESOURCE_UNAVAILABLE"));
  }
  return AuthoritySchema.parse({
    kind: "notification_delivery_batch",
    provider_code: capability.provider_code,
    assurance: capability.state,
    unit_cost_cents: capability.unit_cost_cents,
    max_batch_cost_cents: capability.max_batch_cost_cents,
    template_id: template.id,
    template_code: template.code,
    template_version: template.version,
    template_channel: template.channel,
    template_body_sha256: digest(template.body),
  });
}

function riskRequestFor(parsed: unknown) {
  const input = NotificationDeliveryBatchEnqueueInputSchema.parse(parsed);
  return Object.freeze({
    kind: "notification_delivery_rolling_24h" as const,
    command: "notification.delivery_batch.enqueue" as const,
    commandVersion: "0.1.0" as const,
    units: input.order_ids.length,
    threshold: 10 as const,
    windowSeconds: 86_400 as const,
    activePendingLimit: NOTIFICATION_ACTIVE_PENDING_LIMIT,
    rollingPendingLimit: NOTIFICATION_ROLLING_PENDING_LIMIT,
    nowEpochSeconds: Math.floor(Date.now() / 1_000),
  });
}

export const prepareNotificationDeliveryRisk: PendingRiskPreparer = (parsed, context) =>
  context.definition.name === "notification.delivery_batch.enqueue" ? riskRequestFor(parsed) : null;

export function createNotificationDeliveryConfirmationPreparer(
  deps: NotificationHandlerDeps,
): PendingActionPreparer {
  return async (parsed, context) => {
    if (context.definition.name !== "notification.delivery_batch.enqueue") return null;
    if (context.transactionClient === undefined || deps.delivery === undefined) {
      throw new HandlerCommandError(createCommandError("RESOURCE_UNAVAILABLE"));
    }
    const input = NotificationDeliveryBatchEnqueueInputSchema.parse(parsed);
    const now = deps.now?.() ?? new Date();
    if (!Number.isFinite(now.getTime())) {
      throw new HandlerCommandError(createCommandError("TRANSACTION_FAILED"));
    }
    const candidates = await deps.store.listPickupReminders({
      client: context.transactionClient,
      tenant: context.tenant,
      filters: Object.freeze({
        minAgeDays: input.min_age_days,
        unpaidOnly: input.unpaid_only,
        garmentStatuses: Object.freeze([...input.garment_statuses]),
        limit: input.order_ids.length,
      }),
      orderIds: input.order_ids,
      now,
    });
    const ticketByOrder = new Map(
      candidates.map((candidate) => [candidate.order_id, candidate.ticket_no]),
    );
    const ticketNos = input.order_ids.map((orderId) => ticketByOrder.get(orderId));
    if (ticketNos.some((ticket): ticket is undefined => ticket === undefined)) {
      throw new HandlerCommandError(createCommandError("INVARIANT_FAILED"));
    }
    const template = await deps.delivery.store.getActiveTemplate(
      context.transactionClient,
      context.tenant,
      input.template_code,
    );
    if (template === null) {
      throw new HandlerCommandError(createCommandError("RESOURCE_UNAVAILABLE"));
    }
    const authority = authorityFor(deps, template);
    const estimatedCost = requireNotificationCostBounds({
      orderCount: input.order_ids.length,
      maxCostCents: input.max_cost_cents,
      unitCostCents: authority.unit_cost_cents,
      capabilityMaxCostCents: authority.max_batch_cost_cents,
    });
    const summary = NotificationDeliveryConfirmationSummarySchema.parse({
      kind: "notification_delivery_batch",
      order_count: input.order_ids.length,
      risk_window_order_count: input.order_ids.length,
      ticket_nos: ticketNos,
      channel: input.channel,
      assurance: authority.assurance,
      provider_code: authority.provider_code,
      template_code: authority.template_code,
      template_version: authority.template_version,
      estimated_cost_cents: estimatedCost,
      max_cost_cents: input.max_cost_cents,
      min_age_days: input.min_age_days,
      unpaid_only: input.unpaid_only,
      garment_statuses: input.garment_statuses,
    });
    return Object.freeze({
      authority,
      summary,
      riskReservation: riskRequestFor(input),
    });
  };
}

export function requireFrozenNotificationDelivery(
  context: HandlerContext,
  deps: NotificationHandlerDeps,
  template: NotificationTemplateSnapshot,
): void {
  if (context.request.confirmRef === undefined) return;
  const frozen = FrozenAuthoritySchema.safeParse(context.confirmationAuthority);
  if (!frozen.success) throw new HandlerCommandError(createCommandError("POLICY_DENIED"));
  const current = authorityFor(deps, template);
  const frozenAuthority = baseAuthority(frozen.data);
  if (JSON.stringify(frozenAuthority) !== JSON.stringify(current)) {
    throw new HandlerCommandError(createCommandError("POLICY_DENIED"));
  }
}
