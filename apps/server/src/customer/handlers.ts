/**
 * M2 customer handlers: customer.search + customer.upsert.
 */

import { createCommandError } from "@laundry/contracts";

import type { CommandHandler, HandlerOutcome } from "../bus/types.js";
import { HandlerCommandError } from "../bus/types.js";
import type { CustomerStore } from "./types.js";

export type CustomerHandlerDeps = Readonly<{
  store: CustomerStore;
  now?: () => number;
}>;

const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 50;

function asRecord(parsed: unknown): Readonly<Record<string, unknown>> {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
  }
  return parsed as Readonly<Record<string, unknown>>;
}

function requirePhone(value: unknown): string {
  if (typeof value !== "string" || !/^1[3-9]\d{9}$/u.test(value)) {
    throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
  }
  return value;
}

function parseLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_SEARCH_LIMIT;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
  }
  return Math.min(value, MAX_SEARCH_LIMIT);
}

function searchHandler(deps: CustomerHandlerDeps): CommandHandler {
  return async (ctx): Promise<HandlerOutcome> => {
    const input = asRecord(ctx.parsed);
    const query = typeof input.query === "string" ? input.query : undefined;
    const limit = parseLimit(input.limit);
    const customers = await deps.store.search(query, limit);
    return Object.freeze({
      result: Object.freeze({
        customers: Object.freeze(customers.map((row) => Object.freeze({ ...row }))),
      }),
    });
  };
}

function upsertHandler(deps: CustomerHandlerDeps): CommandHandler {
  return async (ctx): Promise<HandlerOutcome> => {
    const input = asRecord(ctx.parsed);
    const phone = requirePhone(input.phone);
    const name = typeof input.name === "string" ? input.name : undefined;
    const note = typeof input.note === "string" ? input.note : undefined;
    const now = deps.now?.() ?? Math.floor(Date.now() / 1000);

    const outcome = await deps.store.upsert({
      phone,
      ...(name !== undefined ? { name } : {}),
      ...(note !== undefined ? { note } : {}),
      now,
    });

    const { customer, created } = outcome;
    return Object.freeze({
      result: Object.freeze({
        customer_id: customer.customer_id,
        phone: customer.phone,
        name: customer.name,
        created,
      }),
      audit: Object.freeze({
        entity: "customer",
        entityId: customer.customer_id,
        afterJson: JSON.stringify({
          phone: customer.phone,
          name: customer.name,
          created,
        }),
      }),
      events: Object.freeze([
        Object.freeze({
          type: "customer.upserted",
          payload: Object.freeze({
            customer_id: customer.customer_id,
            phone: customer.phone,
            created,
          }),
        }),
      ]),
    });
  };
}

export function registerCustomerCommandHandlers(
  registry: Readonly<{ registerHandler: (name: string, handler: CommandHandler) => void }>,
  deps: CustomerHandlerDeps,
): void {
  registry.registerHandler("customer.upsert", upsertHandler(deps));
}

export function registerCustomerQueryHandlers(
  registry: Readonly<{ registerHandler: (name: string, handler: CommandHandler) => void }>,
  deps: CustomerHandlerDeps,
): void {
  registry.registerHandler("customer.search", searchHandler(deps));
}
