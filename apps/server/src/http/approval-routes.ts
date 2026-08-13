import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";

import {
  AiApprovalDecisionSchema,
  AiApprovalDenialSchema,
  AiApprovalExecutionResponseSchema,
  AiApprovalItemResponseSchema,
  AiApprovalListQuerySchema,
  AiApprovalListResponseSchema,
  AiApprovalRequestSchema,
  AiApprovalRefSchema,
} from "@laundry/contracts";

import { ApprovalServiceError, type ApprovalService } from "../approvals/service.js";
import { permissionsForAuthority } from "../bus/runtime.js";
import { applyCommandErrorStatus } from "./bus-route-execution.js";
import { fail, requireCsrf, resolveSession, type AuthRouteContext } from "./auth-route-support.js";
import type { ApprovalRateLimiter } from "./approval-rate-limit.js";
import { safeErrorContext } from "./local-logger.js";

const BODY_LIMIT_BYTES = 4_096;

async function requireAdmin(
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
    !permissionsForAuthority(authorized.authority).includes("approval_manage")
  ) {
    reply.code(403);
    return null;
  }
  return authorized;
}

function routeFailure(error: unknown, request: FastifyRequest, reply: FastifyReply) {
  if (error instanceof ZodError) {
    reply.code(400);
    return fail("VALIDATION_FAILED");
  }
  if (error instanceof ApprovalServiceError) {
    const status =
      error.code === "NOT_FOUND"
        ? 404
        : error.code === "PERMISSION_DENIED" || error.code === "POLICY_DENIED"
          ? 403
          : 409;
    reply.code(status);
    const code =
      error.code === "NOT_FOUND"
        ? "RESOURCE_UNAVAILABLE"
        : error.code === "VERSION_CONFLICT"
          ? "IDEMPOTENCY_CONFLICT"
          : error.code;
    return fail(code);
  }
  request.log.error(safeErrorContext(error), "approval operation failed");
  reply.code(500);
  return fail("TRANSACTION_FAILED");
}

function applyRateLimit(
  limiter: ApprovalRateLimiter,
  sessionId: string,
  reply: FastifyReply,
): boolean {
  const decision = limiter.consume(sessionId);
  if (decision.allowed) return true;
  reply.header("Retry-After", String(decision.retryAfterSeconds));
  reply.code(429);
  return false;
}

function approvalRef(request: FastifyRequest): string {
  const params = request.params as Readonly<{ approvalRef?: unknown }>;
  return AiApprovalRefSchema.parse(params.approvalRef);
}

export function registerApprovalRoutes(
  app: FastifyInstance,
  context: AuthRouteContext,
  service: ApprovalService,
  limiter: ApprovalRateLimiter,
): void {
  app.post(
    "/api/v2/ai/approval-requests",
    { bodyLimit: BODY_LIMIT_BYTES },
    async (request, reply) => {
      try {
        const authorized = await resolveSession(context.runtime, request);
        if (authorized === null) {
          reply.code(401);
          return fail("AUTHENTICATION_FAILED");
        }
        const csrf = await requireCsrf(context, request, reply, authorized.session);
        if (csrf !== true) return csrf;
        if (!applyRateLimit(limiter, authorized.session.session_id, reply)) {
          return fail("RATE_LIMITED");
        }
        const input = AiApprovalRequestSchema.parse(request.body);
        return AiApprovalItemResponseSchema.parse({
          ok: true,
          data: await service.submit(authorized, input.confirm_ref),
        });
      } catch (error) {
        return routeFailure(error, request, reply);
      }
    },
  );

  app.get("/api/v2/ai/approval-requests", async (request, reply) => {
    try {
      const authorized = await requireAdmin(context, request, reply);
      if (authorized === null) {
        return fail(reply.statusCode === 401 ? "AUTHENTICATION_FAILED" : "PERMISSION_DENIED");
      }
      if (!applyRateLimit(limiter, authorized.session.session_id, reply)) {
        return fail("RATE_LIMITED");
      }
      const query = AiApprovalListQuerySchema.parse(request.query);
      return AiApprovalListResponseSchema.parse({
        ok: true,
        data: { items: await service.list(authorized, query) },
      });
    } catch (error) {
      return routeFailure(error, request, reply);
    }
  });

  app.get("/api/v2/ai/approval-requests/:approvalRef", async (request, reply) => {
    try {
      const authorized = await requireAdmin(context, request, reply);
      if (authorized === null) {
        return fail(reply.statusCode === 401 ? "AUTHENTICATION_FAILED" : "PERMISSION_DENIED");
      }
      if (!applyRateLimit(limiter, authorized.session.session_id, reply)) {
        return fail("RATE_LIMITED");
      }
      return AiApprovalItemResponseSchema.parse({
        ok: true,
        data: await service.get(authorized, approvalRef(request)),
      });
    } catch (error) {
      return routeFailure(error, request, reply);
    }
  });

  app.post(
    "/api/v2/ai/approval-requests/:approvalRef/approve",
    { bodyLimit: BODY_LIMIT_BYTES },
    async (request, reply) => {
      try {
        const authorized = await requireAdmin(context, request, reply);
        if (authorized === null) {
          return fail(reply.statusCode === 401 ? "AUTHENTICATION_FAILED" : "PERMISSION_DENIED");
        }
        const csrf = await requireCsrf(context, request, reply, authorized.session);
        if (csrf !== true) return csrf;
        if (!applyRateLimit(limiter, authorized.session.session_id, reply)) {
          return fail("RATE_LIMITED");
        }
        const input = AiApprovalDecisionSchema.parse(request.body);
        const executed = await service.approveAndExecute(
          authorized,
          approvalRef(request),
          input.expected_version,
        );
        if (!executed.commandResult.ok) {
          applyCommandErrorStatus(reply, executed.commandResult.error.code);
          return executed.commandResult;
        }
        return AiApprovalExecutionResponseSchema.parse({
          ok: true,
          data: {
            approval: executed.approval,
            execution: "executed",
            result: executed.commandResult.data.result,
          },
        });
      } catch (error) {
        return routeFailure(error, request, reply);
      }
    },
  );

  app.post(
    "/api/v2/ai/approval-requests/:approvalRef/deny",
    { bodyLimit: BODY_LIMIT_BYTES },
    async (request, reply) => {
      try {
        const authorized = await requireAdmin(context, request, reply);
        if (authorized === null) {
          return fail(reply.statusCode === 401 ? "AUTHENTICATION_FAILED" : "PERMISSION_DENIED");
        }
        const csrf = await requireCsrf(context, request, reply, authorized.session);
        if (csrf !== true) return csrf;
        if (!applyRateLimit(limiter, authorized.session.session_id, reply)) {
          return fail("RATE_LIMITED");
        }
        const input = AiApprovalDenialSchema.parse(request.body);
        return AiApprovalItemResponseSchema.parse({
          ok: true,
          data: await service.deny(
            authorized,
            approvalRef(request),
            input.expected_version,
            input.reason,
          ),
        });
      } catch (error) {
        return routeFailure(error, request, reply);
      }
    },
  );
}
