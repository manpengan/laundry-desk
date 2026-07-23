/**
 * M2 skeleton customer archive (search + upsert).
 * Org-scoped profiles; not in OpenAPI freeze snapshot.
 */

import { z } from "zod";

import {
  defineCommand,
  defineQuery,
  type CommandDefinition,
  type QueryDefinition,
} from "../registry/definitions.js";

/** Mainland mobile; seed range 13800000xxx ok. Shared with order.receive. */
export const PhoneSchema = z
  .string()
  .regex(/^1[3-9]\d{9}$/u, "Expected mainland mobile (seed range 13800000xxx ok)");

export const CustomerSearchInputSchema = z.strictObject({
  /** Phone prefix or name contains (case-insensitive). Empty = newest first. */
  query: z.string().max(64).optional(),
  /** Hard row cap (handler default 20; must not exceed max_result_rows). */
  limit: z.number().int().positive().max(50).optional(),
});

export const CustomerUpsertInputSchema = z.strictObject({
  phone: PhoneSchema,
  name: z.string().min(1).max(64).optional(),
  note: z.string().max(256).optional(),
});

type SearchInput = typeof CustomerSearchInputSchema;
type UpsertInput = typeof CustomerUpsertInputSchema;

/**
 * Search result row (documented for tests / handlers; not Zod-validated on wire).
 *
 * ```ts
 * { customer_id, phone, name, note, updated_at }
 * ```
 */
export type CustomerSearchRow = Readonly<{
  customer_id: string;
  phone: string;
  name: string | null;
  note: string | null;
  updated_at: number;
}>;

export type CustomerSearchResult = Readonly<{
  customers: readonly CustomerSearchRow[];
}>;

export type CustomerUpsertResult = Readonly<{
  customer_id: string;
  phone: string;
  name: string | null;
  created: boolean;
}>;

/** 客户搜索：手机号前缀或姓名包含；PII 结果需脱敏声明。 */
export const customerSearchQuery: QueryDefinition<SearchInput> = defineQuery({
  name: "customer.search",
  version: "0.1.0",
  description: "Search org customer profiles by phone prefix or name contains.",
  description_llm:
    "Return org-scoped customer rows (customer_id, phone, name, note, updated_at). Match phone prefix or name substring. max 50 rows; default limit 20.",
  input: CustomerSearchInputSchema,
  risk: "R2",
  invariants: [],
  idempotent: true,
  sideEffects: [],
  offline_mode: "denied",
  data_classification: "pii",
  input_redaction: [],
  result_redaction: [{ path: "/customers", strategy: "mask" }],
  max_result_rows: 50,
});

/** 客户建档/更新：按 org+phone upsert；柜台可离线 grant。 */
export const customerUpsertCommand: CommandDefinition<UpsertInput> = defineCommand({
  name: "customer.upsert",
  version: "0.1.0",
  description: "Create or update an org customer profile by phone.",
  description_llm:
    "Upsert customer by org+phone. Optional name/note. Returns customer_id, phone, name, created flag. Integer timestamps only.",
  input: CustomerUpsertInputSchema,
  risk: "R2",
  invariants: ["rbac.order_write"],
  idempotent: true,
  sideEffects: ["customer.upserted", "audit.customer_event"],
  offline_mode: "grant",
  data_classification: "pii",
  input_redaction: [{ path: "/phone", strategy: "mask" }],
  result_redaction: [{ path: "/phone", strategy: "mask" }],
});

export const CUSTOMER_COMMANDS = Object.freeze([customerUpsertCommand] as const);

export const CUSTOMER_COMMAND_NAMES = Object.freeze(
  CUSTOMER_COMMANDS.map((command) => command.name),
) as readonly ["customer.upsert"];

export const CUSTOMER_QUERIES = Object.freeze([customerSearchQuery] as const);

export const CUSTOMER_QUERY_NAMES = Object.freeze(
  CUSTOMER_QUERIES.map((query) => query.name),
) as readonly ["customer.search"];

/** M2 customer command catalog (server command registry). */
export const M2_CUSTOMER_COMMAND_DEFINITIONS: readonly CommandDefinition<z.ZodObject>[] =
  Object.freeze([...CUSTOMER_COMMANDS]);

export const M2_CUSTOMER_COMMAND_NAMES = CUSTOMER_COMMAND_NAMES;

/** M2 customer query catalog (server query registry). */
export const M2_CUSTOMER_QUERY_DEFINITIONS: readonly QueryDefinition<z.ZodObject>[] = Object.freeze(
  [...CUSTOMER_QUERIES],
);

export const M2_CUSTOMER_QUERY_NAMES = CUSTOMER_QUERY_NAMES;
