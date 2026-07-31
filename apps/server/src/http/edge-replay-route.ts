import type { FastifyInstance } from "fastify";

import { EdgeReplayRequestSchema } from "@laundry/contracts";

import { executeEdgeReplay } from "../edge/replay-service.js";
import {
  fail,
  requireCsrf,
  resolveSession,
  type RouteSecurityContext,
} from "./auth-route-support.js";
import { safeErrorContext } from "./local-logger.js";

export function registerEdgeReplayRoute(app: FastifyInstance, context: RouteSecurityContext): void {
  app.post("/api/v2/edge/replay", async (request, reply) => {
    try {
      const parsed = EdgeReplayRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400);
        return fail("VALIDATION_FAILED");
      }
      const resolved = await resolveSession(context.runtime, request);
      if (resolved === null) {
        reply.code(401);
        return fail("AUTHENTICATION_FAILED");
      }
      const csrf = await requireCsrf(context, request, reply, resolved.session);
      if (csrf !== true) return csrf;
      const result = await executeEdgeReplay(context.runtime, resolved, parsed.data);
      if (!result.ok) {
        reply.code(
          result.error.code === "AUTHENTICATION_FAILED"
            ? 401
            : result.error.code === "REPLAY_ARBITRATION_REQUIRED"
              ? 409
              : 503,
        );
      }
      return result;
    } catch (error) {
      request.log.error(safeErrorContext(error), "edge replay request failed");
      reply.code(500);
      return fail("TRANSACTION_FAILED");
    }
  });
}
