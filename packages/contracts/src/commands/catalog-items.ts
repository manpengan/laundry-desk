/**
 * M2 skeleton catalog item queries (price list read path).
 * Not in OpenAPI freeze snapshot; load via M2_CATALOG_DEFINITIONS on the query bus.
 */

import { z } from "zod";

import {
  defineCommand,
  defineQuery,
  type CommandDefinition,
  type QueryDefinition,
} from "../registry/definitions.js";

const CatalogItemCodeSchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u, "Expected catalog item code");

/** Service / category codes are matched verbatim by server-authoritative pricing. */
const CatalogTaxonomyCodeSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,31}$/u, "Expected lowercase taxonomy code");

export const CatalogItemsListInputSchema = z.strictObject({
  /** Free-text filter (code / name / mnemonic / service / category). */
  query: z.string().max(64).optional(),
  /** Hard row cap (must not exceed definition max_result_rows). */
  limit: z.number().int().positive().max(200),
});

export const CatalogItemsGetInputSchema = z.strictObject({
  code: CatalogItemCodeSchema,
});

type ListInput = typeof CatalogItemsListInputSchema;
type GetInput = typeof CatalogItemsGetInputSchema;

/** 价目列表：按关键字过滤（可选），整数分单价。 */
export const catalogItemsListQuery: QueryDefinition<ListInput> = defineQuery({
  name: "catalog.items.list",
  version: "0.2.0",
  description: "List catalog price items with optional free-text filter.",
  description_llm:
    "Return store catalog rows (code, name, service, category, unit_price_cents, mnemonic). Integer cents only; never invent prices.",
  input: CatalogItemsListInputSchema,
  risk: "R0",
  invariants: [],
  idempotent: true,
  sideEffects: [],
  offline_mode: "denied",
  data_classification: "internal",
  input_redaction: [],
  result_redaction: [],
  max_result_rows: 200,
});

/** 按 code 取单条价目。 */
export const catalogItemsGetQuery: QueryDefinition<GetInput> = defineQuery({
  name: "catalog.items.get",
  version: "0.2.0",
  description: "Get one catalog item by stable code.",
  description_llm: "Lookup a single catalog item by code. Return empty when not found.",
  input: CatalogItemsGetInputSchema,
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

export const CatalogItemUpsertInputSchema = z.strictObject({
  code: CatalogItemCodeSchema,
  name: z.string().min(1).max(64),
  service_code: CatalogTaxonomyCodeSchema,
  category_code: CatalogTaxonomyCodeSchema,
  /** Integer fen only; floats and negatives are rejected at the boundary. */
  unit_price_cents: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  mnemonic: z.string().max(16).optional(),
  /** Soft retire instead of delete — ADR-15 §1 keeps historical codes resolvable. */
  is_active: z.boolean(),
  sort_order: z.number().int().nonnegative().max(9_999).optional(),
});

type UpsertInput = typeof CatalogItemUpsertInputSchema;

/**
 * 价目维护：按 code 幂等 upsert。ADR-15 §3 定为 R2 —— 既有订单持有开单时刻的
 * 不可变价格快照，改价只影响后续开单，改回即可修复。
 */
export const catalogItemUpsertCommand: CommandDefinition<UpsertInput> = defineCommand({
  name: "catalog.item.upsert",
  version: "0.2.0",
  description: "Create or update one catalog price item by stable code.",
  description_llm:
    "Not exposed to AI. Counter price maintenance is operator-only under settings_admin.",
  input: CatalogItemUpsertInputSchema,
  risk: "R2",
  invariants: ["rbac.settings_admin"],
  idempotent: true,
  sideEffects: ["catalog.item.upserted", "audit.catalog_event"],
  offline_mode: "denied",
  data_classification: "internal",
  input_redaction: [],
  result_redaction: [],
});

/**
 * Read-only skeleton. ADR-15 §2: this set feeds M2_READ_ONLY_AI_DEFINITIONS, so
 * the upsert command deliberately stays out of it.
 */
export const CATALOG_SKELETON_DEFINITIONS: readonly QueryDefinition<z.ZodObject>[] = Object.freeze([
  catalogItemsListQuery,
  catalogItemsGetQuery,
]);

export const CATALOG_COMMAND_DEFINITIONS: readonly CommandDefinition<z.ZodObject>[] = Object.freeze(
  [catalogItemUpsertCommand],
);

export const CATALOG_COMMAND_NAMES = Object.freeze(
  CATALOG_COMMAND_DEFINITIONS.map((command) => command.name),
) as readonly ["catalog.item.upsert"];

export const CATALOG_SKELETON_QUERY_NAMES = Object.freeze(
  CATALOG_SKELETON_DEFINITIONS.map((query) => query.name),
) as readonly ["catalog.items.list", "catalog.items.get"];
