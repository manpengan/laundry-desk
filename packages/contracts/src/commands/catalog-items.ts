/**
 * M2 skeleton catalog item queries (price list read path).
 * Not in OpenAPI freeze snapshot; load via M2_CATALOG_DEFINITIONS on the query bus.
 */

import { z } from "zod";

import { defineQuery, type QueryDefinition } from "../registry/definitions.js";

const CatalogItemCodeSchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u, "Expected catalog item code");

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

export const CATALOG_SKELETON_DEFINITIONS: readonly QueryDefinition<z.ZodObject>[] = Object.freeze([
  catalogItemsListQuery,
  catalogItemsGetQuery,
]);

export const CATALOG_SKELETON_QUERY_NAMES = Object.freeze(
  CATALOG_SKELETON_DEFINITIONS.map((query) => query.name),
) as readonly ["catalog.items.list", "catalog.items.get"];
