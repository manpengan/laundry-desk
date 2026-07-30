import { randomUUID } from "node:crypto";

import { createCommandError } from "@laundry/contracts";

import type { CommandHandler, HandlerOutcome } from "../bus/types.js";
import { HandlerCommandError } from "../bus/types.js";
import type { CustomerHandlerDeps } from "./handlers.js";

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
    return Object.freeze({
      result: exported,
      audit: Object.freeze({
        entity: "customer_privacy",
        entityId: customerId,
        afterJson: JSON.stringify({
          action: "exported",
          order_count: exported.order_count,
          truncated: exported.truncated,
        }),
      }),
      events: Object.freeze([
        Object.freeze({
          type: "customer.privacy_exported",
          payload: Object.freeze({
            customer_id: customerId,
            order_count: exported.order_count,
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
    return Object.freeze({
      result,
      audit: Object.freeze({
        entity: "customer_privacy",
        entityId: customerId,
        afterJson: JSON.stringify({
          action: "anonymized",
          affected_order_count: result.affected_order_count,
        }),
      }),
      events: Object.freeze([
        Object.freeze({
          type: "customer.anonymized",
          payload: Object.freeze({
            customer_id: customerId,
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
