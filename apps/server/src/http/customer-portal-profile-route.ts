import type { FastifyInstance } from "fastify";

import { CustomerPortalProfileUpdateInputSchema } from "@laundry/contracts";

import {
  CustomerPortalProfileConflictError,
  CustomerPortalSessionInvalidError,
} from "../customer-self-service/index.js";
import { fail } from "./auth-route-support.js";
import { customerPortalCsrfAllowed, hashCustomerPortalSecret } from "./customer-portal-cookie.js";
import {
  customerPortalTabAuthority,
  resolveCustomerPortalIdentity,
  type CustomerPortalRouteDeps,
} from "./customer-portal-route-support.js";
import { safeErrorContext } from "./local-logger.js";

export function registerCustomerPortalProfileRoute(
  app: FastifyInstance,
  deps: CustomerPortalRouteDeps,
): void {
  app.post("/api/v2/customer/profile", async (request, reply) => {
    try {
      const resolved = await resolveCustomerPortalIdentity(request, deps);
      if (resolved === null) {
        reply.code(401);
        return fail("AUTHENTICATION_FAILED");
      }
      const authority = customerPortalTabAuthority(request);
      if (
        authority === null ||
        !customerPortalCsrfAllowed(request, deps.cookiePolicy, authority, resolved.identity)
      ) {
        reply.code(403);
        return fail("CSRF_REJECTED");
      }
      const limit = deps.queryRateLimiter.check(resolved.identity.sessionId, resolved.source);
      if (!limit.allowed) {
        reply.header("Retry-After", String(limit.retryAfterSeconds)).code(429);
        return fail("RATE_LIMITED");
      }
      const parsed = CustomerPortalProfileUpdateInputSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400);
        return fail("VALIDATION_FAILED");
      }
      const profile = await deps.store.updateProfile(
        resolved.identity,
        hashCustomerPortalSecret(resolved.secret),
        parsed.data,
      );
      return Object.freeze({ ok: true as const, data: profile });
    } catch (error) {
      if (error instanceof CustomerPortalProfileConflictError) {
        reply.code(409);
        return fail("IDEMPOTENCY_CONFLICT");
      }
      if (error instanceof CustomerPortalSessionInvalidError) {
        reply.code(401);
        return fail("AUTHENTICATION_FAILED");
      }
      request.log.error(safeErrorContext(error), "customer portal profile update failed");
      reply.code(500);
      return fail("TRANSACTION_FAILED");
    }
  });
}
