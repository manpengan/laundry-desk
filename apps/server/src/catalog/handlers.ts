/** Catalog command/query handlers. All writes remain inside the command-bus transaction. */

import {
  CatalogAuditListInputSchema,
  CatalogItemUpsertInputSchema,
  CatalogItemsManageListInputSchema,
  CatalogItemsReorderInputSchema,
  createCommandError,
} from "@laundry/contracts";
import { filterCatalog, findByCode } from "@laundry/domain";

import type { CommandHandler, HandlerOutcome } from "../bus/types.js";
import { HandlerCommandError } from "../bus/types.js";
import type {
  CatalogAuditAction,
  CatalogManagedItem,
  CatalogReorderEntry,
  CatalogStore,
} from "./types.js";

export type CatalogHandlerDeps = Readonly<{ store: CatalogStore }>;

function validationFailed(): never {
  throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
}

function unavailable(): never {
  throw new HandlerCommandError(createCommandError("RESOURCE_UNAVAILABLE"));
}

function asRecord(parsed: unknown): Readonly<Record<string, unknown>> {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) validationFailed();
  return parsed as Readonly<Record<string, unknown>>;
}

function requirePositiveInt(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) validationFailed();
  return value;
}

function requireString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) validationFailed();
  return value;
}

function listHandler(deps: CatalogHandlerDeps): CommandHandler {
  return async (ctx): Promise<HandlerOutcome> => {
    const input = asRecord(ctx.parsed);
    const limit = requirePositiveInt(input.limit);
    const query = typeof input.query === "string" ? input.query : "";
    const filtered = filterCatalog(await deps.store.listAll(), query);
    return Object.freeze({
      result: Object.freeze({
        items: Object.freeze(filtered.slice(0, limit).map((item) => Object.freeze({ ...item }))),
        total: filtered.length,
      }),
    });
  };
}

function getHandler(deps: CatalogHandlerDeps): CommandHandler {
  return async (ctx): Promise<HandlerOutcome> => {
    const code = requireString(asRecord(ctx.parsed).code);
    const item = findByCode(await deps.store.listAll(), code);
    return Object.freeze({
      result: Object.freeze({ item: item === undefined ? null : Object.freeze({ ...item }) }),
    });
  };
}

function manageListHandler(deps: CatalogHandlerDeps): CommandHandler {
  return async (ctx): Promise<HandlerOutcome> => {
    const parsed = CatalogItemsManageListInputSchema.safeParse(ctx.parsed);
    if (!parsed.success) validationFailed();
    const manageList = deps.store.manageList;
    if (manageList === undefined) unavailable();
    const result = await manageList(parsed.data.query ?? "", parsed.data.limit);
    return Object.freeze({ result });
  };
}

function auditListHandler(deps: CatalogHandlerDeps): CommandHandler {
  return async (ctx): Promise<HandlerOutcome> => {
    const parsed = CatalogAuditListInputSchema.safeParse(ctx.parsed);
    if (!parsed.success || parsed.data.from_epoch_s > parsed.data.to_epoch_s) validationFailed();
    const listAudit = deps.store.listAudit;
    if (listAudit === undefined) unavailable();
    const items = await listAudit({
      from_epoch_s: parsed.data.from_epoch_s,
      to_epoch_s: parsed.data.to_epoch_s,
      ...(parsed.data.code === undefined ? {} : { code: parsed.data.code }),
      limit: parsed.data.limit,
    });
    return Object.freeze({ result: Object.freeze({ items }) });
  };
}

function upsertAction(
  before: CatalogManagedItem | null,
  after: CatalogManagedItem,
): CatalogAuditAction {
  if (before === null) return "created";
  if (!before.is_active && after.is_active) return "reactivated";
  if (before.is_active && !after.is_active) return "retired";
  return before.version === after.version ? "unchanged" : "updated";
}

function upsertHandler(deps: CatalogHandlerDeps): CommandHandler {
  return async (ctx): Promise<HandlerOutcome> => {
    const parsed = CatalogItemUpsertInputSchema.safeParse(ctx.parsed);
    if (!parsed.success) validationFailed();
    const upsert = deps.store.upsert;
    if (upsert === undefined) unavailable();
    const input = parsed.data;
    const change = await upsert({
      code: input.code,
      name: input.name,
      service_code: input.service_code,
      category_code: input.category_code,
      unit_price_cents: input.unit_price_cents,
      ...(input.mnemonic === undefined ? {} : { mnemonic: input.mnemonic }),
      is_active: input.is_active,
      ...(input.sort_order === undefined ? {} : { sort_order: input.sort_order }),
      ...(input.expected_version === undefined ? {} : { expected_version: input.expected_version }),
    });
    if (change === null) {
      throw new HandlerCommandError(createCommandError("IDEMPOTENCY_CONFLICT"));
    }
    const action = upsertAction(change.before, change.after);
    return Object.freeze({
      result: Object.freeze({
        code: change.after.code,
        item: change.after,
        created: change.created,
        action,
      }),
      audit: Object.freeze({
        entity: "catalog_item",
        entityId: change.after.code,
        ...(change.before === null ? {} : { beforeJson: JSON.stringify(change.before) }),
        afterJson: JSON.stringify({ action, codes: [change.after.code], item: change.after }),
      }),
      events: Object.freeze([
        Object.freeze({
          type: "catalog.item.changed",
          payload: Object.freeze({
            code: change.after.code,
            version: change.after.version,
            action,
          }),
        }),
      ]),
    });
  };
}

function reorderAuditAction(
  before: readonly CatalogManagedItem[],
  wanted: readonly CatalogReorderEntry[],
): CatalogAuditAction {
  return before.every(
    (item, index) => item.code === wanted[index]?.code && item.sort_order === index,
  )
    ? "unchanged"
    : "reordered";
}

function reorderHandler(deps: CatalogHandlerDeps): CommandHandler {
  return async (ctx): Promise<HandlerOutcome> => {
    const parsed = CatalogItemsReorderInputSchema.safeParse(ctx.parsed);
    if (!parsed.success) validationFailed();
    const codes = parsed.data.items.map((item: CatalogReorderEntry) => item.code);
    if (new Set(codes).size !== codes.length) validationFailed();
    const reorder = deps.store.reorder;
    if (reorder === undefined) unavailable();
    const change = await reorder(parsed.data.items);
    if (change === null) {
      throw new HandlerCommandError(createCommandError("IDEMPOTENCY_CONFLICT"));
    }
    const action = reorderAuditAction(change.before, parsed.data.items);
    const snapshot = (items: readonly CatalogManagedItem[]) =>
      items.map((item) => ({
        code: item.code,
        sort_order: item.sort_order,
        version: item.version,
      }));
    return Object.freeze({
      result: Object.freeze({ items: change.after, action }),
      audit: Object.freeze({
        entity: "catalog",
        entityId: ctx.tenant.storeId,
        beforeJson: JSON.stringify({ items: snapshot(change.before) }),
        afterJson: JSON.stringify({ action, codes, items: snapshot(change.after) }),
      }),
      events: Object.freeze([
        Object.freeze({
          type: "catalog.items.reordered",
          payload: Object.freeze({ codes: Object.freeze([...codes]) }),
        }),
      ]),
    });
  };
}

export function registerCatalogQueryHandlers(
  registry: Readonly<{ registerHandler: (name: string, handler: CommandHandler) => void }>,
  deps: CatalogHandlerDeps,
): void {
  registry.registerHandler("catalog.items.list", listHandler(deps));
  registry.registerHandler("catalog.items.get", getHandler(deps));
  registry.registerHandler("catalog.items.manage.list", manageListHandler(deps));
  registry.registerHandler("catalog.audit.list", auditListHandler(deps));
}

export function registerCatalogCommandHandlers(
  registry: Readonly<{ registerHandler: (name: string, handler: CommandHandler) => void }>,
  deps: CatalogHandlerDeps,
): void {
  registry.registerHandler("catalog.item.upsert", upsertHandler(deps));
  registry.registerHandler("catalog.items.reorder", reorderHandler(deps));
}
