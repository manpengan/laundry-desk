import {
  StoreAuthorizedListInputSchema,
  StoreAuthorizedListResultSchema,
  StoreProfileSetInputSchema,
  StoreProfileSetResultSchema,
  createCommandError,
} from "@laundry/contracts";

import type { MutableQueryRegistry } from "../bus/query-registry.js";
import type { MutableCommandRegistry } from "../bus/registry.js";
import { HandlerCommandError, type CommandHandler, type HandlerOutcome } from "../bus/types.js";
import type { StoreManagementHandlerDeps, StoreProfileSnapshot } from "./types.js";

function requireStoreManage(permissions: readonly string[] | undefined): void {
  if (permissions?.includes("store_manage") !== true) {
    throw new HandlerCommandError(createCommandError("PERMISSION_DENIED"));
  }
}

function wireStore(store: StoreProfileSnapshot) {
  return Object.freeze({
    store_code: store.storeCode,
    store_name: store.storeName,
    timezone: store.timeZone,
    profile_version: store.profileVersion,
    updated_at: store.updatedAt.toISOString(),
    is_current: store.isCurrent,
  });
}

function validNow(deps: StoreManagementHandlerDeps): Date {
  const now = deps.now?.() ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new HandlerCommandError(createCommandError("TRANSACTION_FAILED"));
  }
  return now;
}

export function createStoreManagementHandlers(
  deps: StoreManagementHandlerDeps,
): Readonly<Record<"store.authorized.list" | "store.profile.set", CommandHandler>> {
  const list: CommandHandler = async (context): Promise<HandlerOutcome> => {
    requireStoreManage(context.actor.permissions);
    StoreAuthorizedListInputSchema.parse(context.parsed);
    const directory = await deps.store.listAuthorized(context.client, context.tenant);
    const result = StoreAuthorizedListResultSchema.parse({
      returned_store_count: directory.stores.length,
      truncated: directory.truncated,
      stores: directory.stores.map(wireStore),
    });
    return Object.freeze({ result });
  };

  const set: CommandHandler = async (context): Promise<HandlerOutcome> => {
    requireStoreManage(context.actor.permissions);
    const input = StoreProfileSetInputSchema.parse(context.parsed);
    const changed = await deps.store.updateCurrent(context.client, context.tenant, {
      expectedProfileVersion: input.expected_profile_version,
      storeName: input.store_name,
      at: validNow(deps),
    });
    if (!changed.ok) {
      const code = changed.reason === "stale" ? "IDEMPOTENCY_CONFLICT" : "INVARIANT_FAILED";
      throw new HandlerCommandError(createCommandError(code));
    }
    const result = StoreProfileSetResultSchema.parse({ store: wireStore(changed.after) });
    return Object.freeze({
      result,
      audit: Object.freeze({
        entity: "store_profile",
        entityId: changed.after.storeCode,
        beforeJson: JSON.stringify({
          store_code: changed.before.storeCode,
          store_name: changed.before.storeName,
          profile_version: changed.before.profileVersion,
        }),
        afterJson: JSON.stringify({
          store_code: changed.after.storeCode,
          store_name: changed.after.storeName,
          profile_version: changed.after.profileVersion,
          reason: input.reason,
        }),
      }),
      events: Object.freeze([
        Object.freeze({
          type: "store.profile_changed",
          payload: Object.freeze({
            store_code: changed.after.storeCode,
            profile_version: changed.after.profileVersion,
          }),
        }),
      ]),
    });
  };

  return Object.freeze({ "store.authorized.list": list, "store.profile.set": set });
}

export function registerStoreManagementHandlers(
  commandRegistry: MutableCommandRegistry,
  queryRegistry: MutableQueryRegistry | null,
  deps: StoreManagementHandlerDeps,
): void {
  const handlers = createStoreManagementHandlers(deps);
  commandRegistry.registerHandler("store.profile.set", handlers["store.profile.set"]);
  queryRegistry?.registerHandler("store.authorized.list", handlers["store.authorized.list"]);
}
