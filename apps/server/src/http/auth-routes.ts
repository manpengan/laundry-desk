import type { FastifyInstance, FastifyRequest } from "fastify";

import {
  buildAccessSessionResponse,
  prepareAccessSessionProjection,
} from "../auth/session-view.js";
import { preparePasswordLogin } from "../identity/login.js";
import {
  issueSession,
  logoutSession,
  previewRefreshSession,
  rotateRefresh,
} from "../identity/session.js";
import { IdentityError } from "../identity/types.js";
import { loadPgStaffDirectory } from "../local/staff-directory.js";
import { LOCAL_PROFILE } from "../local/profile.js";
import { registerStaffCredentialRoute } from "../staff/credential-route.js";
import {
  clearAuthCookies,
  fail,
  loginRateLimitInput,
  mapIdentityHttpError,
  rateLimited,
  recordLoginFailure,
  requireCsrf,
  requireProjection,
  resolveRefreshBinding,
  resolveSession,
  sessionInvalid,
  setAuthCookies,
  type AuthRouteContext,
} from "./auth-route-support.js";
import { registerPinRoutes } from "./pin-routes.js";

function registerStaffRoute(app: FastifyInstance, context: AuthRouteContext): void {
  app.get("/api/v2/local/staff", async (request, reply) => {
    try {
      const resolved = await resolveSession(context.runtime, request);
      if (
        resolved === null ||
        resolved.session.org_id !== LOCAL_PROFILE.orgId ||
        resolved.session.store_id !== LOCAL_PROFILE.storeId
      ) {
        reply.code(401);
        return fail("AUTHENTICATION_FAILED");
      }
      const data =
        context.runtime.mode === "pg" && context.runtime.pool !== null
          ? await loadPgStaffDirectory(context.runtime.pool)
          : context.runtime.staffDirectory;
      return Object.freeze({ ok: true as const, data });
    } catch (error) {
      return mapIdentityHttpError(error, reply, request);
    }
  });
}

function registerLoginRoute(app: FastifyInstance, context: AuthRouteContext): void {
  app.post("/api/v2/auth/login", async (request, reply) => {
    const limitInput = loginRateLimitInput(request);
    const attempt = context.loginRateLimiter.beginAttempt(limitInput);
    if (!attempt.allowed) {
      return rateLimited(
        request,
        reply,
        context.securityEvents,
        limitInput,
        attempt.retryAfterSeconds,
      );
    }
    let reservationSettled = false;
    const settleReservation = <T>(operation: () => T): T => {
      reservationSettled = true;
      return operation();
    };
    try {
      const prepared = await preparePasswordLogin(context.runtime.identity.login, request.body);
      const projection = await requireProjection(
        prepareAccessSessionProjection(context.runtime, prepared),
      );
      const issued = await issueSession(context.runtime.identity.sessions, {
        ...prepared,
        expected_role: projection.role,
      });
      const accessSession = buildAccessSessionResponse(issued, projection);
      settleReservation(attempt.reservation.succeed);
      setAuthCookies(
        reply,
        context.cookiePolicy,
        issued.refresh.refresh_token,
        issued.csrf.csrf_token,
      );
      return Object.freeze({
        ok: true as const,
        data: accessSession,
      });
    } catch (error) {
      if (
        !reservationSettled &&
        error instanceof IdentityError &&
        error.code === "AUTHENTICATION_FAILED"
      ) {
        const after = settleReservation(attempt.reservation.fail);
        recordLoginFailure(request, context.securityEvents, limitInput, error.detail);
        if (!after.allowed) {
          return rateLimited(
            request,
            reply,
            context.securityEvents,
            limitInput,
            after.retryAfterSeconds,
          );
        }
      } else if (!reservationSettled) {
        settleReservation(attempt.reservation.release);
      }
      return mapIdentityHttpError(error, reply, request);
    }
  });
}

function recordRefreshRejection(
  context: AuthRouteContext,
  request: FastifyRequest,
  sessionId?: string,
): void {
  context.securityEvents.record(request, {
    reason: "REFRESH_REJECTED",
    ip: request.ip,
    ...(sessionId === undefined ? {} : { session_id: sessionId }),
  });
}

function registerRefreshRoute(app: FastifyInstance, context: AuthRouteContext): void {
  app.post("/api/v2/auth/refresh", async (request, reply) => {
    const refreshSecret = request.cookies[context.cookiePolicy.refreshName];
    if (typeof refreshSecret !== "string" || refreshSecret.length === 0) {
      recordRefreshRejection(context, request);
      reply.code(401);
      return fail("AUTHENTICATION_FAILED");
    }
    let sessionId: string | undefined;
    try {
      const binding = await resolveRefreshBinding(context.runtime, refreshSecret, false);
      if (binding === null) throw sessionInvalid();
      sessionId = binding.session.session_id;
      const csrf = await requireCsrf(
        context,
        request,
        reply,
        binding.session,
        binding.token.token_id,
      );
      if (csrf !== true) return csrf;
      const preview = await previewRefreshSession(context.runtime.identity.sessions, refreshSecret);
      if (preview === null) {
        await rotateRefresh(context.runtime.identity.sessions, refreshSecret);
        throw sessionInvalid();
      }
      const projection = await requireProjection(
        prepareAccessSessionProjection(context.runtime, preview),
      );
      const issued = await rotateRefresh(context.runtime.identity.sessions, refreshSecret, {
        expected_role: projection.role,
      });
      const accessSession = buildAccessSessionResponse(issued, projection);
      setAuthCookies(
        reply,
        context.cookiePolicy,
        issued.refresh.refresh_token,
        issued.csrf.csrf_token,
      );
      return Object.freeze({
        ok: true as const,
        data: accessSession,
      });
    } catch (error) {
      if (
        error instanceof IdentityError &&
        (error.code === "AUTHENTICATION_FAILED" || error.code === "SESSION_INVALID")
      ) {
        recordRefreshRejection(context, request, sessionId);
        clearAuthCookies(reply, context.cookiePolicy);
      }
      return mapIdentityHttpError(error, reply, request);
    }
  });
}

function registerLogoutRoute(app: FastifyInstance, context: AuthRouteContext): void {
  app.post("/api/v2/auth/logout", async (request, reply) => {
    const refreshSecret = request.cookies[context.cookiePolicy.refreshName];
    try {
      if (typeof refreshSecret !== "string" || refreshSecret.length === 0) {
        throw sessionInvalid();
      }
      const binding = await resolveRefreshBinding(context.runtime, refreshSecret, true);
      if (binding === null) throw sessionInvalid();
      const csrf = await requireCsrf(
        context,
        request,
        reply,
        binding.session,
        binding.token.token_id,
      );
      if (csrf !== true) return csrf;
      const { session } = binding;
      await logoutSession(context.runtime.identity.sessions, {
        org_id: session.org_id,
        store_id: session.store_id,
        staff_id: session.staff_id,
        device_id: session.device_id,
        session_id: session.session_id,
        family_id: session.family_id,
        session_version: session.session_version,
      });
      return Object.freeze({
        ok: true as const,
        data: Object.freeze({ logged_out: true as const }),
      });
    } catch (error) {
      return mapIdentityHttpError(error, reply, request);
    } finally {
      clearAuthCookies(reply, context.cookiePolicy);
    }
  });
}

function registerPinAuthRoutes(app: FastifyInstance, context: AuthRouteContext): void {
  registerPinRoutes(app, {
    runtime: context.runtime,
    cookiePolicy: context.cookiePolicy,
    securityEvents: context.securityEvents,
    resolveSession,
    requireCsrf: (request, reply, _policy, session) =>
      requireCsrf(context, request, reply, session),
    mapIdentityHttpError,
    setAuthCookies,
    prepareAccessSessionProjection: (binding) =>
      prepareAccessSessionProjection(context.runtime, binding),
    buildAccessSessionResponse,
    fail,
  });
}

export function registerAuthRoutes(app: FastifyInstance, context: AuthRouteContext): void {
  registerStaffRoute(app, context);
  registerLoginRoute(app, context);
  registerRefreshRoute(app, context);
  registerLogoutRoute(app, context);
  registerStaffCredentialRoute(app, context);
  registerPinAuthRoutes(app, context);
}
