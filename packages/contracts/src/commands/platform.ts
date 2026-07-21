import { z } from "zod";

import {
  defineCommand,
  defineQuery,
  type CommandDefinition,
  type QueryDefinition,
} from "../registry/definitions.js";

const SettingsKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/u, "Expected dotted settings key");

export const PlatformSettingsGetInputSchema = z.strictObject({
  keys: z.array(SettingsKeySchema).min(1).max(50),
});

export const PlatformSettingsSetInputSchema = z.strictObject({
  entries: z
    .array(
      z.strictObject({
        key: SettingsKeySchema,
        value_json: z.string().max(8_192),
      }),
    )
    .min(1)
    .max(20),
});

export const PlatformStoreFeaturesGetInputSchema = z.strictObject({
  store_id: z.uuid(),
});

export const PlatformAuditListInputSchema = z.strictObject({
  from_epoch_s: z.number().int().nonnegative(),
  to_epoch_s: z.number().int().nonnegative(),
  limit: z.number().int().positive().max(200),
});

type SettingsGetInput = typeof PlatformSettingsGetInputSchema;
type SettingsSetInput = typeof PlatformSettingsSetInputSchema;
type FeaturesGetInput = typeof PlatformStoreFeaturesGetInputSchema;
type AuditListInput = typeof PlatformAuditListInputSchema;

/**
 * A6 platform command/query catalog (contract-only).
 * Runtime C7 must execute only through the command bus.
 */

export const platformSettingsGetQuery: QueryDefinition<SettingsGetInput> = defineQuery({
  name: "platform.settings.get",
  version: "1.0.0",
  description: "Read store/org settings values by key list.",
  description_llm: "Fetch settings for the declared keys only. Never invent keys.",
  input: PlatformSettingsGetInputSchema,
  risk: "R1",
  invariants: [],
  idempotent: true,
  sideEffects: [],
  offline_mode: "denied",
  data_classification: "internal",
  input_redaction: [],
  result_redaction: [],
  max_result_rows: 50,
});

export const platformSettingsSetCommand: CommandDefinition<SettingsSetInput> = defineCommand({
  name: "platform.settings.set",
  version: "1.0.0",
  description: "Update system/store settings entries (high risk).",
  description_llm:
    "Persist settings key/value pairs. System settings are R5 and never AI-projectable.",
  input: PlatformSettingsSetInputSchema,
  risk: "R5",
  invariants: ["platform.settings_writable", "rbac.settings_admin"],
  idempotent: true,
  sideEffects: ["platform.settings_changed", "audit.config_event"],
  offline_mode: "denied",
  data_classification: "internal",
  input_redaction: [],
  result_redaction: [],
  size_measures: {
    batch: { kind: "array_length", path: "/entries" },
  },
  hard_limits: { max_batch: 20 },
});

export const platformStoreFeaturesGetQuery: QueryDefinition<FeaturesGetInput> = defineQuery({
  name: "platform.store_features.get",
  version: "1.0.0",
  description: "Read feature flags for one store.",
  description_llm: "Return store_features flags for IA and capability gates.",
  input: PlatformStoreFeaturesGetInputSchema,
  risk: "R0",
  invariants: [],
  idempotent: true,
  sideEffects: [],
  offline_mode: "denied",
  data_classification: "internal",
  input_redaction: [],
  result_redaction: [],
  max_result_rows: 1,
});

export const platformAuditListQuery: QueryDefinition<AuditListInput> = defineQuery({
  name: "platform.audit.list",
  version: "1.0.0",
  description: "List audit events in a time window (read-only).",
  description_llm: "Query audit_log rows in [from,to] with a hard row cap. PII may appear.",
  input: PlatformAuditListInputSchema,
  risk: "R2",
  invariants: [],
  idempotent: true,
  sideEffects: [],
  offline_mode: "denied",
  data_classification: "pii",
  input_redaction: [],
  result_redaction: [{ path: "/items", strategy: "mask" }],
  max_result_rows: 200,
});

export const PLATFORM_COMMANDS: readonly CommandDefinition<z.ZodObject>[] = Object.freeze([
  platformSettingsSetCommand,
]);

export const PLATFORM_QUERIES: readonly QueryDefinition<z.ZodObject>[] = Object.freeze([
  platformSettingsGetQuery,
  platformStoreFeaturesGetQuery,
  platformAuditListQuery,
]);

export const PLATFORM_DEFINITIONS = Object.freeze([
  ...PLATFORM_COMMANDS,
  ...PLATFORM_QUERIES,
] as const);
