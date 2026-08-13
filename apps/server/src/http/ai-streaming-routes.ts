import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";

import {
  AI_EVENT_REPLAY_MAX,
  AiConversationIdSchema,
  AiEventReplayQuerySchema,
  AiEventReplayResponseSchema,
  AiSessionCreateRequestSchema,
  AiSessionCreateResponseSchema,
  AiSafetyStatusResponseSchema,
  AiTurnCreateRequestSchema,
  AiTurnCreateResponseSchema,
  type AiStreamEvent,
} from "@laundry/contracts";

import { AiServiceError, type AiStreamingService } from "../ai/streaming-service.js";
import type { AiRequestContext } from "../ai/streaming-store.js";
import type { AiRateLimiter } from "../ai/streaming-rate-limit.js";
import { permissionsForAuthority } from "../bus/runtime.js";
import { fail, requireCsrf, resolveSession, type AuthRouteContext } from "./auth-route-support.js";
import { safeErrorContext } from "./local-logger.js";

const BODY_LIMIT_BYTES = 12_288;
const KEEPALIVE_MS = 10_000;

type Authorized = NonNullable<Awaited<ReturnType<typeof resolveSession>>>;

async function requireAiUser(
  context: AuthRouteContext,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<Authorized | null> {
  const authorized = await resolveSession(context.runtime, request);
  if (authorized === null) {
    reply.code(401);
    return null;
  }
  if (!permissionsForAuthority(authorized.authority).includes("ai_use")) {
    reply.code(403);
    return null;
  }
  return authorized;
}

async function requireAiOwner(
  context: AuthRouteContext,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<Authorized | null> {
  const authorized = await resolveSession(context.runtime, request);
  if (authorized === null) {
    reply.code(401);
    return null;
  }
  if (!permissionsForAuthority(authorized.authority).includes("settings_admin")) {
    reply.code(403);
    return null;
  }
  return authorized;
}

function requestContext(authorized: Authorized): AiRequestContext {
  return Object.freeze({
    tenant: Object.freeze({
      orgId: authorized.session.org_id,
      storeId: authorized.session.store_id,
      staffId: authorized.session.staff_id,
    }),
    authSessionId: authorized.session.session_id,
    deviceId: authorized.session.device_id,
  });
}

function serviceFailure(error: unknown, request: FastifyRequest, reply: FastifyReply) {
  if (error instanceof ZodError) {
    reply.code(400);
    return fail("VALIDATION_FAILED");
  }
  if (error instanceof AiServiceError) {
    if (error.code === "PROMPT_INJECTION_DETECTED") {
      reply.code(400);
      return fail("VALIDATION_FAILED");
    }
    if (error.code === "AI_UNAVAILABLE") reply.code(503);
    else if (error.code === "NOT_FOUND") reply.code(404);
    else reply.code(409);
    return fail(
      error.code === "IDEMPOTENCY_CONFLICT"
        ? "IDEMPOTENCY_CONFLICT"
        : error.code === "ACTIVE_TURN"
          ? "RESOURCE_UNAVAILABLE"
          : "RESOURCE_UNAVAILABLE",
    );
  }
  request.log.error(safeErrorContext(error), "AI streaming operation failed");
  reply.code(500);
  return fail("TRANSACTION_FAILED");
}

function consumeRateLimit(
  limiter: AiRateLimiter,
  authorized: Authorized,
  reply: FastifyReply,
): boolean {
  const decision = limiter.consume({
    orgId: authorized.session.org_id,
    authSessionId: authorized.session.session_id,
  });
  if (decision.allowed) return true;
  reply.header("Retry-After", String(decision.retryAfterSeconds));
  reply.code(429);
  return false;
}

function sessionIdFrom(request: FastifyRequest): string {
  const params = request.params as Readonly<{ sessionId?: unknown }>;
  return AiConversationIdSchema.parse(params.sessionId);
}

export function writeSse(reply: FastifyReply, event: AiStreamEvent): Promise<void> {
  const frame = `id: ${event.cursor}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  return new Promise<void>((resolve, reject) => {
    if (reply.raw.write(frame)) {
      resolve();
      return;
    }
    const cleanup = () => {
      reply.raw.off("drain", drained);
      reply.raw.off("error", failed);
      reply.raw.off("close", closed);
    };
    const drained = () => {
      cleanup();
      resolve();
    };
    const failed = (error: Error) => {
      cleanup();
      reject(error);
    };
    const closed = () => failed(new Error("SSE connection closed during backpressure"));
    reply.raw.once("drain", drained);
    reply.raw.once("error", failed);
    reply.raw.once("close", closed);
  });
}

async function replayExisting(
  service: AiStreamingService,
  sessionId: string,
  after: number,
  context: AiRequestContext,
  reply: FastifyReply,
): Promise<number> {
  const events = await service.listEvents(sessionId, after, AI_EVENT_REPLAY_MAX, context);
  let cursor = after;
  for (const event of events) {
    await writeSse(reply, event);
    cursor = event.cursor;
  }
  return cursor;
}

function streamHeaders(reply: FastifyReply): void {
  reply.hijack();
  reply.raw.statusCode = 200;
  reply.raw.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  reply.raw.setHeader("Cache-Control", "no-store, no-transform");
  reply.raw.setHeader("Connection", "keep-alive");
  reply.raw.setHeader("X-Accel-Buffering", "no");
  reply.raw.flushHeaders();
}

export function registerAiStreamingRoutes(
  app: FastifyInstance,
  auth: AuthRouteContext,
  service: AiStreamingService,
  limiter: AiRateLimiter,
): void {
  app.get("/api/v2/ai/safety", async (request, reply) => {
    try {
      const authorized = await requireAiOwner(auth, request, reply);
      if (authorized === null)
        return fail(reply.statusCode === 401 ? "AUTHENTICATION_FAILED" : "PERMISSION_DENIED");
      if (!consumeRateLimit(limiter, authorized, reply)) return fail("RATE_LIMITED");
      const data = await service.getSafetyStatus(requestContext(authorized));
      return AiSafetyStatusResponseSchema.parse({ ok: true, data });
    } catch (error) {
      return serviceFailure(error, request, reply);
    }
  });

  app.post("/api/v2/ai/sessions", { bodyLimit: BODY_LIMIT_BYTES }, async (request, reply) => {
    try {
      const authorized = await requireAiUser(auth, request, reply);
      if (authorized === null)
        return fail(reply.statusCode === 401 ? "AUTHENTICATION_FAILED" : "PERMISSION_DENIED");
      const csrf = await requireCsrf(auth, request, reply, authorized.session);
      if (csrf !== true) return csrf;
      if (!consumeRateLimit(limiter, authorized, reply)) return fail("RATE_LIMITED");
      AiSessionCreateRequestSchema.parse(request.body);
      const data = await service.createSession(requestContext(authorized));
      reply.code(201);
      return AiSessionCreateResponseSchema.parse({ ok: true, data });
    } catch (error) {
      return serviceFailure(error, request, reply);
    }
  });

  app.post(
    "/api/v2/ai/sessions/:sessionId/turns",
    { bodyLimit: BODY_LIMIT_BYTES },
    async (request, reply) => {
      try {
        const authorized = await requireAiUser(auth, request, reply);
        if (authorized === null)
          return fail(reply.statusCode === 401 ? "AUTHENTICATION_FAILED" : "PERMISSION_DENIED");
        const csrf = await requireCsrf(auth, request, reply, authorized.session);
        if (csrf !== true) return csrf;
        if (!consumeRateLimit(limiter, authorized, reply)) return fail("RATE_LIMITED");
        const input = AiTurnCreateRequestSchema.parse(request.body);
        const data = await service.createTurn(
          sessionIdFrom(request),
          input,
          requestContext(authorized),
        );
        reply.code(data.replayed ? 200 : 202);
        return AiTurnCreateResponseSchema.parse({ ok: true, data });
      } catch (error) {
        return serviceFailure(error, request, reply);
      }
    },
  );

  app.get("/api/v2/ai/sessions/:sessionId/events", async (request, reply) => {
    try {
      const authorized = await requireAiUser(auth, request, reply);
      if (authorized === null)
        return fail(reply.statusCode === 401 ? "AUTHENTICATION_FAILED" : "PERMISSION_DENIED");
      const context = requestContext(authorized);
      const sessionId = sessionIdFrom(request);
      const query = AiEventReplayQuerySchema.parse(request.query);
      const [session, events] = await Promise.all([
        service.getSession(sessionId, context),
        service.listEvents(sessionId, query.after, query.limit, context),
      ]);
      return AiEventReplayResponseSchema.parse({
        ok: true,
        data: {
          session,
          events,
          next_cursor: events.at(-1)?.cursor ?? query.after,
        },
      });
    } catch (error) {
      return serviceFailure(error, request, reply);
    }
  });

  app.get("/api/v2/ai/sessions/:sessionId/stream", async (request, reply) => {
    const authorized = await requireAiUser(auth, request, reply);
    if (authorized === null)
      return fail(reply.statusCode === 401 ? "AUTHENTICATION_FAILED" : "PERMISSION_DENIED");
    try {
      if (!service.enabled) throw new AiServiceError("AI_UNAVAILABLE");
      const sessionId = sessionIdFrom(request);
      const context = requestContext(authorized);
      await service.getSession(sessionId, context);
      const lastEventId = request.headers["last-event-id"];
      const after = AiEventReplayQuerySchema.shape.after.parse(lastEventId ?? 0);
      streamHeaders(reply);
      const abort = new AbortController();
      request.raw.once("aborted", () => abort.abort());
      reply.raw.once("close", () => abort.abort());
      const keepalive = setInterval(() => {
        if (!reply.raw.destroyed) reply.raw.write(": keepalive\n\n");
      }, KEEPALIVE_MS);
      keepalive.unref();
      try {
        let cursor = await replayExisting(service, sessionId, after, context, reply);
        await service.runQueuedTurn(sessionId, context, abort.signal, async (event) => {
          if (event.cursor > cursor) {
            await writeSse(reply, event);
            cursor = event.cursor;
          }
        });
      } finally {
        clearInterval(keepalive);
        if (!reply.raw.destroyed) reply.raw.end();
      }
      return reply;
    } catch (error) {
      if (!reply.sent) return serviceFailure(error, request, reply);
      request.log.error(safeErrorContext(error), "AI SSE stream failed");
      if (!reply.raw.destroyed) reply.raw.end();
      return reply;
    }
  });
}
