import { z } from "zod";
import { CommandErrorSchema } from "../envelope/responses.js";
import {
  AiCredentialIntentRequestSchema,
  AiCredentialIntentResponseSchema,
  AiCredentialListResponseSchema,
  AiCredentialMutationResponseSchema,
  AiCredentialRevokeRequestSchema,
  AiCredentialSecretIngressRequestSchema,
  AiModelListResponseSchema,
} from "./byok.js";
import {
  AiProviderValidationIntentRequestSchema,
  AiProviderValidationIntentResponseSchema,
  AiProviderValidateRequestSchema,
  AiProviderValidationResponseSchema,
} from "./provider-connections.js";
import { AiRuntimeConfigRequestSchema, AiRuntimeConfigResponseSchema } from "./runtime-config.js";
import { AiSafetyStatusResponseSchema } from "./safety.js";
import { AiOperationConfirmSchema, AiOperationResponseSchema } from "./operations.js";
import {
  AiVisionRequestSchema,
  AiVisionResponseSchema,
  AiVisionCandidateQuerySchema,
  AiVisionCandidatesResponseSchema,
} from "./vision.js";
import {
  AiSessionCreateResponseSchema,
  AiTurnCreateRequestSchema,
  AiTurnCreateResponseSchema,
  AiStreamEventSchema,
} from "./streaming.js";

const empty = <T extends string>(operation: T) =>
  z.object({ operation: z.literal(operation) }).strict();
export const DesktopAiInputSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("visionAnalyze"), body: AiVisionRequestSchema }).strict(),
  z
    .object({ operation: z.literal("visionCandidates"), body: AiVisionCandidateQuerySchema })
    .strict(),
  z.object({ operation: z.literal("actionConfirm"), body: AiOperationConfirmSchema }).strict(),
  empty("models"),
  empty("credentials"),
  empty("config"),
  empty("safety"),
  empty("session"),
  z
    .object({ operation: z.literal("credentialIntent"), body: AiCredentialIntentRequestSchema })
    .strict(),
  z
    .object({ operation: z.literal("secret"), body: AiCredentialSecretIngressRequestSchema })
    .strict(),
  z
    .object({
      operation: z.literal("revoke"),
      credential_ref: z.uuid(),
      body: AiCredentialRevokeRequestSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal("validationIntent"),
      body: AiProviderValidationIntentRequestSchema,
    })
    .strict(),
  z.object({ operation: z.literal("validate"), body: AiProviderValidateRequestSchema }).strict(),
  z.object({ operation: z.literal("configure"), body: AiRuntimeConfigRequestSchema }).strict(),
  z
    .object({ operation: z.literal("turn"), session_id: z.uuid(), body: AiTurnCreateRequestSchema })
    .strict(),
  z
    .object({
      operation: z.literal("stream"),
      session_id: z.uuid(),
      after: z.number().int().nonnegative(),
    })
    .strict(),
  z.object({ operation: z.literal("cancel"), session_id: z.uuid() }).strict(),
]);
export const DesktopAiStreamResponseSchema = z
  .object({
    ok: z.literal(true),
    data: z
      .object({
        events: z.array(AiStreamEventSchema).max(512),
        cursor: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
export const DesktopAiCancelResponseSchema = z
  .object({ ok: z.literal(true), data: z.object({ cancelled: z.literal(true) }).strict() })
  .strict();
export const DesktopAiResultSchema = z.union([
  AiVisionResponseSchema,
  AiVisionCandidatesResponseSchema,
  AiOperationResponseSchema,
  z.object({ ok: z.literal(false), error: CommandErrorSchema }).strict(),
  AiModelListResponseSchema,
  AiCredentialListResponseSchema,
  AiCredentialIntentResponseSchema,
  AiCredentialMutationResponseSchema,
  AiProviderValidationIntentResponseSchema,
  AiProviderValidationResponseSchema,
  AiRuntimeConfigResponseSchema,
  AiSafetyStatusResponseSchema,
  AiSessionCreateResponseSchema,
  AiTurnCreateResponseSchema,
  DesktopAiStreamResponseSchema,
  DesktopAiCancelResponseSchema,
]);
export type DesktopAiInput = Readonly<z.output<typeof DesktopAiInputSchema>>;
