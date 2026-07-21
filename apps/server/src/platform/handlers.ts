/**
 * C7 platform handlers shaped for the C1 command bus.
 * Routes / AI / workers call executeCommand after registerHandler — never raw stores.
 */

import type { CommandHandler, HandlerContext, HandlerOutcome } from "../bus/types.js";
import type { AuditQueryStore } from "./audit-query.js";
import { assertAuditPayloadSafe } from "./audit-query.js";
import type { FeaturesStore } from "./features.js";
import type { SettingsEntry, SettingsStore } from "./settings.js";
import { validateSettingsEntries } from "./settings.js";

export type PlatformHandlerDeps = Readonly<{
  settings: SettingsStore;
  features: FeaturesStore;
  audit: AuditQueryStore;
}>;

/** Bus-shaped handler map keyed by A6 platform command/query names. */
export type PlatformHandlerMap = Readonly<Record<string, CommandHandler>>;

const PLATFORM_HANDLER_NAMES = Object.freeze([
  "platform.settings.get",
  "platform.settings.set",
  "platform.store_features.get",
  "platform.audit.list",
] as const);

export type PlatformHandlerName = (typeof PLATFORM_HANDLER_NAMES)[number];

export function platformHandlerNames(): readonly PlatformHandlerName[] {
  return PLATFORM_HANDLER_NAMES;
}

function asRecord(parsed: unknown): Readonly<Record<string, unknown>> {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError("platform handler expected object input");
  }
  return parsed as Readonly<Record<string, unknown>>;
}

function requireStringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new TypeError(`${field} must be a string array`);
  }
  return value as readonly string[];
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function requireInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new TypeError(`${field} must be an integer`);
  }
  return value;
}

function settingsGetHandler(settings: SettingsStore): CommandHandler {
  return async (ctx: HandlerContext): Promise<HandlerOutcome> => {
    const input = asRecord(ctx.parsed);
    const keys = requireStringArray(input.keys, "keys");
    const values = await settings.getMany(keys);
    return Object.freeze({
      result: Object.freeze({ values }),
    });
  };
}

function settingsSetHandler(settings: SettingsStore): CommandHandler {
  return async (ctx: HandlerContext): Promise<HandlerOutcome> => {
    const input = asRecord(ctx.parsed);
    const rawEntries = input.entries;
    if (!Array.isArray(rawEntries)) {
      throw new TypeError("entries must be an array");
    }
    const entries: SettingsEntry[] = rawEntries.map((entry) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        throw new TypeError("each entry must be an object");
      }
      const record = entry as Record<string, unknown>;
      return Object.freeze({
        key: requireString(record.key, "key"),
        value_json: requireString(record.value_json, "value_json"),
      });
    });
    validateSettingsEntries(entries);
    const before = await settings.getMany(entries.map((entry) => entry.key));
    await settings.setMany(entries);
    const after = await settings.getMany(entries.map((entry) => entry.key));
    return Object.freeze({
      result: Object.freeze({ updated: entries.length }),
      audit: Object.freeze({
        entity: "settings",
        entityId: entries.map((entry) => entry.key).join(","),
        beforeJson: JSON.stringify(before),
        afterJson: JSON.stringify(after),
      }),
      events: Object.freeze([
        Object.freeze({
          type: "platform.settings_changed",
          payload: Object.freeze({ keys: entries.map((entry) => entry.key) }),
        }),
      ]),
    });
  };
}

function storeFeaturesGetHandler(features: FeaturesStore): CommandHandler {
  return async (ctx: HandlerContext): Promise<HandlerOutcome> => {
    const input = asRecord(ctx.parsed);
    const storeId = requireString(input.store_id, "store_id");
    const flags = await features.get(storeId);
    return Object.freeze({
      result: Object.freeze({ store_id: storeId, features: flags }),
    });
  };
}

function auditListHandler(audit: AuditQueryStore): CommandHandler {
  return async (ctx: HandlerContext): Promise<HandlerOutcome> => {
    const input = asRecord(ctx.parsed);
    const fromEpochS = requireInt(input.from_epoch_s, "from_epoch_s");
    const toEpochS = requireInt(input.to_epoch_s, "to_epoch_s");
    const limit = requireInt(input.limit, "limit");
    const items = await audit.list({
      orgId: ctx.tenant.orgId,
      storeId: ctx.tenant.storeId,
      fromEpochS,
      toEpochS,
      limit,
    });
    assertAuditPayloadSafe(items);
    return Object.freeze({
      result: Object.freeze({ items }),
    });
  };
}

/**
 * Build bus-shaped handlers for A6 platform names.
 * Register onto MutableCommandRegistry via registerHandler for commands;
 * query names are executable through the same handler map when a query bus lands.
 */
export function createPlatformHandlers(deps: PlatformHandlerDeps): PlatformHandlerMap {
  return Object.freeze({
    "platform.settings.get": settingsGetHandler(deps.settings),
    "platform.settings.set": settingsSetHandler(deps.settings),
    "platform.store_features.get": storeFeaturesGetHandler(deps.features),
    "platform.audit.list": auditListHandler(deps.audit),
  });
}

/**
 * Register platform *command* handlers onto a C1 registry.
 * Queries are returned by createPlatformHandlers but not registered on the command bus.
 */
export function registerPlatformCommandHandlers(
  registry: Readonly<{ registerHandler: (name: string, handler: CommandHandler) => void }>,
  deps: PlatformHandlerDeps,
): void {
  const handlers = createPlatformHandlers(deps);
  registry.registerHandler("platform.settings.set", handlers["platform.settings.set"]!);
}
