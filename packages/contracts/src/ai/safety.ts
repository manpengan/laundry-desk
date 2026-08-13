import { z } from "zod";

export const AI_COST_MICROS_MAX = 9_000_000_000_000;

export const AiSafetyDenialCodeSchema = z.enum([
  "AI_BUDGET_EXCEEDED",
  "AI_CIRCUIT_OPEN",
  "AI_PROMPT_INJECTION",
]);

export const AiSafetyStatusViewSchema = z
  .object({
    runtime_enabled: z.boolean(),
    pii_masking: z.literal(true),
    egress_policy: z.literal("https_443_allowlist"),
    month: z.string().regex(/^\d{4}-\d{2}$/u),
    input_tokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    output_tokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    estimated_cost_micros: z.number().int().nonnegative().max(AI_COST_MICROS_MAX),
    monthly_limit_micros: z.number().int().nonnegative().max(AI_COST_MICROS_MAX),
    remaining_micros: z.number().int().nonnegative().max(AI_COST_MICROS_MAX),
    circuit_state: z.enum(["closed", "open"]),
    circuit_open_until: z.iso.datetime({ offset: true }).nullable(),
  })
  .strict();

export const AiSafetyStatusResponseSchema = z
  .object({ ok: z.literal(true), data: AiSafetyStatusViewSchema })
  .strict();

export type AiSafetyDenialCode = z.output<typeof AiSafetyDenialCodeSchema>;
export type AiSafetyStatusView = Readonly<z.output<typeof AiSafetyStatusViewSchema>>;
