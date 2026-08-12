import type { FastifyInstance } from "fastify";

import {
  EdgeAuthorityChallengeRequestSchema,
  EdgeAuthorityRequestSchema,
} from "@laundry/contracts";

import {
  fail,
  requireCsrf,
  resolveSession,
  type RouteSecurityContext,
} from "./auth-route-support.js";
import { safeErrorContext } from "./local-logger.js";
import { isConfiguredRuntimeTenant } from "./runtime-surface-policy.js";

export function registerEdgeAuthorityRoute(
  app: FastifyInstance,
  context: RouteSecurityContext,
): void {
  app.post("/api/v2/edge/authority/challenge", async (request, reply) => {
    try {
      const parsed = EdgeAuthorityChallengeRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400);
        return fail("RESOURCE_UNAVAILABLE");
      }
      const resolved = await resolveSession(context.runtime, request);
      if (resolved === null) {
        reply.code(401);
        return fail("AUTHENTICATION_FAILED");
      }
      const csrf = await requireCsrf(context, request, reply, resolved.session);
      if (csrf !== true) return csrf;
      if (!isConfiguredRuntimeTenant(resolved)) {
        reply.code(404);
        return fail("RESOURCE_UNAVAILABLE");
      }
      const challenge = await context.runtime.edgeAuthority.challenge(resolved, parsed.data);
      if (challenge === null) {
        reply.code(409);
        return fail("RESOURCE_UNAVAILABLE");
      }
      return Object.freeze({ ok: true as const, data: challenge });
    } catch (error) {
      request.log.error(safeErrorContext(error), "edge authority challenge failed");
      reply.code(500);
      return fail("RESOURCE_UNAVAILABLE");
    }
  });

  app.post("/api/v2/edge/authority", async (request, reply) => {
    try {
      const parsed = EdgeAuthorityRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400);
        return fail("RESOURCE_UNAVAILABLE");
      }
      const resolved = await resolveSession(context.runtime, request);
      if (resolved === null) {
        reply.code(401);
        return fail("AUTHENTICATION_FAILED");
      }
      const csrf = await requireCsrf(context, request, reply, resolved.session);
      if (csrf !== true) return csrf;
      if (!isConfiguredRuntimeTenant(resolved)) {
        reply.code(404);
        return fail("RESOURCE_UNAVAILABLE");
      }
      const authority = await context.runtime.edgeAuthority.issue(resolved, parsed.data);
      if (authority === null) {
        reply.code(409);
        return fail("RESOURCE_UNAVAILABLE");
      }
      return Object.freeze({ ok: true as const, data: authority });
    } catch (error) {
      request.log.error(safeErrorContext(error), "edge authority request failed");
      reply.code(500);
      return fail("RESOURCE_UNAVAILABLE");
    }
  });
}
