import type { MutableQueryRegistry } from "../bus/query-registry.js";
import type { MutableCommandRegistry } from "../bus/registry.js";
import { createStoreManagementHandlers } from "./handlers.js";
import type { StoreManagementHandlerDeps } from "./types.js";

export type HandlerDeps = StoreManagementHandlerDeps;

const COMMAND_NAMES = Object.freeze(["store.profile.set"] as const);
const QUERY_NAMES = Object.freeze(["store.authorized.list"] as const);

export function registerCommands(
  registry: MutableCommandRegistry,
  deps: StoreManagementHandlerDeps | undefined,
): readonly string[] {
  if (deps === undefined) return Object.freeze([]);
  const handlers = createStoreManagementHandlers(deps);
  registry.registerHandler("store.profile.set", handlers["store.profile.set"]);
  return COMMAND_NAMES;
}

export function registerQueries(
  registry: MutableQueryRegistry,
  deps: StoreManagementHandlerDeps | undefined,
): readonly string[] {
  if (deps === undefined) return Object.freeze([]);
  const handlers = createStoreManagementHandlers(deps);
  registry.registerHandler("store.authorized.list", handlers["store.authorized.list"]);
  return QUERY_NAMES;
}
