import { AiSafetyStatusViewSchema } from "@laundry/contracts";

import type { PgPool } from "../db/pg-pool.js";
import { withAiContext } from "./streaming-pg-context.js";
import { AiStoreError, type AiConversationStore } from "./streaming-store.js";

type SafetyMethods = Pick<
  AiConversationStore,
  "authorizeAndStartTurn" | "finishTurn" | "recordSafetyRejection" | "getSafetyStatus"
>;

type SafetyStatusRow = Readonly<{
  month: string;
  input_tokens: string | number;
  output_tokens: string | number;
  estimated_cost_micros: string | number;
  monthly_limit_micros: string | number;
  remaining_micros: string | number;
  circuit_state: "closed" | "open";
  circuit_open_until: Date | string | null;
}>;

export function createPgAiSafetyMethods(pool: PgPool): SafetyMethods {
  return Object.freeze({
    authorizeAndStartTurn: async (input) =>
      withAiContext(pool, input.context, async (client) => {
        const result = await client.query<
          Readonly<{
            started: boolean;
            denial_code: "AI_BUDGET_EXCEEDED" | "AI_CIRCUIT_OPEN" | null;
            input_micros_per_million: string | number;
            output_micros_per_million: string | number;
          }>
        >(
          `SELECT started, denial_code, input_micros_per_million,
                  output_micros_per_million
             FROM public.ai_turn_safety_authorize($1::uuid, $2::uuid, $3)`,
          [input.turnId, input.context.authSessionId, input.estimatedInputTokens],
        );
        const row = result.rows[0];
        return Object.freeze({
          started: row?.started === true,
          denialCode: row?.denial_code ?? null,
          inputMicrosPerMillion: Number(row?.input_micros_per_million ?? 0),
          outputMicrosPerMillion: Number(row?.output_micros_per_million ?? 0),
        });
      }),

    finishTurn: async (input) =>
      withAiContext(pool, input.context, async (client) => {
        const finish = input.finish;
        const result = await client.query<Readonly<{ changed: boolean }>>(
          `SELECT public.ai_turn_finish_metered(
            $1::uuid, $2::uuid, $3, $4, $5, $6, $7::uuid, $8, $9::char(64),
            $10::uuid, $11::uuid, $12, $13, $14
          ) AS changed`,
          [
            input.turnId,
            input.context.authSessionId,
            finish.status,
            finish.errorCode,
            finish.usage.inputTokens,
            finish.usage.outputTokens,
            finish.assistantMessageId,
            finish.assistantText.length === 0 ? null : finish.assistantText,
            finish.assistantSha256,
            finish.usage.id,
            finish.auditId,
            finish.usage.estimatedCostMicros,
            finish.usage.inputRedactions,
            finish.usage.outputRedactions,
          ],
        );
        return result.rows[0]?.changed === true;
      }),

    recordSafetyRejection: async (input) =>
      withAiContext(pool, input.context, async (client) => {
        await client.query(
          `SELECT public.ai_safety_rejection_record(
            $1::uuid, $2::uuid, $3::uuid, $4, $5::char(64), $6::uuid
          )`,
          [
            input.id,
            input.sessionId,
            input.context.authSessionId,
            input.code,
            input.contentSha256,
            input.auditId,
          ],
        );
      }),

    getSafetyStatus: async (context) =>
      withAiContext(
        pool,
        context,
        async (client) => {
          const result = await client.query<SafetyStatusRow>(
            `SELECT month, input_tokens, output_tokens, estimated_cost_micros,
                    monthly_limit_micros, remaining_micros, circuit_state,
                    circuit_open_until
               FROM public.ai_safety_status($1::uuid)`,
            [context.authSessionId],
          );
          const row = result.rows[0];
          if (row === undefined) throw new AiStoreError("NOT_FOUND");
          return AiSafetyStatusViewSchema.omit({ runtime_enabled: true }).parse({
            ...row,
            input_tokens: Number(row.input_tokens),
            output_tokens: Number(row.output_tokens),
            estimated_cost_micros: Number(row.estimated_cost_micros),
            monthly_limit_micros: Number(row.monthly_limit_micros),
            remaining_micros: Number(row.remaining_micros),
            pii_masking: true,
            egress_policy: "https_443_allowlist",
            circuit_open_until:
              row.circuit_open_until instanceof Date
                ? row.circuit_open_until.toISOString()
                : row.circuit_open_until,
          });
        },
        true,
      ),
  });
}
