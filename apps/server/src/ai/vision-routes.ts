import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { AiVisionCandidateQuerySchema, AiVisionRequestSchema } from "@laundry/contracts";
import {
  fail,
  requireCsrf,
  resolveSession,
  type AuthRouteContext,
} from "../http/auth-route-support.js";
import { safeErrorContext } from "../http/local-logger.js";
import { aiContext } from "./runtime-config-service.js";
import { createAiRateLimiter } from "./streaming-rate-limit.js";
import { assertVisionScope, visionCandidates } from "./vision-photos.js";
import type { createVisionService } from "./vision-service.js";

export function registerVisionRoutes(
  app: FastifyInstance,
  context: AuthRouteContext,
  analyze: ReturnType<typeof createVisionService> | null,
): void {
  const limiter = createAiRateLimiter({ perSession: 6, perOrg: 30 });
  let active = 0;
  for (const operation of ["candidates", "analyze"] as const)
    app.post(`/api/v2/ai/vision/${operation}`, { bodyLimit: 220_000 }, async (request, reply) => {
      let acquired = false;
      const abort = new AbortController();
      const onClose = () => {
        if (!reply.raw.writableEnded) abort.abort();
      };
      reply.raw.once("close", onClose);
      const timer = setTimeout(() => abort.abort(), 12_000);
      try {
        const authorized = await resolveSession(context.runtime, request);
        if (authorized === null) {
          reply.code(401);
          return fail("AUTHENTICATION_FAILED");
        }
        const csrf = await requireCsrf(context, request, reply, authorized.session);
        if (csrf !== true) return csrf;
        const scoped = aiContext(authorized);
        assertVisionScope(scoped);
        const rate = limiter.consume({
          orgId: scoped.tenant.orgId,
          authSessionId: scoped.authSessionId,
        });
        if (!rate.allowed || active >= 2) {
          reply.code(429).header("Retry-After", String(rate.retryAfterSeconds || 5));
          return fail("RATE_LIMITED");
        }
        active += 1;
        acquired = true;
        if (operation === "candidates") {
          const input = AiVisionCandidateQuerySchema.parse(request.body);
          return await visionCandidates(context.runtime, scoped, input.key, abort.signal);
        }
        if (analyze === null) {
          reply.code(503);
          return fail("RESOURCE_UNAVAILABLE");
        }
        return await analyze(AiVisionRequestSchema.parse(request.body), scoped, abort.signal);
      } catch (error) {
        if (error instanceof ZodError) {
          reply.code(400);
          return fail("VALIDATION_FAILED");
        }
        if (error instanceof Error && error.message === "AI_VISION_DENIED") {
          reply.code(403);
          return fail("PERMISSION_DENIED");
        }
        request.log.warn(safeErrorContext(error), "Vision assistance unavailable");
        reply.code(409);
        return fail("RESOURCE_UNAVAILABLE");
      } finally {
        clearTimeout(timer);
        reply.raw.removeListener("close", onClose);
        if (acquired) active -= 1;
      }
    });
}
