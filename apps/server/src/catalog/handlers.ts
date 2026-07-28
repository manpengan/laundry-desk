/**
 * M2 catalog query handlers (memory or PG price list).
 */

import { createCommandError } from "@laundry/contracts";
import { filterCatalog, findByCode } from "@laundry/domain";

import type { CommandHandler, HandlerOutcome } from "../bus/types.js";
import { HandlerCommandError } from "../bus/types.js";
import type { CatalogStore } from "./memory-catalog.js";

export type CatalogHandlerDeps = Readonly<{
  store: CatalogStore;
}>;

function asRecord(parsed: unknown): Readonly<Record<string, unknown>> {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
  }
  return parsed as Readonly<Record<string, unknown>>;
}

function requirePositiveInt(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
  }
  return value;
}

function requireString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
  }
  return value;
}

function requireNonNegativeInt(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
  }
  return value;
}

function requireBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
  }
  return value;
}

function listHandler(deps: CatalogHandlerDeps): CommandHandler {
  return async (ctx): Promise<HandlerOutcome> => {
    const input = asRecord(ctx.parsed);
    const limit = requirePositiveInt(input.limit);
    const query = typeof input.query === "string" ? input.query : "";
    const all = await deps.store.listAll();
    const filtered = filterCatalog(all, query);
    const items = filtered.slice(0, limit).map((item) => Object.freeze({ ...item }));
    return Object.freeze({
      result: Object.freeze({
        items: Object.freeze(items),
        total: filtered.length,
      }),
    });
  };
}

function getHandler(deps: CatalogHandlerDeps): CommandHandler {
  return async (ctx): Promise<HandlerOutcome> => {
    const input = asRecord(ctx.parsed);
    const code = requireString(input.code);
    const all = await deps.store.listAll();
    const item = findByCode(all, code);
    return Object.freeze({
      result: Object.freeze({
        item: item === undefined ? null : Object.freeze({ ...item }),
      }),
    });
  };
}

/** ADR-15: operator-only price maintenance. Never projected to AI. */
function upsertHandler(deps: CatalogHandlerDeps): CommandHandler {
  return async (ctx): Promise<HandlerOutcome> => {
    const input = asRecord(ctx.parsed);
    const upsert = deps.store.upsert;
    if (upsert === undefined) {
      throw new HandlerCommandError(createCommandError("RESOURCE_UNAVAILABLE"));
    }
    const mnemonic = typeof input.mnemonic === "string" ? input.mnemonic : undefined;
    const sortOrder = typeof input.sort_order === "number" ? input.sort_order : undefined;
    const result = await upsert({
      code: requireString(input.code),
      name: requireString(input.name),
      service_code: requireString(input.service_code),
      category_code: requireString(input.category_code),
      unit_price_cents: requireNonNegativeInt(input.unit_price_cents),
      ...(mnemonic === undefined ? {} : { mnemonic }),
      is_active: requireBoolean(input.is_active),
      ...(sortOrder === undefined ? {} : { sort_order: sortOrder }),
    });
    return Object.freeze({
      result: Object.freeze({ code: result.code, created: result.created }),
      audit: Object.freeze({
        entity: "catalog_item",
        entityId: result.code,
        afterJson: JSON.stringify({
          code: result.code,
          unit_price_cents: input.unit_price_cents,
          is_active: input.is_active,
          created: result.created,
        }),
      }),
    });
  };
}

export function registerCatalogQueryHandlers(
  registry: Readonly<{ registerHandler: (name: string, handler: CommandHandler) => void }>,
  deps: CatalogHandlerDeps,
): void {
  registry.registerHandler("catalog.items.list", listHandler(deps));
  registry.registerHandler("catalog.items.get", getHandler(deps));
}

export function registerCatalogCommandHandlers(
  registry: Readonly<{ registerHandler: (name: string, handler: CommandHandler) => void }>,
  deps: CatalogHandlerDeps,
): void {
  registry.registerHandler("catalog.item.upsert", upsertHandler(deps));
}
