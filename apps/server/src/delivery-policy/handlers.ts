import {
  DeliveryAvailabilityQuoteInputSchema,
  DeliveryPolicySetInputSchema,
  createCommandError,
} from "@laundry/contracts";

import type { CommandHandler, HandlerOutcome } from "../bus/types.js";
import { HandlerCommandError } from "../bus/types.js";
import type { SqlClient, TenantContext } from "../db/types.js";
import { requireFrozenDeliveryPolicyConfirmation } from "./confirmation.js";
import { evaluateDeliveryAvailability } from "./quote.js";
import { freezeDeliveryPolicy, type DeliveryPolicyStore } from "./types.js";

export type DeliveryPolicyHandlerDeps = Readonly<{
  store: DeliveryPolicyStore;
  featureEnabled: (client: SqlClient, tenant: TenantContext) => Promise<boolean>;
  timeZone: (client: SqlClient, tenant: TenantContext) => Promise<string>;
  now?: () => number;
}>;

function validationFailed(): HandlerCommandError {
  return new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
}

function getHandler(deps: DeliveryPolicyHandlerDeps): CommandHandler {
  return async (ctx): Promise<HandlerOutcome> => {
    const policy = await deps.store.get(ctx.tenant.orgId, ctx.tenant.storeId);
    return Object.freeze({ result: Object.freeze({ policy }) });
  };
}

function setHandler(deps: DeliveryPolicyHandlerDeps): CommandHandler {
  return async (ctx): Promise<HandlerOutcome> => {
    const parsed = DeliveryPolicySetInputSchema.safeParse(ctx.parsed);
    if (!parsed.success) throw validationFailed();
    requireFrozenDeliveryPolicyConfirmation(ctx, parsed.data);
    try {
      freezeDeliveryPolicy({
        version: 1,
        accepting_appointments: parsed.data.accepting_appointments,
        minimum_lead_minutes: parsed.data.minimum_lead_minutes,
        maximum_advance_days: parsed.data.maximum_advance_days,
        slot_minutes: parsed.data.slot_minutes,
        max_appointments_per_slot: parsed.data.max_appointments_per_slot,
        service_areas: parsed.data.service_areas,
        weekly_windows: parsed.data.weekly_windows,
        updated_at: 0,
      });
    } catch {
      throw validationFailed();
    }
    const change = await deps.store.set({
      org_id: ctx.tenant.orgId,
      store_id: ctx.tenant.storeId,
      staff_id: ctx.actor.staffId,
      ...parsed.data,
      updated_at: deps.now?.() ?? Math.floor(Date.now() / 1_000),
    });
    if (change === null) {
      throw new HandlerCommandError(createCommandError("IDEMPOTENCY_CONFLICT"));
    }
    return Object.freeze({
      result: Object.freeze({ policy: change.after }),
      audit: Object.freeze({
        entity: "delivery_policy",
        entityId: ctx.tenant.storeId,
        beforeJson: JSON.stringify(change.before),
        afterJson: JSON.stringify(change.after),
      }),
      events: Object.freeze([
        Object.freeze({
          type: "delivery.policy.changed",
          payload: Object.freeze({ store_id: ctx.tenant.storeId, version: change.after.version }),
        }),
      ]),
    });
  };
}

function quoteHandler(deps: DeliveryPolicyHandlerDeps): CommandHandler {
  return async (ctx): Promise<HandlerOutcome> => {
    const parsed = DeliveryAvailabilityQuoteInputSchema.safeParse(ctx.parsed);
    if (!parsed.success) throw validationFailed();
    const policy = await deps.store.get(ctx.tenant.orgId, ctx.tenant.storeId);
    const featureEnabled = await deps.featureEnabled(ctx.client, ctx.tenant);
    const timezone = await deps.timeZone(ctx.client, ctx.tenant);
    const quote = evaluateDeliveryAvailability({
      request: parsed.data,
      policy,
      featureEnabled,
      timezone,
      nowEpochSeconds: deps.now?.() ?? Math.floor(Date.now() / 1_000),
    });
    return Object.freeze({ result: Object.freeze({ quote }) });
  };
}

export function registerDeliveryPolicyCommandHandlers(
  registry: Readonly<{ registerHandler: (name: string, handler: CommandHandler) => void }>,
  deps: DeliveryPolicyHandlerDeps,
): void {
  registry.registerHandler("delivery.policy.set", setHandler(deps));
}

export function registerDeliveryPolicyQueryHandlers(
  registry: Readonly<{ registerHandler: (name: string, handler: CommandHandler) => void }>,
  deps: DeliveryPolicyHandlerDeps,
): void {
  registry.registerHandler("delivery.policy.get", getHandler(deps));
  registry.registerHandler("delivery.availability.quote", quoteHandler(deps));
}
