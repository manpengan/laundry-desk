import { z } from "zod";
import { AiProviderModelIdSchema } from "./provider-connections.js";

export const AiRuntimeSettingsSchema = z
  .object({
    enabled: z.boolean(),
    provider_code: z.enum(["deepseek", "anthropic", "gemini"]),
    model_id: AiProviderModelIdSchema,
    monthly_limit_micros: z.number().int().positive().max(9_000_000_000_000),
    input_micros_per_million: z.number().int().positive().max(1_000_000_000_000),
    output_micros_per_million: z.number().int().positive().max(1_000_000_000_000),
  })
  .strict();
export const AiRuntimeConfigSchema = AiRuntimeSettingsSchema.extend({
  version: z.number().int().positive(),
});
export const AiRuntimeConfigRequestSchema = AiRuntimeSettingsSchema.extend({
  expected_version: z.number().int().nonnegative(),
});
export const AiRuntimeConfigResponseSchema = z
  .object({
    ok: z.literal(true),
    data: z
      .object({ config: AiRuntimeConfigSchema.nullable(), custody_available: z.boolean() })
      .strict(),
  })
  .strict();
export type AiRuntimeConfig = Readonly<z.output<typeof AiRuntimeConfigSchema>>;
export type AiRuntimeConfigRequest = Readonly<z.output<typeof AiRuntimeConfigRequestSchema>>;
