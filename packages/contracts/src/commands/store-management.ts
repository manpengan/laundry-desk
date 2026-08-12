import { z } from "zod";

import { ExactUtcTimestampSchema } from "../edge/primitives.js";
import {
  defineCommand,
  defineQuery,
  type CommandDefinition,
  type QueryDefinition,
} from "../registry/definitions.js";

const AUTHORIZED_STORE_LIMIT = 50;
const PositiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const StoreCodeSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[\x21-\x7e]+$/u, "store code must contain visible ASCII only");

const StoreNameSchema = z.string().trim().min(1).max(128);

function isIanaTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

export const StoreTimeZoneSchema = z.string().min(1).max(64).refine(isIanaTimeZone, {
  message: "timezone must be a valid IANA name",
});

export const AuthorizedStoreSchema = z.strictObject({
  store_code: StoreCodeSchema,
  store_name: StoreNameSchema,
  timezone: StoreTimeZoneSchema,
  profile_version: PositiveSafeIntegerSchema,
  updated_at: ExactUtcTimestampSchema,
  is_current: z.boolean(),
});

export const StoreAuthorizedListInputSchema = z.strictObject({});

export const StoreAuthorizedListResultSchema = z
  .strictObject({
    returned_store_count: z.number().int().nonnegative().max(AUTHORIZED_STORE_LIMIT),
    truncated: z.boolean(),
    stores: z.array(AuthorizedStoreSchema).max(AUTHORIZED_STORE_LIMIT),
  })
  .superRefine((value, context) => {
    if (value.returned_store_count !== value.stores.length) {
      context.addIssue({
        code: "custom",
        path: ["returned_store_count"],
        message: "invalid count",
      });
    }
    if (value.truncated && value.stores.length !== AUTHORIZED_STORE_LIMIT) {
      context.addIssue({ code: "custom", path: ["truncated"], message: "invalid truncation" });
    }
    const codes = value.stores.map((store) => store.store_code);
    if (
      new Set(codes).size !== codes.length ||
      codes.some((code, index) => index > 0 && code < codes[index - 1]!)
    ) {
      context.addIssue({
        code: "custom",
        path: ["stores"],
        message: "stores must be unique and sorted",
      });
    }
    if (value.stores.filter((store) => store.is_current).length !== 1) {
      context.addIssue({
        code: "custom",
        path: ["stores"],
        message: "exactly one current store is required",
      });
    }
  });

export const StoreProfileSetInputSchema = z.strictObject({
  expected_profile_version: PositiveSafeIntegerSchema,
  store_name: StoreNameSchema,
  reason: z.string().trim().min(1).max(256),
});

export const StoreProfileSetResultSchema = z.strictObject({
  store: AuthorizedStoreSchema.extend({ is_current: z.literal(true) }),
});

export const storeAuthorizedListQuery: QueryDefinition<typeof StoreAuthorizedListInputSchema> =
  defineQuery({
    name: "store.authorized.list",
    version: "0.1.0",
    description: "List at most 50 stores where the current actor remains an active admin.",
    description_llm:
      "Owner store directory. The server derives organization and actor from the active session.",
    input: StoreAuthorizedListInputSchema,
    risk: "R2",
    invariants: ["rbac.store_manage"],
    idempotent: true,
    sideEffects: [],
    offline_mode: "denied",
    data_classification: "internal",
    input_redaction: [],
    result_redaction: [],
    max_result_rows: AUTHORIZED_STORE_LIMIT,
  });

export const storeProfileSetCommand: CommandDefinition<typeof StoreProfileSetInputSchema> =
  defineCommand({
    name: "store.profile.set",
    version: "0.1.0",
    description: "Rename the authenticated store with optimistic concurrency and audit.",
    description_llm:
      "R5 current-store profile change. It never accepts a target organization or store.",
    input: StoreProfileSetInputSchema,
    risk: "R5",
    invariants: ["rbac.store_manage"],
    idempotent: true,
    sideEffects: ["store.profile_changed", "audit.store_profile_changed"],
    offline_mode: "denied",
    data_classification: "internal",
    input_redaction: [{ path: "/reason", strategy: "mask" }],
    result_redaction: [],
  });

export const STORE_MANAGEMENT_COMMANDS = Object.freeze([storeProfileSetCommand] as const);
export const STORE_MANAGEMENT_QUERIES = Object.freeze([storeAuthorizedListQuery] as const);
export const STORE_MANAGEMENT_COMMAND_NAMES = Object.freeze(["store.profile.set"] as const);
export const STORE_MANAGEMENT_QUERY_NAMES = Object.freeze(["store.authorized.list"] as const);

export type AuthorizedStore = z.output<typeof AuthorizedStoreSchema>;
export type StoreAuthorizedListResult = z.output<typeof StoreAuthorizedListResultSchema>;
export type StoreProfileSetInput = z.output<typeof StoreProfileSetInputSchema>;
export type StoreProfileSetResult = z.output<typeof StoreProfileSetResultSchema>;
