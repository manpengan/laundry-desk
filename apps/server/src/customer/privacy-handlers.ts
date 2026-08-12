import { randomUUID } from "node:crypto";

import { createCommandError } from "@laundry/contracts";

import type { CommandHandler, HandlerOutcome } from "../bus/types.js";
import { HandlerCommandError } from "../bus/types.js";
import type { CustomerProfileView } from "../customer-profile/types.js";
import type { CustomerHandlerDeps } from "./handlers.js";
import type { CustomerPrivacyExport } from "./types.js";

const DEFAULT_EVENT_LIMIT = 20;
const MAX_EVENT_LIMIT = 50;

function asRecord(parsed: unknown): Readonly<Record<string, unknown>> {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
  }
  return parsed as Readonly<Record<string, unknown>>;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
  }
  return value.trim();
}

function eventLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_EVENT_LIMIT;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
  }
  return Math.min(value, MAX_EVENT_LIMIT);
}

function unavailable(): never {
  throw new HandlerCommandError(createCommandError("RESOURCE_UNAVAILABLE"));
}

function exportProfile(profile: CustomerProfileView): Readonly<Record<string, unknown>> {
  return Object.freeze({
    customer_id: profile.customer_id,
    version: profile.version,
    gender: profile.gender,
    preferred_contact: profile.preferred_contact,
    service_note: profile.service_note,
    discount_bps: profile.discount_bps,
    waivers: profile.waivers,
    updated_at: profile.updated_at,
  });
}

function attachProfiles(
  exported: CustomerPrivacyExport,
  profiles: readonly CustomerProfileView[],
): CustomerPrivacyExport {
  if (profiles.length === 0) return exported;
  const snapshots = Object.freeze(profiles.map(exportProfile));
  const addresses = Object.freeze(profiles.flatMap((profile) => profile.addresses));
  const identifiers = Object.freeze(profiles.flatMap((profile) => profile.identifiers));
  return Object.freeze({
    ...exported,
    profile: snapshots[0] ?? null,
    profiles: snapshots,
    profile_count: snapshots.length,
    profiles_truncated: false,
    addresses,
    address_count: addresses.length,
    addresses_truncated: false,
    identifiers,
    identifier_count: identifiers.length,
    identifiers_truncated: false,
  });
}

function statusHandler(deps: CustomerHandlerDeps): CommandHandler {
  return async (ctx): Promise<HandlerOutcome> => {
    const input = asRecord(ctx.parsed);
    const status = await deps.store.privacyStatus(
      requiredString(input.customer_id),
      ctx.tenant.storeId,
      ctx.actor.staffId,
    );
    if (status === null) unavailable();
    return Object.freeze({ result: status });
  };
}

function eventsHandler(deps: CustomerHandlerDeps): CommandHandler {
  return async (ctx): Promise<HandlerOutcome> => {
    const input = asRecord(ctx.parsed);
    const events = await deps.store.listPrivacyEvents(
      requiredString(input.customer_id),
      eventLimit(input.limit),
    );
    return Object.freeze({ result: Object.freeze({ events }) });
  };
}

function exportHandler(deps: CustomerHandlerDeps): CommandHandler {
  return async (ctx): Promise<HandlerOutcome> => {
    const input = asRecord(ctx.parsed);
    const customerId = requiredString(input.customer_id);
    const exported = await deps.store.exportPrivacy({
      customer_id: customerId,
      store_id: ctx.tenant.storeId,
      staff_id: ctx.actor.staffId,
      reason: requiredString(input.reason),
      event_id: randomUUID(),
      now: deps.now?.() ?? Math.floor(Date.now() / 1000),
    });
    if (exported === null) unavailable();
    let privacyProfiles: readonly CustomerProfileView[] = Object.freeze([]);
    if (exported.profile === null && deps.profile !== undefined) {
      if (deps.profile.listPrivacyProfiles !== undefined) {
        privacyProfiles = await deps.profile.listPrivacyProfiles(exported.customer.customer_id);
      } else {
        const profile = await deps.profile.get(exported.customer.customer_id);
        if (profile !== null) privacyProfiles = Object.freeze([profile]);
      }
    }
    const result = attachProfiles(exported, privacyProfiles);
    return Object.freeze({
      result,
      privacySubjectCustomerId: exported.customer.customer_id,
      audit: Object.freeze({
        entity: "customer_privacy",
        entityId: exported.customer.customer_id,
        afterJson: JSON.stringify({
          action: "exported",
          order_count: result.order_count,
          truncated: result.truncated,
        }),
      }),
      events: Object.freeze([
        Object.freeze({
          type: "customer.privacy_exported",
          payload: Object.freeze({
            customer_id: exported.customer.customer_id,
            order_count: result.order_count,
          }),
        }),
      ]),
    });
  };
}

function anonymizeHandler(deps: CustomerHandlerDeps): CommandHandler {
  return async (ctx): Promise<HandlerOutcome> => {
    const input = asRecord(ctx.parsed);
    if (input.confirmation !== "ANONYMIZE") {
      throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
    }
    const customerId = requiredString(input.customer_id);
    const canonicalGroupIds = await deps.store.listCanonicalGroup?.(customerId);
    const result = await deps.store.anonymize({
      customer_id: customerId,
      store_id: ctx.tenant.storeId,
      staff_id: ctx.actor.staffId,
      reason: requiredString(input.reason),
      event_id: randomUUID(),
      now: deps.now?.() ?? Math.floor(Date.now() / 1000),
    });
    if (result === null) {
      throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
    }
    await deps.profile?.purgeCustomerPii?.(result.customer_id, canonicalGroupIds);
    return Object.freeze({
      result,
      privacySubjectCustomerId: result.customer_id,
      audit: Object.freeze({
        entity: "customer_privacy",
        entityId: result.customer_id,
        afterJson: JSON.stringify({
          action: "anonymized",
          affected_order_count: result.affected_order_count,
        }),
      }),
      events: Object.freeze([
        Object.freeze({
          type: "customer.anonymized",
          payload: Object.freeze({
            customer_id: result.customer_id,
            affected_order_count: result.affected_order_count,
          }),
        }),
      ]),
    });
  };
}

export function registerCustomerPrivacyCommandHandlers(
  registry: Readonly<{ registerHandler: (name: string, handler: CommandHandler) => void }>,
  deps: CustomerHandlerDeps,
): void {
  registry.registerHandler("customer.privacy.export", exportHandler(deps));
  registry.registerHandler("customer.anonymize", anonymizeHandler(deps));
}

export function registerCustomerPrivacyQueryHandlers(
  registry: Readonly<{ registerHandler: (name: string, handler: CommandHandler) => void }>,
  deps: CustomerHandlerDeps,
): void {
  registry.registerHandler("customer.privacy.status", statusHandler(deps));
  registry.registerHandler("customer.privacy.events", eventsHandler(deps));
}
