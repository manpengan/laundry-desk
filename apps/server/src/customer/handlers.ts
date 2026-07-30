/** M2 customer archive handlers with masked list and explicit detail access. */

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

function requireString(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
  }
  return value.trim();
}

function nullableString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
  }
  return value;
}

function maskPhone(phone: string): string {
  return phone.replace(/^(\d{3})\d{4}(\d{4})$/u, "$1****$2");
}

function detailResult(customer: Awaited<ReturnType<CustomerStore["getById"]>>) {
  if (customer === null) {
    throw new HandlerCommandError(createCommandError("RESOURCE_UNAVAILABLE"));
  }
  return Object.freeze({
    customer_id: customer.customer_id,
    phone: customer.phone,
    name: customer.name,
    note: customer.note,
    updated_at: customer.updated_at,
  });
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
        customers: Object.freeze(
          customers.map((row) =>
            Object.freeze({
              customer_id: row.customer_id,
              phone_masked: maskPhone(row.phone),
              name: row.name,
              updated_at: row.updated_at,
            }),
          ),
        ),
      }),
    });
  };
}

function getHandler(deps: CustomerHandlerDeps): CommandHandler {
  return async (ctx): Promise<HandlerOutcome> => {
    const input = asRecord(ctx.parsed);
    const customer = await deps.store.getById(requireString(input.customer_id));
    return Object.freeze({ result: detailResult(customer) });
  };
}

function duplicatesHandler(deps: CustomerHandlerDeps): CommandHandler {
  return async (ctx): Promise<HandlerOutcome> => {
    const input = asRecord(ctx.parsed);
    const customers = await deps.store.findDuplicates(
      requireString(input.customer_id),
      parseLimit(input.limit),
    );
    return Object.freeze({
      result: Object.freeze({
        customers: Object.freeze(
          customers.map((row) =>
            Object.freeze({
              customer_id: row.customer_id,
              phone_masked: maskPhone(row.phone),
              name: row.name,
              updated_at: row.updated_at,
            }),
          ),
        ),
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
          phone_masked: maskPhone(customer.phone),
          name: customer.name,
          created,
        }),
      }),
      events: Object.freeze([
        Object.freeze({
          type: "customer.upserted",
          payload: Object.freeze({
            customer_id: customer.customer_id,
            created,
          }),
        }),
      ]),
    });
  };
}

function updateHandler(deps: CustomerHandlerDeps): CommandHandler {
  return async (ctx): Promise<HandlerOutcome> => {
    const input = asRecord(ctx.parsed);
    const phone = input.phone === undefined ? undefined : requirePhone(input.phone);
    const name = nullableString(input.name);
    const note = nullableString(input.note);
    const updated = await deps.store.update({
      customer_id: requireString(input.customer_id),
      ...(phone === undefined ? {} : { phone }),
      ...(name === undefined ? {} : { name }),
      ...(note === undefined ? {} : { note }),
      now: deps.now?.() ?? Math.floor(Date.now() / 1000),
    });
    if (updated === null) {
      throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
    }
    const changedFields = Object.freeze([
      ...(phone === undefined ? [] : ["phone"]),
      ...(name === undefined ? [] : ["name"]),
      ...(note === undefined ? [] : ["note"]),
    ]);
    return Object.freeze({
      result: detailResult(updated),
      audit: Object.freeze({
        entity: "customer",
        entityId: updated.customer_id,
        afterJson: JSON.stringify({ changed_fields: changedFields }),
      }),
      events: Object.freeze([
        Object.freeze({
          type: "customer.updated",
          payload: Object.freeze({
            customer_id: updated.customer_id,
            changed_fields: changedFields,
          }),
        }),
      ]),
    });
  };
}

function mergeHandler(deps: CustomerHandlerDeps): CommandHandler {
  return async (ctx): Promise<HandlerOutcome> => {
    const input = asRecord(ctx.parsed);
    const sourceCustomerId = requireString(input.source_customer_id);
    const targetCustomerId = requireString(input.target_customer_id);
    const reason = requireString(input.reason);
    const result = await deps.store.merge({
      source_customer_id: sourceCustomerId,
      target_customer_id: targetCustomerId,
      store_id: ctx.tenant.storeId,
      now: deps.now?.() ?? Math.floor(Date.now() / 1000),
    });
    if (result === null) {
      throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
    }
    return Object.freeze({
      result: Object.freeze({ ...result }),
      audit: Object.freeze({
        entity: "customer",
        entityId: sourceCustomerId,
        afterJson: JSON.stringify({
          merged_into_id: targetCustomerId,
          reason,
          relinked_order_count: result.relinked_order_count,
        }),
      }),
      events: Object.freeze([
        Object.freeze({
          type: "customer.merged",
          payload: Object.freeze({
            source_customer_id: sourceCustomerId,
            target_customer_id: targetCustomerId,
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
  registry.registerHandler("customer.update", updateHandler(deps));
  registry.registerHandler("customer.merge", mergeHandler(deps));
}

export function registerCustomerQueryHandlers(
  registry: Readonly<{ registerHandler: (name: string, handler: CommandHandler) => void }>,
  deps: CustomerHandlerDeps,
): void {
  registry.registerHandler("customer.search", searchHandler(deps));
  registry.registerHandler("customer.get", getHandler(deps));
  registry.registerHandler("customer.duplicates", duplicatesHandler(deps));
}
