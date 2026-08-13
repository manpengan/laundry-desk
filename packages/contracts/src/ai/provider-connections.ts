import { z } from "zod";

import { AiCredentialRefSchema, AiProviderCodeSchema } from "./byok.js";

export const AiProviderModelIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[^\p{Cc}\p{Zl}\p{Zp}]+$/u);

export const AiProviderValidationErrorCodeSchema = z.enum([
  "PROVIDER_AUTH_REJECTED",
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_TIMEOUT",
  "PROVIDER_ABORTED",
  "PROVIDER_RESPONSE_INVALID",
  "PROVIDER_RESPONSE_TOO_LARGE",
  "NETWORK_POLICY_DENIED",
  "NETWORK_ERROR",
]);

export const AiProviderValidationIntentRequestSchema = z
  .object({
    credential_ref: AiCredentialRefSchema,
    model_id: AiProviderModelIdSchema,
    idempotency_key: z.uuid(),
  })
  .strict();

export const AiProviderValidationIntentResponseSchema = z
  .object({
    ok: z.literal(true),
    data: z
      .object({
        confirm_ref: z.uuid(),
        expires_at: z.number().int().nonnegative(),
        summary: z
          .object({
            provider_code: AiProviderCodeSchema,
            credential_ref: AiCredentialRefSchema,
            credential_version: z.number().int().positive(),
            credential_last4: z.string().length(4),
            model_id: AiProviderModelIdSchema,
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

export const AiProviderValidateRequestSchema = z.object({ confirm_ref: z.uuid() }).strict();

export const AiProviderValidationResultSchema = z
  .object({
    outcome: z.enum(["valid", "failed"]),
    provider_code: AiProviderCodeSchema,
    credential_ref: AiCredentialRefSchema,
    credential_version: z.number().int().positive(),
    model_id: AiProviderModelIdSchema,
    discovered_model_count: z.number().int().nonnegative().max(200),
    selected_model_available: z.boolean(),
    error_code: AiProviderValidationErrorCodeSchema.nullable(),
    validated_at: z.iso.datetime({ offset: true }),
  })
  .strict();

export const AiProviderValidationResponseSchema = z
  .object({ ok: z.literal(true), data: AiProviderValidationResultSchema })
  .strict();

export const AI_PROVIDER_OPERATION_MATRIX = Object.freeze([
  Object.freeze({
    operation: "validation_intent" as const,
    method: "POST" as const,
    path: "/api/v2/ai/provider-validation-intents" as const,
    permission: "ai_key_manage" as const,
    risk: "R3" as const,
    csrf: true,
    provider_network: false,
  }),
  Object.freeze({
    operation: "validate" as const,
    method: "POST" as const,
    path: "/api/v2/ai/provider-connections/validate" as const,
    permission: "ai_key_manage" as const,
    risk: "R3" as const,
    csrf: true,
    provider_network: true,
  }),
]);

export type AiProviderValidationIntentRequest = Readonly<
  z.output<typeof AiProviderValidationIntentRequestSchema>
>;
export type AiProviderValidationErrorCode = z.output<typeof AiProviderValidationErrorCodeSchema>;
export type AiProviderValidationResult = Readonly<
  z.output<typeof AiProviderValidationResultSchema>
>;
