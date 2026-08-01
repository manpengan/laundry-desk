import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  PrintDispatchClaimRequestSchema,
  PrintExecutionReceiptRequestSchema,
} from "@laundry/contracts";

import type { AuthorizedSession } from "../auth/session-view.js";
import { PrintDispatchError, type PrintDispatchSession } from "../print/dispatch-service.js";
import {
  fail,
  requireCsrf,
  resolveSession,
  type RouteSecurityContext,
} from "./auth-route-support.js";
import type { EdgePrintRateLimiter } from "./edge-print-rate-limit.js";
import { safeErrorContext } from "./local-logger.js";

function isMainProcessRequest(request: FastifyRequest, context: RouteSecurityContext): boolean {
  return (
    request.headers.origin === context.requestSecurity.desktopOrigin &&
    request.headers["sec-fetch-site"] === "same-origin"
  );
}

function dispatchSession(session: AuthorizedSession): PrintDispatchSession {
  return Object.freeze({
    orgId: session.session.org_id,
    storeId: session.session.store_id,
    staffId: session.session.staff_id,
    deviceId: session.session.device_id,
  });
}

function mapDispatchError(error: unknown, reply: FastifyReply) {
  if (error instanceof PrintDispatchError) {
    reply.code(error.code === "signature" ? 401 : 409);
    return fail(error.code === "signature" ? "AUTHENTICATION_FAILED" : "RESOURCE_UNAVAILABLE");
  }
  return null;
}

async function authorizeMainRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  context: RouteSecurityContext,
  limiter: EdgePrintRateLimiter,
): Promise<AuthorizedSession | null> {
  if (!isMainProcessRequest(request, context)) {
    reply.code(403);
    await reply.send(fail("CSRF_REJECTED"));
    return null;
  }
  const resolved = await resolveSession(context.runtime, request);
  if (resolved === null) {
    reply.code(401);
    await reply.send(fail("AUTHENTICATION_FAILED"));
    return null;
  }
  const csrf = await requireCsrf(context, request, reply, resolved.session);
  if (csrf !== true) {
    await reply.send(csrf);
    return null;
  }
  const decision = limiter.check(resolved.session.session_id, resolved.session.device_id);
  if (!decision.allowed) {
    reply.header("Retry-After", String(decision.retryAfterSeconds));
    reply.code(429);
    await reply.send(fail("RATE_LIMITED"));
    return null;
  }
  return resolved;
}

export function registerEdgePrintRoute(
  app: FastifyInstance,
  context: RouteSecurityContext,
  limiter: EdgePrintRateLimiter,
): void {
  app.post("/api/v2/edge/print/claim", async (request, reply) => {
    const parsed = PrintDispatchClaimRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return fail("VALIDATION_FAILED");
    }
    const resolved = await authorizeMainRequest(request, reply, context, limiter);
    if (resolved === null) return reply;
    if (context.runtime.printDispatch === null) {
      reply.code(503);
      return fail("RESOURCE_UNAVAILABLE");
    }
    try {
      const data = await context.runtime.printDispatch.claim(
        dispatchSession(resolved),
        parsed.data,
      );
      return Object.freeze({ ok: true as const, data });
    } catch (error) {
      const mapped = mapDispatchError(error, reply);
      if (mapped !== null) return mapped;
      request.log.error(safeErrorContext(error), "Edge print claim failed");
      reply.code(500);
      return fail("TRANSACTION_FAILED");
    }
  });

  app.post("/api/v2/edge/print/receipt", async (request, reply) => {
    const parsed = PrintExecutionReceiptRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return fail("VALIDATION_FAILED");
    }
    const resolved = await authorizeMainRequest(request, reply, context, limiter);
    if (resolved === null) return reply;
    if (context.runtime.printDispatch === null) {
      reply.code(503);
      return fail("RESOURCE_UNAVAILABLE");
    }
    try {
      const data = await context.runtime.printDispatch.settle(
        dispatchSession(resolved),
        parsed.data,
      );
      return Object.freeze({ ok: true as const, data });
    } catch (error) {
      const mapped = mapDispatchError(error, reply);
      if (mapped !== null) return mapped;
      request.log.error(safeErrorContext(error), "Edge print receipt failed");
      reply.code(500);
      return fail("TRANSACTION_FAILED");
    }
  });
}
