import { randomBytes } from "node:crypto";

import type { FastifyInstance, FastifyRequest } from "fastify";

import {
  CUSTOMER_SELF_SERVICE_QUERY_NAMES,
  CustomerPortalBenefitsResultSchema,
  CustomerPortalEmptyInputSchema,
  CustomerPortalGarmentProgressResultSchema,
  CustomerPortalGarmentsListResultSchema,
  CustomerPortalLoginInputSchema,
  CustomerPortalOrderGetResultSchema,
  CustomerPortalOrdersListResultSchema,
  CustomerPortalProfileResultSchema,
  CustomerPortalReceiptResultSchema,
  CustomerPortalSessionSchema,
  CustomerPortalWalletResultSchema,
  CustomerSelfServiceGarmentProgressInputSchema,
  CustomerSelfServiceOrderInputSchema,
  CustomerSelfServiceOrdersListInputSchema,
  type CustomerPortalLoginInput,
} from "@laundry/contracts";

import {
  CustomerPortalSessionInvalidError,
  type CustomerPortalQueryName,
  type CustomerPortalQueryResult,
} from "../customer-self-service/index.js";
import { fail, isRecord } from "./auth-route-support.js";
import {
  clearCustomerPortalCookies,
  customerPortalCsrfAllowed,
  hashCustomerPortalSecret,
  setCustomerPortalCookies,
  setCustomerPortalNoStore,
} from "./customer-portal-cookie.js";
import { registerCustomerPortalProfileRoute } from "./customer-portal-profile-route.js";
import {
  customerPortalTabAuthority,
  resolveCustomerPortalIdentity,
  type CustomerPortalRouteDeps,
} from "./customer-portal-route-support.js";
import { safeErrorContext } from "./local-logger.js";
import { trustedClientSource } from "./request-security.js";

export type { CustomerPortalRouteDeps } from "./customer-portal-route-support.js";

function loginRateInput(request: FastifyRequest, source: string) {
  const body = isRecord(request.body) ? request.body : {};
  const dimension = (value: unknown): string =>
    typeof value === "string" && /^[\x21-\x7E]{1,128}$/u.test(value) ? value : "invalid";
  const dimensions = Object.freeze({
    orgCode: dimension(body.org_code),
    storeCode: dimension(body.store_code),
    phone: dimension(body.phone),
  });
  return Object.freeze({
    org_code: dimensions.orgCode,
    store_code: dimensions.storeCode,
    username: dimensions.phone,
    ip: source,
  });
}

function parseQueryInput(name: CustomerPortalQueryName, body: unknown) {
  if (name === "customer.self_service.orders.list") {
    return CustomerSelfServiceOrdersListInputSchema.safeParse(body);
  }
  if (name === "customer.self_service.garment.progress") {
    return CustomerSelfServiceGarmentProgressInputSchema.safeParse(body);
  }
  if (
    name === "customer.self_service.wallet.get" ||
    name === "customer.self_service.benefits.get" ||
    name === "customer.self_service.profile.get"
  ) {
    return CustomerPortalEmptyInputSchema.safeParse(body);
  }
  return CustomerSelfServiceOrderInputSchema.safeParse(body);
}

function parseQueryResult(name: CustomerPortalQueryName, result: CustomerPortalQueryResult) {
  if (name === "customer.self_service.orders.list") {
    return CustomerPortalOrdersListResultSchema.parse(result);
  }
  if (name === "customer.self_service.order.get") {
    return CustomerPortalOrderGetResultSchema.parse(result);
  }
  if (name === "customer.self_service.receipt.get") {
    return CustomerPortalReceiptResultSchema.parse(result);
  }
  if (name === "customer.self_service.garments.list") {
    return CustomerPortalGarmentsListResultSchema.parse(result);
  }
  if (name === "customer.self_service.wallet.get") {
    return CustomerPortalWalletResultSchema.parse(result);
  }
  if (name === "customer.self_service.benefits.get") {
    return CustomerPortalBenefitsResultSchema.parse(result);
  }
  if (name === "customer.self_service.profile.get") {
    return CustomerPortalProfileResultSchema.parse(result);
  }
  return CustomerPortalGarmentProgressResultSchema.parse(result);
}

function registerLogin(app: FastifyInstance, deps: CustomerPortalRouteDeps): void {
  app.post("/api/v2/customer/auth/login", async (request, reply) => {
    setCustomerPortalNoStore(reply);
    const source = trustedClientSource(request, deps.requestSecurity);
    if (source === null) {
      reply.code(400);
      return fail("VALIDATION_FAILED");
    }
    const attempt = deps.loginRateLimiter.beginAttempt(loginRateInput(request, source));
    if (!attempt.allowed) {
      reply.header("Retry-After", String(attempt.retryAfterSeconds)).code(429);
      return fail("RATE_LIMITED");
    }
    const timingStartedAt = deps.loginTimingGuard.start();
    let settled = false;
    try {
      const parsed = CustomerPortalLoginInputSchema.safeParse(request.body);
      const authority = customerPortalTabAuthority(request);
      if (!parsed.success || authority === null) {
        settled = true;
        attempt.reservation.fail();
        reply.code(400);
        return fail("VALIDATION_FAILED");
      }
      const sessionRaw = randomBytes(32).toString("base64url");
      const csrfRaw = `v1.${randomBytes(32).toString("base64url")}`;
      const identity = await deps.store.createSession(parsed.data as CustomerPortalLoginInput, {
        sessionHash: hashCustomerPortalSecret(sessionRaw),
        csrfHash: hashCustomerPortalSecret(csrfRaw),
        authorityHash: hashCustomerPortalSecret(authority),
      });
      if (identity === null) {
        settled = true;
        const decision = attempt.reservation.fail();
        if (!decision.allowed) {
          reply.header("Retry-After", String(decision.retryAfterSeconds)).code(429);
          return fail("RATE_LIMITED");
        }
        reply.code(401);
        return fail("AUTHENTICATION_FAILED");
      }
      settled = true;
      attempt.reservation.succeed();
      setCustomerPortalCookies(reply, deps.cookiePolicy, authority, sessionRaw, csrfRaw);
      return Object.freeze({
        ok: true as const,
        data: CustomerPortalSessionSchema.parse({
          authenticated: true,
          expires_at: Math.floor(identity.expiresAt.getTime() / 1_000),
        }),
      });
    } catch (error) {
      if (!settled) attempt.reservation.release();
      request.log.error(safeErrorContext(error), "customer portal login failed");
      reply.code(500);
      return fail("TRANSACTION_FAILED");
    } finally {
      await deps.loginTimingGuard.settle(timingStartedAt);
    }
  });
}

function registerSessionRoutes(app: FastifyInstance, deps: CustomerPortalRouteDeps): void {
  app.get("/api/v2/customer/auth/session", async (request, reply) => {
    setCustomerPortalNoStore(reply);
    try {
      const resolved = await resolveCustomerPortalIdentity(request, deps);
      if (resolved === null) {
        const authority = customerPortalTabAuthority(request);
        if (authority !== null) clearCustomerPortalCookies(reply, deps.cookiePolicy, authority);
        reply.code(401);
        return fail("AUTHENTICATION_FAILED");
      }
      const limit = deps.queryRateLimiter.check(resolved.identity.sessionId, resolved.source);
      if (!limit.allowed) {
        reply.header("Retry-After", String(limit.retryAfterSeconds)).code(429);
        return fail("RATE_LIMITED");
      }
      return Object.freeze({
        ok: true as const,
        data: CustomerPortalSessionSchema.parse({
          authenticated: true,
          expires_at: Math.floor(resolved.identity.expiresAt.getTime() / 1_000),
        }),
      });
    } catch (error) {
      request.log.error(safeErrorContext(error), "customer portal session lookup failed");
      reply.code(500);
      return fail("TRANSACTION_FAILED");
    }
  });
  app.post("/api/v2/customer/auth/logout", async (request, reply) => {
    setCustomerPortalNoStore(reply);
    try {
      if (!CustomerPortalEmptyInputSchema.safeParse(request.body).success) {
        reply.code(400);
        return fail("VALIDATION_FAILED");
      }
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
      const revoked = await deps.store.revokeSession(
        hashCustomerPortalSecret(resolved.secret),
        resolved.identity.csrfHash,
        resolved.identity.authorityHash,
      );
      if (!revoked) {
        reply.code(401);
        return fail("AUTHENTICATION_FAILED");
      }
      return Object.freeze({ ok: true as const, data: Object.freeze({ logged_out: true }) });
    } catch (error) {
      request.log.error(safeErrorContext(error), "customer portal logout failed");
      reply.code(500);
      return fail("TRANSACTION_FAILED");
    } finally {
      const authority = customerPortalTabAuthority(request);
      if (authority !== null) clearCustomerPortalCookies(reply, deps.cookiePolicy, authority);
    }
  });
}

function registerQueries(app: FastifyInstance, deps: CustomerPortalRouteDeps): void {
  for (const queryName of CUSTOMER_SELF_SERVICE_QUERY_NAMES) {
    const name = queryName as CustomerPortalQueryName;
    app.post(`/v1/queries/${name}`, async (request, reply) => {
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
        const parsed = parseQueryInput(name, request.body);
        if (!parsed.success) {
          reply.code(400);
          return fail("VALIDATION_FAILED");
        }
        const result = await deps.store.executeQuery(
          resolved.identity,
          hashCustomerPortalSecret(resolved.secret),
          name,
          Object.freeze({ ...parsed.data }),
        );
        if (result === null) {
          reply.code(404);
          return fail("RESOURCE_UNAVAILABLE");
        }
        return Object.freeze({
          ok: true as const,
          data: Object.freeze({
            execution: "executed" as const,
            result: parseQueryResult(name, result),
          }),
        });
      } catch (error) {
        if (error instanceof CustomerPortalSessionInvalidError) {
          reply.code(401);
          return fail("AUTHENTICATION_FAILED");
        }
        request.log.error(safeErrorContext(error), "customer portal query failed");
        reply.code(500);
        return fail("TRANSACTION_FAILED");
      }
    });
  }
}

export function registerCustomerPortalRoutes(
  app: FastifyInstance,
  deps: CustomerPortalRouteDeps,
): void {
  registerLogin(app, deps);
  registerSessionRoutes(app, deps);
  registerQueries(app, deps);
  registerCustomerPortalProfileRoute(app, deps);
}
