/**
 * M1 handler registration — loads A6 command/query definitions and attaches handlers.
 * Optional M2 order/catalog/print/stats/customer/shift + M3 photo when deps provided.
 */

import type { ChainPortHooks } from "../bus/chain-adapter.js";
import { createM1CommandRegistry, type MutableCommandRegistry } from "../bus/registry.js";
import { createM1QueryRegistry, type MutableQueryRegistry } from "../bus/query-registry.js";
import type { CatalogHandlerDeps } from "../catalog/handlers.js";
import { registerCatalogQueryHandlers } from "../catalog/handlers.js";
import type { CustomerHandlerDeps } from "../customer/handlers.js";
import {
  registerCustomerCommandHandlers,
  registerCustomerQueryHandlers,
} from "../customer/handlers.js";
import type { OrderHandlerDeps } from "../order/handlers.js";
import { registerOrderCommandHandlers, registerOrderQueryHandlers } from "../order/handlers.js";
import type { PhotoHandlerDeps } from "../photo/handlers.js";
import { registerPhotoCommandHandlers, registerPhotoQueryHandlers } from "../photo/handlers.js";
import type { PrintHandlerDeps } from "../print/handlers.js";
import { registerPrintCommandHandlers, registerPrintQueryHandlers } from "../print/handlers.js";
import type { ShiftHandlerDeps } from "../shift/handlers.js";
import { registerShiftCommandHandlers, registerShiftQueryHandlers } from "../shift/handlers.js";
import type { StatsHandlerDeps } from "../stats/handlers.js";
import { registerStatsQueryHandlers } from "../stats/handlers.js";
import type { IdentityHandlerDeps } from "./identity-handlers.js";
import { registerIdentityCommandHandlers } from "./identity-handlers.js";
import type { PlatformHandlerDeps } from "./platform-handlers.js";
import { registerPlatformHandlers, registerPlatformQueryHandlers } from "./platform-handlers.js";
import { createDefaultChainHooks } from "./default-chain-hooks.js";

export type RegisterM1Deps = Readonly<{
  identity?: IdentityHandlerDeps;
  platform?: PlatformHandlerDeps;
  /** M2 skeleton order receive/pickup/get (memory or PG store). */
  order?: OrderHandlerDeps;
  /** M2 catalog price list (memory or PG). */
  catalog?: CatalogHandlerDeps;
  /** M2 print ticket job queue (memory or PG). */
  print?: PrintHandlerDeps;
  /** M2 day stats (order-backed or seeded). */
  stats?: StatsHandlerDeps;
  /** M2 customer archive (memory or PG). */
  customer?: CustomerHandlerDeps;
  /** M2 shift closing / 日结签字 (memory). */
  shift?: ShiftHandlerDeps;
  /** M3 garment photo metadata (memory). */
  photo?: PhotoHandlerDeps;
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

  if (deps.print !== undefined) {
    registerPrintCommandHandlers(registry, deps.print);
    registered.push(
      "print.ticket.enqueue",
      "print.ticket.process",
      "print.ticket.retry",
      "print.ticket.reprint",
    );
  }

  if (deps.customer !== undefined) {
    registerCustomerCommandHandlers(registry, deps.customer);
    registered.push("customer.upsert");
  }

  if (deps.shift !== undefined) {
    registerShiftCommandHandlers(registry, deps.shift);
    registered.push("shift.close");
  }

  if (deps.photo !== undefined) {
    registerPhotoCommandHandlers(registry, deps.photo);
    registered.push("photo.register");
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

  if (deps.order !== undefined) {
    registerOrderQueryHandlers(queryRegistry, deps.order);
    names.push("order.get");
  }

  if (deps.print !== undefined) {
    registerPrintQueryHandlers(queryRegistry, deps.print);
    names.push("print.jobs.list");
  }

  if (deps.stats !== undefined) {
    registerStatsQueryHandlers(queryRegistry, deps.stats);
    names.push("stats.day.summary");
  }

  if (deps.customer !== undefined) {
    registerCustomerQueryHandlers(queryRegistry, deps.customer);
    names.push("customer.search");
  }

  if (deps.shift !== undefined) {
    registerShiftQueryHandlers(queryRegistry, deps.shift);
    names.push("shift.get");
  }

  if (deps.photo !== undefined) {
    registerPhotoQueryHandlers(queryRegistry, deps.photo);
    names.push("photo.list_by_order");
  }

  return Object.freeze(names);
}

/**
 * Convenience: fresh M1 command + query registries + handlers + default chain hooks.
 * Query registry includes M2 catalog + order + print + stats + customer + shift + M3 photo;
 * handlers attach when deps set.
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
