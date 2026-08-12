import {
  CustomerDiscountPolicySetInputSchema,
  CustomerProfileGetInputSchema,
  CustomerProfileMutationResultSchema,
  CustomerProfileResultSchema,
  CustomerProfileSetInputSchema,
  createCommandError,
} from "@laundry/contracts";

import type { CommandHandler, HandlerOutcome } from "../bus/types.js";
import { HandlerCommandError } from "../bus/types.js";
import type { MutableCommandRegistry } from "../bus/registry.js";
import type { MutableQueryRegistry } from "../bus/query-registry.js";
import { CustomerIdentifierConflictError, type CustomerProfileStore } from "./types.js";

export type CustomerProfileHandlerDeps = Readonly<{
  store: CustomerProfileStore;
  now?: () => number;
}>;

function unavailable(): never {
  throw new HandlerCommandError(createCommandError("RESOURCE_UNAVAILABLE"));
}

function conflict(): never {
  throw new HandlerCommandError(createCommandError("INVARIANT_FAILED"));
}

function mutationResult(profile: Awaited<ReturnType<CustomerProfileStore["get"]>>) {
  if (profile === null) unavailable();
  return CustomerProfileMutationResultSchema.parse({
    customer_id: profile.customer_id,
    version: profile.version,
    address_count: profile.addresses.length,
    identifier_count: profile.identifiers.length,
  });
}

export function registerCustomerProfileCommandHandlers(
  registry: MutableCommandRegistry,
  deps: CustomerProfileHandlerDeps,
): void {
  const profileSet: CommandHandler = async (context): Promise<HandlerOutcome> => {
    const input = CustomerProfileSetInputSchema.parse(context.parsed);
    let profile;
    try {
      profile = await deps.store.setProfile({
        ...input,
        store_id: context.tenant.storeId,
        staff_id: context.actor.staffId,
        at: deps.now?.() ?? Math.floor(Date.now() / 1000),
      });
    } catch (error) {
      if (error instanceof CustomerIdentifierConflictError) conflict();
      throw error;
    }
    if (profile === null) conflict();
    return Object.freeze({
      result: mutationResult(profile),
      privacySubjectCustomerId: profile.customer_id,
      audit: Object.freeze({
        entity: "customer_profile",
        entityId: profile.customer_id,
        afterJson: JSON.stringify({
          version: profile.version,
          gender: profile.gender,
          preferred_contact: profile.preferred_contact,
          waivers: profile.waivers,
          address_count: profile.addresses.length,
          identifier_count: profile.identifiers.length,
          reason: input.reason,
        }),
      }),
      events: Object.freeze([
        Object.freeze({
          type: "customer.profile_changed",
          payload: Object.freeze({ customer_id: profile.customer_id, version: profile.version }),
        }),
      ]),
    });
  };

  const discountSet: CommandHandler = async (context): Promise<HandlerOutcome> => {
    const input = CustomerDiscountPolicySetInputSchema.parse(context.parsed);
    const profile = await deps.store.setDiscount({
      ...input,
      store_id: context.tenant.storeId,
      staff_id: context.actor.staffId,
      at: deps.now?.() ?? Math.floor(Date.now() / 1000),
    });
    if (profile === null) conflict();
    return Object.freeze({
      result: mutationResult(profile),
      privacySubjectCustomerId: profile.customer_id,
      audit: Object.freeze({
        entity: "customer_discount_policy",
        entityId: profile.customer_id,
        afterJson: JSON.stringify({
          version: profile.version,
          discount_bps: profile.discount_bps,
          reason: input.reason,
        }),
      }),
      events: Object.freeze([
        Object.freeze({
          type: "customer.discount_policy_changed",
          payload: Object.freeze({ customer_id: profile.customer_id, version: profile.version }),
        }),
      ]),
    });
  };

  registry.registerHandler("customer.profile.set", profileSet);
  registry.registerHandler("customer.discount_policy.set", discountSet);
}

export function registerCustomerProfileQueryHandlers(
  registry: MutableQueryRegistry,
  deps: CustomerProfileHandlerDeps,
): void {
  registry.registerHandler("customer.profile.get", async (context) => {
    const input = CustomerProfileGetInputSchema.parse(context.parsed);
    const profile = await deps.store.get(input.customer_id);
    if (profile === null) unavailable();
    return Object.freeze({ result: CustomerProfileResultSchema.parse(profile) });
  });
}
