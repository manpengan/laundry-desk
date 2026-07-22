/**
 * M1 handler registration — loads A6 command/query definitions and attaches handlers.
 * Optional M2 order commands + catalog queries when deps provided.
 */

import type { ChainPortHooks } from "../bus/chain-adapter.js";
import { createM1CommandRegistry, type MutableCommandRegistry } from "../bus/registry.js";
import { createM1QueryRegistry, type MutableQueryRegistry } from "../bus/query-registry.js";
import type { CatalogHandlerDeps } from "../catalog/handlers.js";
import { registerCatalogQueryHandlers } from "../catalog/handlers.js";
import type { OrderHandlerDeps } from "../order/handlers.js";
import { registerOrderCommandHandlers } from "../order/handlers.js";
import type { IdentityHandlerDeps } from "./identity-handlers.js";
import { registerIdentityCommandHandlers } from "./identity-handlers.js";
import type { PlatformHandlerDeps } from "./platform-handlers.js";
import { registerPlatformHandlers, registerPlatformQueryHandlers } from "./platform-handlers.js";
import { createDefaultChainHooks } from "./default-chain-hooks.js";

export type RegisterM1Deps = Readonly<{
  identity?: IdentityHandlerDeps;
  platform?: PlatformHandlerDeps;
  /** M2 skeleton order receive/pickup (memory or PG store). */
  order?: OrderHandlerDeps;
  /** M2 catalog price list (memory seed). */
  catalog?: CatalogHandlerDeps;
}>;

export type RegisterM1Result = Readonly<{
  registry: MutableCommandRegistry;
  queryRegistry: MutableQueryRegistry;
  chainHooks: ChainPortHooks;
  registered: readonly string[];
  registeredQueries: readonly string[];
}>;

/**
 * Create an M1 registry, attach available identity/platform handlers, and
 * return default chain hooks (parse via definition Zod; policy via C5).
 */
export function registerM1Handlers(
  registry: MutableCommandRegistry,
  deps: RegisterM1Deps,
): readonly string[] {
  const registered: string[] = [];

  if (deps.identity !== undefined) {
    registerIdentityCommandHandlers(registry, deps.identity);
    registered.push(
      "identity.login",
      "identity.refresh",
      "identity.logout",
      "identity.pin_challenge",
      "identity.pin_verify",
    );
  }

  if (deps.platform !== undefined) {
    registerPlatformHandlers(registry, deps.platform);
    registered.push("platform.settings.set");
  }

  if (deps.order !== undefined) {
    registerOrderCommandHandlers(registry, deps.order);
    registered.push("order.receive", "order.pickup");
  }

  return Object.freeze(registered);
}

export function registerM1QueryHandlers(
  queryRegistry: MutableQueryRegistry,
  deps: RegisterM1Deps,
): readonly string[] {
  const names: string[] = [];

  if (deps.platform !== undefined) {
    registerPlatformQueryHandlers(queryRegistry, deps.platform);
    names.push("platform.settings.get", "platform.store_features.get", "platform.audit.list");
  }

  if (deps.catalog !== undefined) {
    registerCatalogQueryHandlers(queryRegistry, deps.catalog);
    names.push("catalog.items.list", "catalog.items.get");
  }

  return Object.freeze(names);
}

/**
 * Convenience: fresh M1 command + query registries + handlers + default chain hooks.
 * Query registry includes M2 catalog definitions; handlers attach only when deps set.
 */
export function createRegisteredM1Bus(deps: RegisterM1Deps): RegisterM1Result {
  const registry = createM1CommandRegistry();
  const queryRegistry = createM1QueryRegistry();
  const registered = registerM1Handlers(registry, deps);
  const registeredQueries = registerM1QueryHandlers(queryRegistry, deps);
  return Object.freeze({
    registry,
    queryRegistry,
    chainHooks: createDefaultChainHooks(),
    registered,
    registeredQueries,
  });
}
