/**
 * C7 platform surface for wiring.
 *
 * Public write entry for apps is createPlatformHandlers / registerPlatformCommandHandlers.
 * Memory/SQL stores are DI for bootstrap + tests — routes must not import them.
 */

export {
  createPlatformHandlers,
  platformHandlerNames,
  registerPlatformCommandHandlers,
  registerPlatformQueryHandlers,
} from "./handlers.js";
export type {
  PlatformHandlerDeps,
  PlatformHandlerMap,
  PlatformHandlerName,
  PlatformPersistence,
} from "./handlers.js";

export {
  assertAmountInt,
  createMemorySettingsStore,
  createSqlSettingsStore,
  isAmountSettingsKey,
  parseSettingsValueJson,
  validateSettingsEntries,
} from "./settings.js";
export type { SettingsEntry, SettingsStore } from "./settings.js";

export {
  DEFAULT_STORE_FEATURES,
  createMemoryFeaturesStore,
  createSqlFeaturesStore,
} from "./features.js";
export type { FeaturesStore, StoreFeatureFlags } from "./features.js";

export {
  assertAuditPayloadSafe,
  createMemoryAuditQueryStore,
  createSqlAuditQueryStore,
  jsonLooksSecret,
  projectAuditListItem,
} from "./audit-query.js";
export type { AuditListFilter, AuditListItem, AuditQueryStore } from "./audit-query.js";
