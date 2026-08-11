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

const POSTGRES_INTEGER_MAX = 2_147_483_647;

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

export const CatalogItemsManageListInputSchema = z.strictObject({
  /** Free-text filter across active and retired rows. */
  query: z.string().max(64).optional(),
  limit: z.number().int().positive().max(200),
});

export const CATALOG_AUDIT_MAX_WINDOW_SECONDS = 31 * 24 * 60 * 60;
/** Last whole UTC second representable by the product's four-digit year boundary. */
export const CATALOG_AUDIT_MAX_EPOCH_SECONDS = 253_402_300_799;

export const CatalogAuditListInputSchema = z
  .strictObject({
    from_epoch_s: z.number().int().nonnegative().max(CATALOG_AUDIT_MAX_EPOCH_SECONDS),
    to_epoch_s: z.number().int().nonnegative().max(CATALOG_AUDIT_MAX_EPOCH_SECONDS),
    code: CatalogItemCodeSchema.optional(),
    limit: z.number().int().positive().max(200),
  })
  .superRefine((input, context) => {
    if (input.from_epoch_s > input.to_epoch_s) {
      context.addIssue({ code: "custom", path: ["to_epoch_s"], message: "time range is reversed" });
      return;
    }
    if (input.to_epoch_s - input.from_epoch_s > CATALOG_AUDIT_MAX_WINDOW_SECONDS) {
      context.addIssue({
        code: "custom",
        path: ["to_epoch_s"],
        message: "time range must not exceed 31 days",
      });
    }
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
  unit_price_cents: z.number().int().nonnegative().max(POSTGRES_INTEGER_MAX),
  mnemonic: z.string().max(16).optional(),
  /** Soft retire instead of delete — ADR-15 §1 keeps historical codes resolvable. */
  is_active: z.boolean(),
  sort_order: z.number().int().nonnegative().max(9_999).optional(),
  /** 0 creates a new code; a positive value protects an existing row from stale writes. */
  expected_version: z.number().int().nonnegative().max(2_147_483_646).optional(),
});

export const CatalogItemsReorderInputSchema = z.strictObject({
  /** Full active catalog snapshot in its intended order. Duplicate codes fail in the handler. */
  items: z
    .array(
      z.strictObject({
        code: CatalogItemCodeSchema,
        expected_version: z.number().int().positive().max(2_147_483_646),
      }),
    )
    .max(200),
});

type UpsertInput = typeof CatalogItemUpsertInputSchema;

/**
 * 价目维护：按 code 幂等 upsert。ADR-15 §3 定为 R2 —— 既有订单持有开单时刻的
 * 不可变价格快照，改价只影响后续开单，改回即可修复。
 */
export const catalogItemUpsertCommand: CommandDefinition<UpsertInput> = defineCommand({
  name: "catalog.item.upsert",
  version: "0.3.0",
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

type ReorderInput = typeof CatalogItemsReorderInputSchema;

/** Atomically replace the order of the complete active catalog snapshot. */
export const catalogItemsReorderCommand: CommandDefinition<ReorderInput> = defineCommand({
  name: "catalog.items.reorder",
  version: "0.1.0",
  description: "Atomically reorder the authenticated store's complete active catalog.",
  description_llm: "Not exposed to AI. Operator-only catalog governance command.",
  input: CatalogItemsReorderInputSchema,
  risk: "R2",
  invariants: ["rbac.settings_admin", "catalog.version_matches"],
  idempotent: true,
  sideEffects: ["catalog.items.reordered", "audit.catalog_event"],
  offline_mode: "denied",
  data_classification: "internal",
  input_redaction: [],
  result_redaction: [],
  size_measures: { batch: { kind: "array_length", path: "/items" } },
  hard_limits: { max_batch: 200 },
});

type ManageListInput = typeof CatalogItemsManageListInputSchema;
type AuditListInput = typeof CatalogAuditListInputSchema;

export const catalogItemsManageListQuery: QueryDefinition<ManageListInput> = defineQuery({
  name: "catalog.items.manage.list",
  version: "0.1.0",
  description: "List active and retired catalog rows with sort and optimistic versions.",
  description_llm: "Not exposed to AI. Store catalog administration read model.",
  input: CatalogItemsManageListInputSchema,
  risk: "R1",
  invariants: ["rbac.settings_admin"],
  idempotent: true,
  sideEffects: [],
  offline_mode: "denied",
  data_classification: "internal",
  input_redaction: [],
  result_redaction: [],
  max_result_rows: 200,
});

export const catalogAuditListQuery: QueryDefinition<AuditListInput> = defineQuery({
  name: "catalog.audit.list",
  version: "0.1.0",
  description: "List a safe, catalog-only audit projection for the authenticated store.",
  description_llm: "Not exposed to AI. Does not return raw before/after JSON or credentials.",
  input: CatalogAuditListInputSchema,
  risk: "R2",
  invariants: ["rbac.audit_read"],
  idempotent: true,
  sideEffects: [],
  offline_mode: "denied",
  data_classification: "internal",
  input_redaction: [],
  result_redaction: [],
  max_result_rows: 200,
});

/**
 * Read-only skeleton. ADR-15 §2: this set feeds M2_READ_ONLY_AI_DEFINITIONS, so
 * the upsert command deliberately stays out of it.
 */
export const CATALOG_SKELETON_DEFINITIONS: readonly QueryDefinition<z.ZodObject>[] = Object.freeze([
  catalogItemsListQuery,
  catalogItemsGetQuery,
]);

/** Administrative catalog queries are deliberately excluded from the AI projection. */
export const CATALOG_ADMIN_QUERY_DEFINITIONS: readonly QueryDefinition<z.ZodObject>[] =
  Object.freeze([catalogItemsManageListQuery, catalogAuditListQuery]);

export const CATALOG_COMMAND_DEFINITIONS: readonly CommandDefinition<z.ZodObject>[] = Object.freeze(
  [catalogItemUpsertCommand, catalogItemsReorderCommand],
);

export const CATALOG_COMMAND_NAMES = Object.freeze(
  CATALOG_COMMAND_DEFINITIONS.map((command) => command.name),
) as readonly ["catalog.item.upsert", "catalog.items.reorder"];

export const CATALOG_SKELETON_QUERY_NAMES = Object.freeze(
  CATALOG_SKELETON_DEFINITIONS.map((query) => query.name),
) as readonly ["catalog.items.list", "catalog.items.get"];

export const CATALOG_ADMIN_QUERY_NAMES = Object.freeze(
  CATALOG_ADMIN_QUERY_DEFINITIONS.map((query) => query.name),
) as readonly ["catalog.items.manage.list", "catalog.audit.list"];
