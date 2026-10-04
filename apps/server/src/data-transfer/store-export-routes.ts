import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { StoreExportApprovalSchema } from "@laundry/contracts";
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
import { safeErrorContext } from "../http/local-logger.js";
import { EXPORT_EXCLUSIONS, EXPORT_TABLES, exportPolicyHash } from "./store-export-policy.js";
import { approveStoreExport } from "./store-export-requests.js";

export function registerStoreExportRoutes(app: FastifyInstance, context: AuthRouteContext): void {
  const pool = context.runtime.pool;
  if (!pool) return;
  const limiter = createByokMutationRateLimiter({ maxAttempts: 10, windowSeconds: 60 });
  for (const method of ["GET", "POST"] as const)
    app.route({
      method,
      url: "/api/v2/store-export",
      bodyLimit: 4096,
      async handler(request, reply) {
        try {
          const auth = await resolveSession(context.runtime, request);
          if (!auth) {
            reply.code(401);
            return fail("AUTHENTICATION_FAILED");
          }
          if (
            !isConfiguredRuntimeTenant(auth) ||
            auth.authority.role !== "admin" ||
            !auth.authority.is_privacy_admin
          ) {
            reply.code(403);
            return fail("PERMISSION_DENIED");
          }
          const rate = limiter.consume(auth.session.session_id);
          if (!rate.allowed) {
            reply.code(429).header("Retry-After", String(rate.retryAfterSeconds));
            return fail("RATE_LIMITED");
          }
          if (method === "GET")
            return {
              ok: true,
              data: {
                policy_sha256: exportPolicyHash(),
                table_count: EXPORT_TABLES.length,
                excluded_tables: Object.entries(EXPORT_EXCLUSIONS).map(([name, reason]) => ({
                  name,
                  reason,
                })),
                scope: "current_store_and_shared_org_resources",
                includes_customer_pii: true,
                includes_all_referenced_photos: true,
              },
            };
          const csrf = await requireCsrf(context, request, reply, auth.session);
          if (csrf !== true) return csrf;
          const input = StoreExportApprovalSchema.parse(request.body);
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
          let verified = false;
          try {
            verified = await context.runtime.identity.login.passwordPort.verifyPassword(
              input.password,
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
          return {
            ok: true,
            data: await approveStoreExport(
              pool,
              auth,
              input.policy_sha256,
              context.runtime.accessTokenSecret,
            ),
          };
        } catch (error) {
          request.log.error(safeErrorContext(error), "store export authorization failed");
          reply.code(error instanceof z.ZodError ? 400 : 409);
          return fail(error instanceof z.ZodError ? "VALIDATION_FAILED" : "RESOURCE_UNAVAILABLE");
        }
      },
    });
}
