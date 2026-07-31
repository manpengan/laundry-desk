/**
 * M2 skeleton shift closing / 日结签字 (command + query).
 * Not in OpenAPI freeze snapshot (M1 first-wave only).
 *
 * Risk R3: confirm card (POLICY_CONFIRMATION_REQUIRED). Self-confirm is allowed
 * (requiresOtherApprover=false). With store feature `shift_closing` off, ops may
 * still close — risk remains R3 for safety / WYSIWYS integrity.
 */

import { z } from "zod";

import {
  defineCommand,
  defineQuery,
  type CommandDefinition,
  type QueryDefinition,
} from "../registry/definitions.js";
import { BusinessDateSchema } from "./stats.js";

export const ShiftCloseInputSchema = z.strictObject({
  business_date: BusinessDateSchema,
  counted_cash_cents: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  retained_float_cents: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  /** Display name of the signer; the command audit is the authoritative record. */
  signature_name: z.string().min(1).max(64),
  note: z.string().max(256).optional(),
});

export const ShiftGetInputSchema = z.strictObject({
  business_date: BusinessDateSchema,
});

export const ShiftHistoryInputSchema = z
  .strictObject({
    date_from: BusinessDateSchema,
    date_to: BusinessDateSchema,
    limit: z.number().int().positive().max(100).optional(),
  })
  .superRefine((input, context) => {
    if (input.date_from > input.date_to) {
      context.addIssue({
        code: "custom",
        path: ["date_to"],
        message: "date_to must not precede date_from",
      });
    }
  });

/**
 * Close result / get row (documented for tests / handlers; not Zod-validated on wire).
 *
 * ```ts
 * {
 *   shift_id, business_date, closed_at, order_count,
 *   payable_cents, paid_cents, payment_cents, opening_float_cents,
 *   counted_cash_cents, retained_float_cents, expected_cash_cents,
 *   cash_difference_cents, period_started_at, period_ended_at,
 *   signature_name?, closed_by_staff_id?, note?
 * }
 * ```
 */
export type ShiftClosingResult = Readonly<{
  shift_id: string;
  business_date: string;
  closed_at: number;
  order_count: number;
  payable_cents: number;
  paid_cents: number;
  payment_cents: number;
  opening_float_cents: number;
  counted_cash_cents: number;
  retained_float_cents: number;
  expected_cash_cents: number;
  cash_difference_cents: number;
  period_started_at: number;
  period_ended_at: number;
  signature_name?: string;
  closed_by_staff_id?: string;
  note?: string | null;
}>;

type CloseInput = typeof ShiftCloseInputSchema;
type GetInput = typeof ShiftGetInputSchema;
type HistoryInput = typeof ShiftHistoryInputSchema;

/** 交班日结：快照当日 stats 并写入签字记录；同日仅一次。 */
export const shiftCloseCommand: CommandDefinition<CloseInput> = defineCommand({
  name: "shift.close",
  version: "0.3.0",
  description:
    "Close a store business day once with a frozen ledger snapshot and cash reconciliation.",
  description_llm:
    "Append-only shift close for one business_date. It freezes integer-fen ledger totals, opening float, counted cash, retained float and the resulting cash difference. Reject a second close for the same store day.",
  input: ShiftCloseInputSchema,
  risk: "R3",
  invariants: ["rbac.shift_close"],
  // Closing is online-only. R3 confirm card freezes args; duplicate day closes still conflict.
  idempotent: true,
  sideEffects: ["shift.closed", "audit.shift_event"],
  offline_mode: "denied",
  data_classification: "internal",
  input_redaction: [],
  result_redaction: [],
});

/** 查询某营业日是否已交班；无记录时 result 为 null。 */
export const shiftGetQuery: QueryDefinition<GetInput> = defineQuery({
  name: "shift.get",
  version: "0.2.0",
  description: "Load shift closing record for one business date, or null if not closed.",
  description_llm:
    "Return shift row for business_date (shift_id, closed_at, fen totals, signature_name) or null. max 1 row.",
  input: ShiftGetInputSchema,
  risk: "R1",
  invariants: ["rbac.accounting_read"],
  idempotent: true,
  sideEffects: [],
  offline_mode: "denied",
  data_classification: "internal",
  input_redaction: [],
  result_redaction: [],
  max_result_rows: 1,
});

/** 历史交班：按营业日区间返回已冻结快照，供核对和 CSV 导出。 */
export const shiftHistoryQuery: QueryDefinition<HistoryInput> = defineQuery({
  name: "shift.history",
  version: "0.1.0",
  description: "List bounded frozen shift closings for a business-date range.",
  description_llm:
    "Return up to 100 store-scoped shift closings newest first, including integer-fen cash reconciliation fields. Never recompute historical rows.",
  input: ShiftHistoryInputSchema,
  risk: "R1",
  invariants: ["rbac.accounting_read"],
  idempotent: true,
  sideEffects: [],
  offline_mode: "denied",
  data_classification: "internal",
  input_redaction: [],
  result_redaction: [],
  max_result_rows: 100,
});

export const SHIFT_COMMANDS = Object.freeze([shiftCloseCommand] as const);

export const SHIFT_COMMAND_NAMES = Object.freeze(
  SHIFT_COMMANDS.map((command) => command.name),
) as readonly ["shift.close"];

export const SHIFT_QUERIES = Object.freeze([shiftGetQuery, shiftHistoryQuery] as const);

export const SHIFT_QUERY_NAMES = Object.freeze(
  SHIFT_QUERIES.map((query) => query.name),
) as readonly ["shift.get", "shift.history"];

/** M2 shift command catalog (server command registry). */
export const M2_SHIFT_COMMAND_DEFINITIONS: readonly CommandDefinition<z.ZodObject>[] =
  Object.freeze([...SHIFT_COMMANDS]);

export const M2_SHIFT_COMMAND_NAMES = SHIFT_COMMAND_NAMES;

/** M2 shift query catalog (server query registry). */
export const M2_SHIFT_QUERY_DEFINITIONS: readonly QueryDefinition<z.ZodObject>[] = Object.freeze([
  ...SHIFT_QUERIES,
]);

export const M2_SHIFT_QUERY_NAMES = SHIFT_QUERY_NAMES;
