import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";

import {
  AiCredentialIntentRequestSchema,
  AiCredentialIntentResponseSchema,
  AiCredentialListResponseSchema,
  AiCredentialMutationResponseSchema,
  AiCredentialRefSchema,
  AiCredentialRevokeRequestSchema,
  AiCredentialSecretIngressRequestSchema,
  AiModelListResponseSchema,
  AiProviderValidateRequestSchema,
  AiProviderValidationIntentRequestSchema,
  AiProviderValidationIntentResponseSchema,
  AiProviderValidationResponseSchema,
} from "@laundry/contracts";

import { ByokServiceError, type ByokService } from "../ai/byok-service.js";
import {
  ProviderValidationServiceError,
  type ProviderValidationService,
} from "../ai/provider-validation-service.js";
import { permissionsForAuthority } from "../bus/runtime.js";
import { fail, requireCsrf, resolveSession, type AuthRouteContext } from "./auth-route-support.js";
import type { ByokMutationRateLimiter } from "./byok-rate-limit.js";
import { safeErrorContext } from "./local-logger.js";

const SECRET_BODY_LIMIT_BYTES = 12_288;
const METADATA_BODY_LIMIT_BYTES = 2_048;

async function requireManager(
  context: AuthRouteContext,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const authorized = await resolveSession(context.runtime, request);
  if (authorized === null) {
    reply.code(401);
    return null;
  }
  if (
    authorized.authority.role !== "admin" ||
    !permissionsForAuthority(authorized.authority).includes("ai_key_manage")
  ) {
    reply.code(403);
    return null;
  }
  return authorized;
}

function serviceFailure(error: unknown, request: FastifyRequest, reply: FastifyReply) {
  if (error instanceof ZodError) {
    reply.code(400);
    return fail("VALIDATION_FAILED");
  }
  if (error instanceof ByokServiceError) {
    const status =
      error.code === "POLICY_DENIED" || error.code === "PERMISSION_DENIED"
        ? 403
        : error.code === "RESOURCE_UNAVAILABLE" || error.code === "INVARIANT_FAILED"
          ? 409
          : error.code === "IDEMPOTENCY_CONFLICT"
            ? 409
            : 500;
    reply.code(status);
    return fail(error.code);
  }
  if (error instanceof ProviderValidationServiceError) {
    reply.code(error.code === "POLICY_DENIED" ? 403 : 409);
    return fail(error.code);
  }
  request.log.error(safeErrorContext(error), "BYOK operation failed");
  reply.code(500);
  return fail("TRANSACTION_FAILED");
}

function applyRateLimit(
  limiter: ByokMutationRateLimiter,
  sessionId: string,
  reply: FastifyReply,
): boolean {
  const decision = limiter.consume(sessionId);
  if (decision.allowed) return true;
  reply.header("Retry-After", String(decision.retryAfterSeconds));
  reply.code(429);
  return false;
}

export function registerByokRoutes(
  app: FastifyInstance,
  context: AuthRouteContext,
  service: ByokService,
  limiter: ByokMutationRateLimiter,
  validationService?: ProviderValidationService,
): void {
  app.get("/api/v2/ai/models", async (request, reply) => {
    try {
      if ((await requireManager(context, request, reply)) === null) {
        return fail(reply.statusCode === 401 ? "AUTHENTICATION_FAILED" : "PERMISSION_DENIED");
      }
      return AiModelListResponseSchema.parse({
        ok: true,
        data: { items: await service.listModels() },
      });
    } catch (error) {
      return serviceFailure(error, request, reply);
    }
  });

  app.get("/api/v2/ai/provider-credentials", async (request, reply) => {
    try {
      const authorized = await requireManager(context, request, reply);
      if (authorized === null) {
        return fail(reply.statusCode === 401 ? "AUTHENTICATION_FAILED" : "PERMISSION_DENIED");
      }
      return AiCredentialListResponseSchema.parse({
        ok: true,
        data: { items: await service.listCredentials(authorized) },
      });
    } catch (error) {
      return serviceFailure(error, request, reply);
    }
  });

  app.post(
    "/api/v2/ai/provider-credential-intents",
    { bodyLimit: METADATA_BODY_LIMIT_BYTES },
    async (request, reply) => {
      try {
        const authorized = await requireManager(context, request, reply);
        if (authorized === null) {
          return fail(reply.statusCode === 401 ? "AUTHENTICATION_FAILED" : "PERMISSION_DENIED");
        }
        const csrf = await requireCsrf(context, request, reply, authorized.session);
        if (csrf !== true) return csrf;
        if (!applyRateLimit(limiter, authorized.session.session_id, reply)) {
          return fail("RATE_LIMITED");
        }
        const input = AiCredentialIntentRequestSchema.parse(request.body);
        return AiCredentialIntentResponseSchema.parse({
          ok: true,
          data: await service.createIntent(authorized, input),
        });
      } catch (error) {
        return serviceFailure(error, request, reply);
      }
    },
  );

  app.post(
    "/api/v2/ai/provider-credentials/secret",
    { bodyLimit: SECRET_BODY_LIMIT_BYTES },
    async (request, reply) => {
      try {
        const authorized = await requireManager(context, request, reply);
        if (authorized === null) {
          return fail(reply.statusCode === 401 ? "AUTHENTICATION_FAILED" : "PERMISSION_DENIED");
        }
        const csrf = await requireCsrf(context, request, reply, authorized.session);
        if (csrf !== true) return csrf;
        if (!applyRateLimit(limiter, authorized.session.session_id, reply)) {
          return fail("RATE_LIMITED");
        }
        const input = AiCredentialSecretIngressRequestSchema.parse(request.body);
        const metadata = await service.replaceCredential({
          confirmRef: input.confirm_ref,
          proofId: input.step_up_proof_id,
          authorized,
          apiKey: Buffer.from(input.api_key, "ascii"),
        });
        return AiCredentialMutationResponseSchema.parse({ ok: true, data: metadata });
      } catch (error) {
        return serviceFailure(error, request, reply);
      }
    },
  );

  app.post(
    "/api/v2/ai/provider-credentials/:credentialRef/revoke",
    { bodyLimit: METADATA_BODY_LIMIT_BYTES },
    async (request, reply) => {
      try {
        const authorized = await requireManager(context, request, reply);
        if (authorized === null) {
          return fail(reply.statusCode === 401 ? "AUTHENTICATION_FAILED" : "PERMISSION_DENIED");
        }
        const csrf = await requireCsrf(context, request, reply, authorized.session);
        if (csrf !== true) return csrf;
        if (!applyRateLimit(limiter, authorized.session.session_id, reply)) {
          return fail("RATE_LIMITED");
        }
        const params = request.params as Readonly<{ credentialRef?: unknown }>;
        const credentialRef = AiCredentialRefSchema.parse(params.credentialRef);
        const input = AiCredentialRevokeRequestSchema.parse(request.body);
        const metadata = await service.revokeCredential({
          confirmRef: input.confirm_ref,
          proofId: input.step_up_proof_id,
          authorized,
          credentialRef,
        });
        return AiCredentialMutationResponseSchema.parse({ ok: true, data: metadata });
      } catch (error) {
        return serviceFailure(error, request, reply);
      }
    },
  );

  if (validationService !== undefined) {
    app.post(
      "/api/v2/ai/provider-validation-intents",
      { bodyLimit: METADATA_BODY_LIMIT_BYTES },
      async (request, reply) => {
        try {
          const authorized = await requireManager(context, request, reply);
          if (authorized === null) {
            return fail(reply.statusCode === 401 ? "AUTHENTICATION_FAILED" : "PERMISSION_DENIED");
          }
          const csrf = await requireCsrf(context, request, reply, authorized.session);
          if (csrf !== true) return csrf;
          if (!applyRateLimit(limiter, authorized.session.session_id, reply)) {
            return fail("RATE_LIMITED");
          }
          const input = AiProviderValidationIntentRequestSchema.parse(request.body);
          return AiProviderValidationIntentResponseSchema.parse({
            ok: true,
            data: await validationService.createIntent(authorized, input),
          });
        } catch (error) {
          return serviceFailure(error, request, reply);
        }
      },
    );

    app.post(
      "/api/v2/ai/provider-connections/validate",
      { bodyLimit: METADATA_BODY_LIMIT_BYTES },
      async (request, reply) => {
        const controller = new AbortController();
        const abort = () => controller.abort();
        request.raw.once("aborted", abort);
        try {
          const authorized = await requireManager(context, request, reply);
          if (authorized === null) {
            return fail(reply.statusCode === 401 ? "AUTHENTICATION_FAILED" : "PERMISSION_DENIED");
          }
          const csrf = await requireCsrf(context, request, reply, authorized.session);
          if (csrf !== true) return csrf;
          if (!applyRateLimit(limiter, authorized.session.session_id, reply)) {
            return fail("RATE_LIMITED");
          }
          const input = AiProviderValidateRequestSchema.parse(request.body);
          return AiProviderValidationResponseSchema.parse({
            ok: true,
            data: await validationService.validate(
              authorized,
              input.confirm_ref,
              controller.signal,
            ),
          });
        } catch (error) {
          return serviceFailure(error, request, reply);
        } finally {
          request.raw.off("aborted", abort);
        }
      },
    );
  }
}
