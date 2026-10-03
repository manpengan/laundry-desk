import { z } from "zod";
import { AiOperationDraftSchema, AiOperationPreviewSchema } from "./operations.js";

export const AI_ASSISTANT_MAX_RESULTS = 10;
export const AI_ASSISTANT_MAX_TOOL_CALLS = 3;
export const AI_ASSISTANT_TOOL_TIMEOUT_MS = 800;

export const AI_ASSISTANT_TOOL_NAMES = [
  "business.summary",
  "records.search",
  "procedure.troubleshoot",
  "business.trend",
  "pickup.candidates",
  "operations.preview",
] as const;

export const AiAssistantToolNameSchema = z.enum(AI_ASSISTANT_TOOL_NAMES);
export const AiAssistantSourceSchema = z
  .object({
    kind: z.enum(["query", "document"]),
    ref: z.string().regex(/^[a-z][a-z0-9_.:-]{2,127}$/u),
    label: z.string().trim().min(1).max(96),
  })
  .strict();
export const AiAssistantFilterSchema = z
  .object({ field: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/u), value: z.string().max(64) })
  .strict();

const BusinessDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u)
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)));

export const AiBusinessSummaryArgsSchema = z
  .object({ business_date: BusinessDateSchema.optional() })
  .strict();
export const AiRecordSearchArgsSchema = z
  .object({
    scope: z.enum(["orders", "customers", "garments"]),
    query: z.string().trim().min(1).max(64),
    limit: z.number().int().min(1).max(AI_ASSISTANT_MAX_RESULTS).default(5),
  })
  .strict();
export const AiProcedureTroubleshootArgsSchema = z
  .object({
    topic: z.enum(["order_intake", "pickup", "printing", "customer_lookup"]),
    symptom: z.string().trim().min(1).max(128),
  })
  .strict();

export const AiAssistantToolCallSchema = z.discriminatedUnion("tool", [
  z
    .object({
      tool: z.literal("business.trend"),
      args: z.object({ days: z.union([z.literal(7), z.literal(30)]) }).strict(),
    })
    .strict(),
  z
    .object({
      tool: z.literal("pickup.candidates"),
      args: z
        .object({
          min_age_days: z.union([z.literal(30), z.literal(90), z.literal(180)]),
          unpaid_only: z.boolean(),
          limit: z.number().int().min(1).max(10),
        })
        .strict(),
    })
    .strict(),
  z.object({ tool: z.literal("operations.preview"), args: AiOperationDraftSchema }).strict(),
  z.object({ tool: z.literal("business.summary"), args: AiBusinessSummaryArgsSchema }).strict(),
  z.object({ tool: z.literal("records.search"), args: AiRecordSearchArgsSchema }).strict(),
  z
    .object({ tool: z.literal("procedure.troubleshoot"), args: AiProcedureTroubleshootArgsSchema })
    .strict(),
]);

const SafeScalarSchema = z.union([z.string().max(256), z.number().safe(), z.boolean(), z.null()]);
export const AiAssistantToolResultSchema = z
  .object({
    summary: z.string().trim().min(1).max(512),
    result_count: z.number().int().min(0).max(AI_ASSISTANT_MAX_RESULTS),
    sources: z.array(AiAssistantSourceSchema).min(1).max(3),
    filters: z.array(AiAssistantFilterSchema).max(6),
    items: z.array(z.record(z.string(), SafeScalarSchema)).max(AI_ASSISTANT_MAX_RESULTS),
    preview: AiOperationPreviewSchema.optional(),
  })
  .strict();

export type AiAssistantToolName = z.output<typeof AiAssistantToolNameSchema>;
export type AiAssistantToolCall = Readonly<z.output<typeof AiAssistantToolCallSchema>>;
export type AiAssistantToolResult = Readonly<z.output<typeof AiAssistantToolResultSchema>>;
