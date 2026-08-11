import { z } from "zod";

import {
  defineCommand,
  defineQuery,
  type CommandDefinition,
  type QueryDefinition,
} from "../registry/definitions.js";

const POSTGRES_INTEGER_MAX = 2_147_483_647;

export const PricingAddonCodeSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,31}$/u, "Expected lowercase addon code");

export const PricingAddonSchema = z.strictObject({
  code: PricingAddonCodeSchema,
  name: z.string().trim().min(1).max(64),
  unit_price_cents: z.number().int().nonnegative().max(POSTGRES_INTEGER_MAX),
  is_active: z.boolean(),
  sort_order: z.number().int().nonnegative().max(9_999),
});

export const PricingPolicySchema = z.strictObject({
  version: z.number().int().nonnegative(),
  urgent_cents: z.number().int().nonnegative().max(POSTGRES_INTEGER_MAX),
  freight_cents: z.number().int().nonnegative().max(POSTGRES_INTEGER_MAX),
  addons: z.array(PricingAddonSchema).max(50),
  updated_at: z.number().int().nonnegative().nullable(),
});

export const PricingPolicyGetInputSchema = z.strictObject({});

export const PricingPolicySetInputSchema = z.strictObject({
  expected_version: z
    .number()
    .int()
    .nonnegative()
    .max(POSTGRES_INTEGER_MAX - 1),
  urgent_cents: z.number().int().nonnegative().max(POSTGRES_INTEGER_MAX),
  freight_cents: z.number().int().nonnegative().max(POSTGRES_INTEGER_MAX),
  addons: z.array(PricingAddonSchema).max(50),
});

export const PricingPolicyGetResultSchema = z.strictObject({
  policy: PricingPolicySchema,
});

type GetInput = typeof PricingPolicyGetInputSchema;
type SetInput = typeof PricingPolicySetInputSchema;

export const pricingPolicyGetQuery: QueryDefinition<GetInput> = defineQuery({
  name: "pricing.policy.get",
  version: "0.1.0",
  description: "Load the authenticated store's server-authoritative counter pricing policy.",
  description_llm:
    "Return fixed urgent/freight integer cents and the bounded add-on catalog for the authenticated store. The caller cannot select another store.",
  input: PricingPolicyGetInputSchema,
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

export const pricingPolicySetCommand: CommandDefinition<SetInput> = defineCommand({
  name: "pricing.policy.set",
  version: "0.1.0",
  description: "Replace one store's counter pricing policy using optimistic version matching.",
  description_llm:
    "Not exposed to AI. R5 store pricing maintenance requires another administrator's step-up approval. All amounts are integer cents.",
  input: PricingPolicySetInputSchema,
  risk: "R5",
  invariants: ["rbac.settings_admin", "pricing.version_matches"],
  idempotent: true,
  sideEffects: ["pricing.policy.changed", "audit.config_event"],
  offline_mode: "denied",
  data_classification: "internal",
  input_redaction: [],
  result_redaction: [],
  size_measures: {
    batch: { kind: "array_length", path: "/addons" },
  },
  hard_limits: { max_batch: 50 },
});

export const PRICING_COMMANDS: readonly CommandDefinition<z.ZodObject>[] = Object.freeze([
  pricingPolicySetCommand,
]);

export const PRICING_QUERIES: readonly QueryDefinition<z.ZodObject>[] = Object.freeze([
  pricingPolicyGetQuery,
]);

export const PRICING_COMMAND_NAMES = Object.freeze(
  PRICING_COMMANDS.map((command) => command.name),
) as readonly ["pricing.policy.set"];

export const PRICING_QUERY_NAMES = Object.freeze(
  PRICING_QUERIES.map((query) => query.name),
) as readonly ["pricing.policy.get"];

export type PricingAddon = z.infer<typeof PricingAddonSchema>;
export type PricingPolicy = z.infer<typeof PricingPolicySchema>;
export type PricingPolicySetInput = z.infer<typeof PricingPolicySetInputSchema>;
