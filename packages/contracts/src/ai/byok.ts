import { z } from "zod";

export const AiProviderCodeSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9._-]*$/);

export const AiCredentialRefSchema = z.uuid();
export const AiCredentialStatusSchema = z.enum([
  "pending_verification",
  "active",
  "invalid",
  "superseded",
  "revoked",
]);

export const AiAdapterFamilySchema = z.enum(["anthropic", "openai_compatible", "gemini"]);
export const AiModelStatusSchema = z.enum(["disabled", "available", "deprecated"]);

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export const AiModelMetadataSchema = z
  .object({
    provider_code: AiProviderCodeSchema,
    model_id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[^\p{Cc}]+$/u),
    display_name: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[^\p{Cc}]+$/u),
    adapter_family: AiAdapterFamilySchema,
    supports_streaming: z.boolean(),
    supports_tools: z.boolean(),
    supports_vision: z.boolean(),
    max_input_tokens: z.number().int().positive().max(10_000_000),
    max_output_tokens: z.number().int().positive().max(10_000_000),
    status: AiModelStatusSchema,
    registry_version: z.number().int().positive(),
    source_url: z.string().max(2_048).refine(isHttpsUrl, "official source must use HTTPS"),
    verified_at: z.iso.datetime({ offset: true }),
  })
  .strict();

export const AiCredentialMetadataSchema = z
  .object({
    credential_ref: AiCredentialRefSchema,
    provider_code: AiProviderCodeSchema,
    credential_version: z.number().int().positive(),
    status: AiCredentialStatusSchema,
    last4: z
      .string()
      .length(4)
      .regex(/^[\x21-\x7e]{4}$/),
    created_at: z.iso.datetime({ offset: true }),
    updated_at: z.iso.datetime({ offset: true }),
  })
  .strict();

export const AiModelListResponseSchema = z
  .object({
    ok: z.literal(true),
    data: z.object({ items: z.array(AiModelMetadataSchema) }).strict(),
  })
  .strict();

export const AiCredentialListResponseSchema = z
  .object({
    ok: z.literal(true),
    data: z.object({ items: z.array(AiCredentialMetadataSchema) }).strict(),
  })
  .strict();

export const AiCredentialIntentRequestSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("replace"),
      provider_code: AiProviderCodeSchema,
      idempotency_key: z.uuid(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("revoke"),
      provider_code: AiProviderCodeSchema,
      credential_ref: AiCredentialRefSchema,
      idempotency_key: z.uuid(),
    })
    .strict(),
]);

export const AiCredentialIntentResponseSchema = z
  .object({
    ok: z.literal(true),
    data: z
      .object({
        confirm_ref: z.uuid(),
        operation: z.enum(["replace", "revoke"]),
        provider_code: AiProviderCodeSchema,
        credential_ref: AiCredentialRefSchema.optional(),
        expires_at: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export const AiCredentialSecretIngressRequestSchema = z
  .object({
    confirm_ref: z.uuid(),
    step_up_proof_id: z.uuid(),
    api_key: z
      .string()
      .min(8)
      .max(8_192)
      .regex(/^[\x21-\x7e]+$/),
  })
  .strict();

export const AiCredentialRevokeRequestSchema = z
  .object({ confirm_ref: z.uuid(), step_up_proof_id: z.uuid() })
  .strict();

export const AiCredentialMutationResponseSchema = z
  .object({ ok: z.literal(true), data: AiCredentialMetadataSchema })
  .strict();

type AiByokOperationRow = Readonly<{
  operation: "models_list" | "credentials_list" | "credential_intent" | "secret_ingress" | "revoke";
  method: "GET" | "POST";
  path: string;
  permission: "ai_key_manage";
  risk: "R0" | "R5";
  csrf: boolean;
  secret_ingress: boolean;
  provider_network: false;
}>;

/** Frozen Item 12 HTTP surface. None of these operations invokes a provider. */
export const AI_BYOK_OPERATION_MATRIX = Object.freeze([
  Object.freeze({
    operation: "models_list" as const,
    method: "GET" as const,
    path: "/api/v2/ai/models" as const,
    permission: "ai_key_manage" as const,
    risk: "R0" as const,
    csrf: false,
    secret_ingress: false,
    provider_network: false,
  }),
  Object.freeze({
    operation: "credentials_list" as const,
    method: "GET" as const,
    path: "/api/v2/ai/provider-credentials" as const,
    permission: "ai_key_manage" as const,
    risk: "R0" as const,
    csrf: false,
    secret_ingress: false,
    provider_network: false,
  }),
  Object.freeze({
    operation: "credential_intent" as const,
    method: "POST" as const,
    path: "/api/v2/ai/provider-credential-intents" as const,
    permission: "ai_key_manage" as const,
    risk: "R5" as const,
    csrf: true,
    secret_ingress: false,
    provider_network: false,
  }),
  Object.freeze({
    operation: "secret_ingress" as const,
    method: "POST" as const,
    path: "/api/v2/ai/provider-credentials/secret" as const,
    permission: "ai_key_manage" as const,
    risk: "R5" as const,
    csrf: true,
    secret_ingress: true,
    provider_network: false,
  }),
  Object.freeze({
    operation: "revoke" as const,
    method: "POST" as const,
    path: "/api/v2/ai/provider-credentials/{credential_ref}/revoke" as const,
    permission: "ai_key_manage" as const,
    risk: "R5" as const,
    csrf: true,
    secret_ingress: false,
    provider_network: false,
  }),
] as const satisfies readonly AiByokOperationRow[]);

export type AiModelMetadata = Readonly<z.output<typeof AiModelMetadataSchema>>;
export type AiCredentialMetadata = Readonly<z.output<typeof AiCredentialMetadataSchema>>;
export type AiCredentialIntentRequest = Readonly<z.output<typeof AiCredentialIntentRequestSchema>>;
export type AiCredentialSecretIngressRequest = Readonly<
  z.output<typeof AiCredentialSecretIngressRequestSchema>
>;
