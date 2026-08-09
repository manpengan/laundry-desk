import type { FastifyInstance } from "fastify";

import {
  StaffCredentialsCompleteRequestSchema,
  StaffCredentialsCompleteResponseSchema,
} from "@laundry/contracts";

import { permissionsForAuthority } from "../bus/runtime.js";
import { withPoolClient } from "../db/pg-sql-client.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import type { TenantContext } from "../db/types.js";
import {
  fail,
  requireCsrf,
  resolveSession,
  type AuthRouteContext,
} from "../http/auth-route-support.js";
import { safeErrorContext } from "../http/local-logger.js";
import { createSqlStaffCredentialStore } from "./sql-credential-store.js";
import {
  createStaffCredentialRateLimiter,
  type StaffCredentialRateLimiter,
} from "./credential-rate-limit.js";

const STAFF_CREDENTIAL_BODY_LIMIT_BYTES = 4_096;

function tenantOf(
  session: Readonly<{ org_id: string; store_id: string; staff_id: string }>,
): TenantContext {
  return Object.freeze({
    orgId: session.org_id,
    storeId: session.store_id,
    staffId: session.staff_id,
  });
}

export function registerStaffCredentialRoute(
  app: FastifyInstance,
  context: AuthRouteContext,
  limiter: StaffCredentialRateLimiter = createStaffCredentialRateLimiter(),
): void {
  app.post(
    "/api/v2/auth/staff/credentials/complete",
    { bodyLimit: STAFF_CREDENTIAL_BODY_LIMIT_BYTES },
    async (request, reply) => {
      try {
        const resolved = await resolveSession(context.runtime, request);
        if (resolved === null) {
          reply.code(401);
          return fail("AUTHENTICATION_FAILED");
        }
        const csrf = await requireCsrf(context, request, reply, resolved.session);
        if (csrf !== true) return csrf;
        if (
          resolved.authority.role !== "admin" ||
          !permissionsForAuthority(resolved.authority).includes("staff_write")
        ) {
          reply.code(403);
          return fail("PERMISSION_DENIED");
        }
        const parsed = StaffCredentialsCompleteRequestSchema.safeParse(request.body);
        if (!parsed.success) {
          reply.code(400);
          return fail("VALIDATION_FAILED");
        }
        const limit = limiter.consume(resolved.session.session_id);
        if (!limit.allowed) {
          reply.header("Retry-After", String(limit.retryAfterSeconds));
          reply.code(429);
          return fail("RATE_LIMITED");
        }

        const passwordHash = await context.runtime.identity.login.passwordPort.hashPassword(
          parsed.data.password,
        );
        const pinHash = await context.runtime.identity.login.passwordPort.hashPassword(
          parsed.data.pin,
        );
        const completion = Object.freeze({
          credential_setup_ref: parsed.data.credential_setup_ref,
          password_hash: passwordHash,
          pin_hash: pinHash,
          now: context.runtime.identity.sessions.clock.nowEpochSeconds(),
          device_id: resolved.session.device_id,
        });
        const completed =
          context.runtime.mode === "pg" && context.runtime.pool !== null
            ? await withPoolClient(context.runtime.pool, (sql) =>
                withTenantTransaction(sql, tenantOf(resolved.session), (tx) =>
                  createSqlStaffCredentialStore(tx, tenantOf(resolved.session)).complete(
                    resolved.session.staff_id,
                    completion,
                  ),
                ),
              )
            : await context.runtime.staffAccess.credentials.complete(
                resolved.session.staff_id,
                completion,
              );
        if (!completed.ok) {
          reply.code(400);
          return fail("RESOURCE_UNAVAILABLE");
        }
        return Object.freeze({
          ok: true as const,
          data: StaffCredentialsCompleteResponseSchema.parse(completed.result),
        });
      } catch (error) {
        request.log.error(safeErrorContext(error), "staff credential completion failed");
        reply.code(500);
        return fail("TRANSACTION_FAILED");
      }
    },
  );
}
