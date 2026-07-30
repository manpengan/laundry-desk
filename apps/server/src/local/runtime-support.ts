import { randomBytes } from "node:crypto";

import {
  createMemoryAuditQueryStore,
  createMemoryFeaturesStore,
  createMemorySettingsStore,
} from "../platform/index.js";
import type { PlatformHandlerDeps } from "../platform/handlers.js";

export function buildPlatform(persistence: "memory" | "sql" = "memory"): PlatformHandlerDeps {
  return Object.freeze({
    persistence,
    settings: createMemorySettingsStore(),
    features: createMemoryFeaturesStore(),
    audit: createMemoryAuditQueryStore(),
  });
}

export function mintRuntimeSecret(): string {
  return randomBytes(32).toString("base64url");
}
