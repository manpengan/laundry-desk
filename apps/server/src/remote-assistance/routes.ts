import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DesktopRemoteAssistanceInputSchema } from "@laundry/contracts";
import {
  fail,
  rateLimited,
  recordLoginFailure,
  requireCsrf,
  resolveSession,
  type AuthRouteContext,
} from "../http/auth-route-support.js";
import { isConfiguredRuntimeTenant } from "../http/runtime-surface-policy.js";
import { createByokMutationRateLimiter } from "../http/byok-rate-limit.js";
import { createAssistanceRepository } from "./repository.js";
import { createAssistanceService, type AssistanceService } from "./service.js";
import { createAssistanceTransport } from "./transport.js";
import { loadAssistanceTrust } from "./config.js";

export function registerRemoteAssistanceRoutes(
  app: FastifyInstance,
  context: AuthRouteContext,
  provided?: AssistanceService,
): void {
  const pool = context.runtime.pool;
  if (!pool && !provided) return;
  const service = provided
    ? Promise.resolve(provided)
    : (async () => {
        let trust;
        try {
          trust = await loadAssistanceTrust();
        } catch {
          app.log.error({ code: "ASSISTANCE_TRUST_INVALID" }, "remote assistance is unavailable");
          trust = null;
        }
        return createAssistanceService({
          repository: createAssistanceRepository(pool!),
          trust,
          transport: trust ? createAssistanceTransport(trust) : null,
          reportFailure: () =>
            app.log.error(
              { code: "ASSISTANCE_SESSION_INTERRUPTED" },
              "remote assistance session stopped",
            ),
        });
      })();
  app.addHook("onClose", async () => {
    await (await service).close();
  });
  const limiter = createByokMutationRateLimiter({ maxAttempts: 30, windowSeconds: 60 });
  app.post("/api/v2/remote-assistance", { bodyLimit: 4096 }, async (request, reply) => {
    try {
      const auth = await resolveSession(context.runtime, request);
      if (!auth) {
        reply.code(401);
        return fail("AUTHENTICATION_FAILED");
      }
      if (!isConfiguredRuntimeTenant(auth) || auth.authority.role !== "admin") {
        reply.code(403);
        return fail("PERMISSION_DENIED");
      }
      const input = DesktopRemoteAssistanceInputSchema.parse(request.body);
      // Revocation is always available even after status/authorization throttling.
      if (input.operation !== "revoke") {
        const rate = limiter.consume(auth.session.session_id);
        if (!rate.allowed) {
          reply.code(429);
          return fail("RATE_LIMITED");
        }
      }
      const csrf = await requireCsrf(context, request, reply, auth.session);
      if (csrf !== true) return csrf;
      const instance = await service;
      if (input.operation === "status") return { ok: true, data: await instance.status(auth) };
      if (input.operation === "revoke")
        return { ok: true, data: await instance.revoke(auth, input.body.session_id) };
      const staff = await context.runtime.identity.login.staff.findById(
        auth.session.org_id,
        auth.session.staff_id,
      );
      if (!staff?.is_active) {
        reply.code(401);
        return fail("AUTHENTICATION_FAILED");
      }
      const limitInput = {
        org_code: auth.session.org_id,
        store_code: auth.session.store_id,
        username: staff.username,
        ip: request.ip,
      };
      const attempt = context.loginRateLimiter.beginAttempt(limitInput);
      if (!attempt.allowed)
        return rateLimited(
          request,
          reply,
          context.securityEvents,
          limitInput,
          attempt.retryAfterSeconds,
        );
      let verified;
      try {
        verified = await context.runtime.identity.login.passwordPort.verifyPassword(
          input.body.password,
          staff.password_hash,
        );
      } catch (error) {
        attempt.reservation.release();
        throw error;
      }
      if (!verified) {
        attempt.reservation.fail();
        recordLoginFailure(request, context.securityEvents, limitInput);
        reply.code(401);
        return fail("AUTHENTICATION_FAILED");
      }
      attempt.reservation.succeed();
      return { ok: true, data: await instance.authorize(auth) };
    } catch (error) {
      // Error objects can contain SQL parameters or external content. Emit only
      // the fixed category, never a password, trust key, bearer token or proof.
      const validation = error instanceof z.ZodError;
      if (!validation)
        request.log.error(
          { code: "ASSISTANCE_OPERATION_FAILED" },
          "remote assistance operation failed",
        );
      reply.code(validation ? 400 : 409);
      return fail(validation ? "VALIDATION_FAILED" : "RESOURCE_UNAVAILABLE");
    }
  });
}
