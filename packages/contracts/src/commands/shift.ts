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
  /** Display name of the signer (skeleton — not a crypto signature). */
  signature_name: z.string().min(1).max(64),
  note: z.string().max(256).optional(),
});

export const ShiftGetInputSchema = z.strictObject({
  business_date: BusinessDateSchema,
});

/**
 * Close result / get row (documented for tests / handlers; not Zod-validated on wire).
 *
 * ```ts
 * {
 *   shift_id, business_date, closed_at, order_count,
 *   payable_cents, paid_cents, payment_cents,
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
  signature_name?: string;
  closed_by_staff_id?: string;
  note?: string | null;
}>;

type CloseInput = typeof ShiftCloseInputSchema;
type GetInput = typeof ShiftGetInputSchema;

/** 交班日结：快照当日 stats 并写入签字记录；同日仅一次。 */
export const shiftCloseCommand: CommandDefinition<CloseInput> = defineCommand({
  name: "shift.close",
  version: "0.2.0",
  description: "Close a store business day with signature name and day-summary snapshot.",
  description_llm:
    "Append-only shift close for one business_date. Snapshots order_count and integer-fen totals. Rejects second close same day. signature_name is display text only.",
  input: ShiftCloseInputSchema,
  risk: "R3",
  invariants: ["rbac.order_write"],
  // Offline grant requires idempotent; second close same day is CONFLICT, not a rewrite.
  // R3 confirm card: first hop fails closed with confirm_ref; second hop resumes frozen args.
  idempotent: true,
  sideEffects: ["shift.closed", "audit.shift_event"],
  offline_mode: "grant",
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
  invariants: [],
  idempotent: true,
  sideEffects: [],
  offline_mode: "denied",
  data_classification: "internal",
  input_redaction: [],
  result_redaction: [],
  max_result_rows: 1,
});

export const SHIFT_COMMANDS = Object.freeze([shiftCloseCommand] as const);

export const SHIFT_COMMAND_NAMES = Object.freeze(
  SHIFT_COMMANDS.map((command) => command.name),
) as readonly ["shift.close"];

export const SHIFT_QUERIES = Object.freeze([shiftGetQuery] as const);

export const SHIFT_QUERY_NAMES = Object.freeze(
  SHIFT_QUERIES.map((query) => query.name),
) as readonly ["shift.get"];

/** M2 shift command catalog (server command registry). */
export const M2_SHIFT_COMMAND_DEFINITIONS: readonly CommandDefinition<z.ZodObject>[] =
  Object.freeze([...SHIFT_COMMANDS]);

export const M2_SHIFT_COMMAND_NAMES = SHIFT_COMMAND_NAMES;

/** M2 shift query catalog (server query registry). */
export const M2_SHIFT_QUERY_DEFINITIONS: readonly QueryDefinition<z.ZodObject>[] = Object.freeze([
  ...SHIFT_QUERIES,
]);

export const M2_SHIFT_QUERY_NAMES = SHIFT_QUERY_NAMES;
