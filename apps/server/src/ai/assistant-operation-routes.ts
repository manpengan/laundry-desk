import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { AiOperationConfirmSchema, AiOperationResponseSchema } from "@laundry/contracts";
import {
  fail,
  requireCsrf,
  resolveSession,
  type AuthRouteContext,
} from "../http/auth-route-support.js";
import { safeErrorContext } from "../http/local-logger.js";
import { applyCommandErrorStatus } from "../http/bus-route-execution.js";
import { permissionsForAuthority } from "../bus/runtime.js";
import { confirmAssistantOperation } from "./assistant-operations.js";
import { createAiRateLimiter } from "./streaming-rate-limit.js";

export function registerAssistantOperationRoutes(
  app: FastifyInstance,
  context: AuthRouteContext,
): void {
  const limiter = createAiRateLimiter();
  app.post("/api/v2/ai/operations/confirm", { bodyLimit: 256 }, async (request, reply) => {
    try {
      const authorized = await resolveSession(context.runtime, request);
      if (authorized === null) {
        reply.code(401);
        return fail("AUTHENTICATION_FAILED");
      }
      if (!permissionsForAuthority(authorized.authority).includes("ai_use")) {
        reply.code(403);
        return fail("PERMISSION_DENIED");
      }
      const csrf = await requireCsrf(context, request, reply, authorized.session);
      if (csrf !== true) return csrf;
      const rate = limiter.consume({
        orgId: authorized.session.org_id,
        authSessionId: authorized.session.session_id,
      });
      if (!rate.allowed) {
        reply.code(429).header("Retry-After", String(rate.retryAfterSeconds));
        return fail("RATE_LIMITED");
      }
      const input = AiOperationConfirmSchema.parse(request.body);
      const result = await confirmAssistantOperation(
        context.runtime,
        authorized,
        input.confirm_ref,
      );
      if (!result.ok) {
        applyCommandErrorStatus(reply, result.error.code);
        return result;
      }
      return AiOperationResponseSchema.parse(result);
    } catch (error) {
      if (error instanceof ZodError) {
        reply.code(400);
        return fail("VALIDATION_FAILED");
      }
      if (error instanceof Error && error.message === "AI_OPERATION_DENIED") {
        reply.code(403);
        return fail("POLICY_DENIED");
      }
      request.log.error(safeErrorContext(error), "AI operation confirmation failed");
      reply.code(500);
      return fail("TRANSACTION_FAILED");
    }
  });
}
