import { PricingPolicySetInputSchema, createCommandError } from "@laundry/contracts";

import type { CommandHandler, HandlerOutcome } from "../bus/types.js";
import { HandlerCommandError } from "../bus/types.js";
import { normalizePricingAddons, type PricingPolicyStore } from "./types.js";

export type PricingHandlerDeps = Readonly<{
  store: PricingPolicyStore;
  now?: () => number;
}>;

function getHandler(deps: PricingHandlerDeps): CommandHandler {
  return async (ctx): Promise<HandlerOutcome> => {
    const policy = await deps.store.get(ctx.tenant.orgId, ctx.tenant.storeId);
    return Object.freeze({ result: Object.freeze({ policy }) });
  };
}

function setHandler(deps: PricingHandlerDeps): CommandHandler {
  return async (ctx): Promise<HandlerOutcome> => {
    const parsed = PricingPolicySetInputSchema.safeParse(ctx.parsed);
    if (!parsed.success) {
      throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
    }
    let addons;
    try {
      addons = normalizePricingAddons(parsed.data.addons);
    } catch {
      throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
    }
    const change = await deps.store.set({
      org_id: ctx.tenant.orgId,
      store_id: ctx.tenant.storeId,
      staff_id: ctx.actor.staffId,
      expected_version: parsed.data.expected_version,
      urgent_cents: parsed.data.urgent_cents,
      freight_cents: parsed.data.freight_cents,
      addons,
      updated_at: deps.now?.() ?? Math.floor(Date.now() / 1000),
    });
    if (change === null) {
      throw new HandlerCommandError(createCommandError("IDEMPOTENCY_CONFLICT"));
    }
    return Object.freeze({
      result: Object.freeze({ policy: change.after }),
      audit: Object.freeze({
        entity: "store_pricing_policy",
        entityId: ctx.tenant.storeId,
        beforeJson: JSON.stringify(change.before),
        afterJson: JSON.stringify(change.after),
      }),
      events: Object.freeze([
        Object.freeze({
          type: "pricing.policy.changed",
          payload: Object.freeze({
            store_id: ctx.tenant.storeId,
            version: change.after.version,
          }),
        }),
      ]),
    });
  };
}

export function registerPricingCommandHandlers(
  registry: Readonly<{ registerHandler: (name: string, handler: CommandHandler) => void }>,
  deps: PricingHandlerDeps,
): void {
  registry.registerHandler("pricing.policy.set", setHandler(deps));
}

export function registerPricingQueryHandlers(
  registry: Readonly<{ registerHandler: (name: string, handler: CommandHandler) => void }>,
  deps: PricingHandlerDeps,
): void {
  registry.registerHandler("pricing.policy.get", getHandler(deps));
}
