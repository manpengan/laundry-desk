/**
 * M1 platform handlers on the C1 bus — thin wrapper over C7 createPlatformHandlers.
 * Routes / AI / workers must call executeCommand after registration, never raw stores.
 */

import type { CommandHandler } from "../bus/types.js";
import {
  createPlatformHandlers,
  platformHandlerNames,
  registerPlatformCommandHandlers,
  type PlatformHandlerDeps,
} from "../platform/handlers.js";

export type {
  PlatformHandlerDeps,
  PlatformHandlerMap,
  PlatformHandlerName,
} from "../platform/handlers.js";

export { createPlatformHandlers, platformHandlerNames, registerPlatformCommandHandlers };

/**
 * Alias used by registerM1Handlers — registers only platform *commands*
 * (platform.settings.set). Queries stay off the command bus.
 */
export function registerPlatformHandlers(
  registry: Readonly<{ registerHandler: (name: string, handler: CommandHandler) => void }>,
  deps: PlatformHandlerDeps,
): void {
  registerPlatformCommandHandlers(registry, deps);
}
