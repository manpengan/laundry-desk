/**
 * M2 skeleton daily revenue (日结) query.
 * Memory/order-backed aggregation; not in OpenAPI freeze snapshot.
 */

import { z } from "zod";

import { defineQuery, type QueryDefinition } from "../registry/definitions.js";

/** Business calendar day as YYYY-MM-DD. */
export const BusinessDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u, "Expected business_date YYYY-MM-DD");

export const StatsDaySummaryInputSchema = z.strictObject({
  /** Omit to let the server derive the store's current business day. */
  business_date: BusinessDateSchema.optional(),
});

/**
 * Day summary result (documented for tests / handlers; not Zod-validated on wire).
 *
 * ```ts
 * {
 *   business_date: string;
 *   order_count: number;
 *   garment_count: number;
 *   payable_cents: number;
 *   paid_cents: number;
 *   balance_cents: number;
 *   payment_cents: number;
 *   picked_garment_count: number;
 * }
 * ```
 */
export type StatsDaySummaryResult = Readonly<{
  business_date: string;
  order_count: number;
  garment_count: number;
  payable_cents: number;
  paid_cents: number;
  balance_cents: number;
  payment_cents: number;
  picked_garment_count: number;
}>;

type DaySummaryInput = typeof StatsDaySummaryInputSchema;

/** 日结汇总：按营业日聚合订单 / 衣物 / 收款（整数分）。 */
export const statsDaySummaryQuery: QueryDefinition<DaySummaryInput> = defineQuery({
  name: "stats.day.summary",
  version: "0.3.0",
  description:
    "Daily revenue summary for one business date; omit business_date for the server-derived current store business day.",
  description_llm:
    "Return day-level counters and integer-fen sums for a store business day. Omit business_date to use the server-derived current day; no client calendar is trusted. max 1 row.",
  input: StatsDaySummaryInputSchema,
  risk: "R1",
  invariants: [],
  idempotent: true,
  sideEffects: [],
  offline_mode: "denied",
  data_classification: "internal",
  input_redaction: [],
  result_redaction: [],
  max_result_rows: 1,
});

export const STATS_QUERIES = Object.freeze([statsDaySummaryQuery] as const);

export const STATS_QUERY_NAMES = Object.freeze(
  STATS_QUERIES.map((query) => query.name),
) as readonly ["stats.day.summary"];

/** M2 stats query catalog (server query registry). */
export const M2_STATS_QUERY_DEFINITIONS: readonly QueryDefinition<z.ZodObject>[] = Object.freeze([
  ...STATS_QUERIES,
]);

export const M2_STATS_QUERY_NAMES = STATS_QUERY_NAMES;
