/**
 * M1 bus handler wiring (identity + platform + default chain hooks).
 */

export {
  actorPermissionSet,
  createDefaultChainHooks,
  defaultCheckInvariants,
  defaultCheckPolicy,
  defaultCheckRbac,
  defaultCheckTenant,
  requiredPermissionsFromInvariants,
} from "./default-chain-hooks.js";

export {
  createIdentityHandlers,
  identityHandlerNames,
  registerIdentityCommandHandlers,
  toAccessSessionResponse,
} from "./identity-handlers.js";
export type {
  IdentityHandlerDeps,
  IdentityHandlerMap,
  IdentityHandlerName,
  IdentitySessionBinding,
} from "./identity-handlers.js";

export {
  createPlatformHandlers,
  platformHandlerNames,
  registerPlatformCommandHandlers,
  registerPlatformHandlers,
} from "./platform-handlers.js";
export type {
  PlatformHandlerDeps,
  PlatformHandlerMap,
  PlatformHandlerName,
} from "./platform-handlers.js";

export { createRegisteredM1Bus, registerM1Handlers } from "./register-m1.js";
export type { RegisterM1Deps, RegisterM1Result } from "./register-m1.js";
