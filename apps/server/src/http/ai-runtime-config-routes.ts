import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { AiRuntimeConfigRequestSchema, AiRuntimeConfigResponseSchema } from "@laundry/contracts";
import { AiConfigError, type createAiRuntimeConfigService } from "../ai/runtime-config-service.js";
import { ProviderAdapterError } from "../ai/provider-types.js";
import { permissionsForAuthority } from "../bus/runtime.js";
import { fail, requireCsrf, resolveSession, type AuthRouteContext } from "./auth-route-support.js";
import type { ByokMutationRateLimiter } from "./byok-rate-limit.js";
import { safeErrorContext } from "./local-logger.js";

export function registerAiRuntimeConfigRoutes(
  app: FastifyInstance,
  context: AuthRouteContext,
  service: ReturnType<typeof createAiRuntimeConfigService>,
  limiter: ByokMutationRateLimiter,
): void {
  for (const method of ["GET", "POST"] as const) {
    app.route({
      method,
      url: "/api/v2/ai/runtime-config",
      bodyLimit: 2_048,
      async handler(request, reply) {
        try {
          const authorized = await resolveSession(context.runtime, request);
          if (authorized === null) {
            reply.code(401);
            return fail("AUTHENTICATION_FAILED");
          }
          if (
            authorized.authority.role !== "admin" ||
            !permissionsForAuthority(authorized.authority).includes("ai_key_manage")
          ) {
            reply.code(403);
            return fail("PERMISSION_DENIED");
          }
          if (method === "GET")
            return AiRuntimeConfigResponseSchema.parse({
              ok: true,
              data: await service.read(authorized),
            });
          const csrf = await requireCsrf(context, request, reply, authorized.session);
          if (csrf !== true) return csrf;
          const rate = limiter.consume(authorized.session.session_id);
          if (!rate.allowed) {
            reply.code(429).header("Retry-After", String(rate.retryAfterSeconds));
            return fail("RATE_LIMITED");
          }
          const input = AiRuntimeConfigRequestSchema.parse(request.body);
          return AiRuntimeConfigResponseSchema.parse({
            ok: true,
            data: await service.save(authorized, input, AbortSignal.timeout(10_000)),
          });
        } catch (error) {
          if (error instanceof ZodError) {
            reply.code(400);
            return fail("VALIDATION_FAILED");
          }
          if (error instanceof AiConfigError) {
            reply.code(error.code === "POLICY_DENIED" ? 403 : 409);
            return fail(error.code);
          }
          if (error instanceof ProviderAdapterError) {
            reply.code(409);
            return fail("RESOURCE_UNAVAILABLE");
          }
          request.log.error(safeErrorContext(error), "AI configuration failed");
          reply.code(500);
          return fail("TRANSACTION_FAILED");
        }
      },
    });
  }
}
