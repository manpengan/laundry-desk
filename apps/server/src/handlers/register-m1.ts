/**
 * M1 handler registration — loads A6 command definitions and attaches real handlers.
 */

import type { ChainPortHooks } from "../bus/chain-adapter.js";
import { createM1CommandRegistry, type MutableCommandRegistry } from "../bus/registry.js";
import type { IdentityHandlerDeps } from "./identity-handlers.js";
import { registerIdentityCommandHandlers } from "./identity-handlers.js";
import type { PlatformHandlerDeps } from "./platform-handlers.js";
import { registerPlatformHandlers } from "./platform-handlers.js";
import { createDefaultChainHooks } from "./default-chain-hooks.js";

export type RegisterM1Deps = Readonly<{
  identity?: IdentityHandlerDeps;
  platform?: PlatformHandlerDeps;
}>;

export type RegisterM1Result = Readonly<{
  registry: MutableCommandRegistry;
  chainHooks: ChainPortHooks;
  registered: readonly string[];
}>;

/**
 * Create an M1 registry, attach available identity/platform handlers, and
 * return default chain hooks (parse via definition Zod; policy via C5).
 *
 * Only A6 *commands* are registered (queries are not on the C1 command bus).
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

  return Object.freeze(registered);
}

/**
 * Convenience: fresh M1 registry + handlers + default chain hooks.
 */
export function createRegisteredM1Bus(deps: RegisterM1Deps): RegisterM1Result {
  const registry = createM1CommandRegistry();
  const registered = registerM1Handlers(registry, deps);
  return Object.freeze({
    registry,
    chainHooks: createDefaultChainHooks(),
    registered,
  });
}
