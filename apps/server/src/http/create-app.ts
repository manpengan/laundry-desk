/**
 * Fastify app factory for local web-server testing (memory identity + M1 bus).
 *
 * Auth lifecycle routes call C6 services (A5 lifecycle_http ingress).
 * Business commands go through C1 bus only.
 */

import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";

import { createCommandError, CSRF_HEADER_NAME, type CommandErrorCode } from "@laundry/contracts";

import { AuthError, type AuthContext } from "../auth/context.js";
import { resolveSessionFromBearer } from "../auth/resolve-session.js";
import {
  buildAccessSessionResponse,
  loadSessionStaffAuthority,
  prepareAccessSessionProjection,
  type AccessSessionProjection,
  type AuthorizedSession,
} from "../auth/session-view.js";
import { executeCommand } from "../bus/executor.js";
import { executeQuery } from "../bus/execute-query.js";
import type { ActorContext } from "../bus/types.js";
import { FakeSqlClient } from "../db/fake-client.js";
import { withPoolClient } from "../db/pg-sql-client.js";
import type { SqlClient, TenantContext } from "../db/types.js";
import { createRegisteredM1Bus } from "../handlers/register-m1.js";
import { preparePasswordLogin } from "../identity/login.js";
import {
  issueSession,
  logoutSession,
  previewRefreshSession,
  rotateRefresh,
} from "../identity/session.js";
import type { SessionRecord } from "../identity/types.js";
import { IdentityError } from "../identity/types.js";
import type { LocalRuntime } from "../local/demo-seed.js";
import { LOCAL_PROFILE } from "../local/profile.js";
import {
  csrfCookieOptions,
  refreshCookieOptions,
  resolveCookiePolicy,
  type CookiePolicy,
} from "./cookie-policy.js";
import { registerPinRoutes } from "./pin-routes.js";

export type CreateAppOptions = Readonly<{
  runtime: LocalRuntime;
  corsOrigin?: string | readonly string[];
  /** Override cookie Secure / __Host- policy (tests force non-secure). */
  cookiePolicy?: CookiePolicy;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(code: CommandErrorCode) {
  return Object.freeze({
    ok: false as const,
    error: createCommandError(code),
  });
}

function setAuthCookies(
  reply: FastifyReply,
  policy: CookiePolicy,
  refreshSecret: string,
  csrfToken: string,
): void {
  reply.setCookie(policy.refreshName, refreshSecret, { ...refreshCookieOptions(policy) });
  reply.setCookie(policy.csrfName, csrfToken, { ...csrfCookieOptions(policy) });
}

function clearAuthCookies(reply: FastifyReply, policy: CookiePolicy): void {
  reply.clearCookie(policy.refreshName, { path: policy.path });
  reply.clearCookie(policy.csrfName, { path: policy.path });
}

function tenantFromSession(session: SessionRecord): TenantContext {
  return Object.freeze({
    orgId: session.org_id,
    storeId: session.store_id,
    staffId: session.staff_id,
  });
}

const ADMIN_PERMISSIONS = Object.freeze([
  "settings_admin",
  "staff_read",
  "staff_write",
  "order_write",
]);
const STAFF_PERMISSIONS = Object.freeze(["staff_read", "order_write"]);
const NO_PERMISSIONS = Object.freeze([] as string[]);
function actorFromSession(resolved: AuthorizedSession): ActorContext {
  const { session, authority } = resolved;
  return Object.freeze({
    staffId: session.staff_id,
    deviceId: session.device_id,
    via: "ui" as const,
    // order_write: M2 counter receive/pickup (UI + local HTTP).
    permissions:
      authority.role === "admin"
        ? ADMIN_PERMISSIONS
        : authority.role === "staff"
          ? STAFF_PERMISSIONS
          : NO_PERMISSIONS,
  });
}

function sessionMatchesAuthContext(session: SessionRecord, context: AuthContext): boolean {
  return (
    session.status === "active" &&
    session.session_id === context.session_id &&
    session.session_version === context.session_version &&
    session.family_id === context.family_id &&
    session.permission_version === context.permission_version &&
    session.authentication_method === context.authentication_method &&
    session.org_id === context.tenant.org_id &&
    session.store_id === context.tenant.store_id &&
    session.staff_id === context.actor.staff_id &&
    session.device_id === context.actor.device_id
  );
}

async function resolveSession(
  runtime: LocalRuntime,
  request: FastifyRequest,
): Promise<AuthorizedSession | null> {
  let context: AuthContext;
  try {
    context = await resolveSessionFromBearer(runtime.identity.sessions, {
      authorizationHeader: request.headers.authorization,
      headers: request.headers,
      via: "ui",
    });
  } catch (error) {
    if (error instanceof AuthError) return null;
    throw error;
  }

  const session = await runtime.identity.sessions.sessions.get(context.session_id);
  if (session === null || !sessionMatchesAuthContext(session, context)) return null;
  if (session.org_id !== LOCAL_PROFILE.orgId || session.store_id !== LOCAL_PROFILE.storeId) {
    return null;
  }
  const authority = await loadSessionStaffAuthority(runtime, {
    org_id: session.org_id,
    store_id: session.store_id,
    staff_id: session.staff_id,
    permission_version: session.permission_version,
  });
  return authority === null ? null : Object.freeze({ session, authority });
}

const sessionInvalid = (): IdentityError =>
  new IdentityError("SESSION_INVALID", "Authentication failed");

async function requireProjection(
  projection: Promise<AccessSessionProjection | null>,
): Promise<AccessSessionProjection> {
  const resolved = await projection;
  if (resolved === null) throw sessionInvalid();
  return resolved;
}

function mapIdentityHttpError(error: unknown, reply: FastifyReply, request?: FastifyRequest) {
  if (error instanceof IdentityError) {
    if (error.code === "AUTHENTICATION_FAILED" || error.code === "SESSION_INVALID") {
      reply.code(401);
      return fail("AUTHENTICATION_FAILED");
    }
    if (error.code === "CSRF_REJECTED") {
      reply.code(403);
      return fail("CSRF_REJECTED");
    }
    if (error.code === "PIN_LOCKED") {
      reply.code(429);
      return fail("RATE_LIMITED");
    }
    if (error.code === "PIN_CHALLENGE_INVALID") {
      reply.code(400);
      return fail("RESOURCE_UNAVAILABLE");
    }
  }
  request?.log.error({ err: error }, "identity request failed");
  reply.code(500);
  return fail("TRANSACTION_FAILED");
}

function requireCsrf(
  request: FastifyRequest,
  reply: FastifyReply,
  policy: CookiePolicy,
): true | ReturnType<typeof fail> {
  const header = request.headers[CSRF_HEADER_NAME.toLowerCase()];
  const cookieVal = request.cookies[policy.csrfName];
  if (typeof header !== "string" || header.length === 0 || header !== cookieVal) {
    reply.code(403);
    return fail("CSRF_REJECTED");
  }
  return true;
}

/** Build a fully configured Fastify instance (no listen). Prefer inject() in tests. */
export async function createLocalApp(options: CreateAppOptions): Promise<FastifyInstance> {
  const { runtime } = options;
  const cookiePolicy = options.cookiePolicy ?? resolveCookiePolicy();
  const corsOriginList: string[] = Array.isArray(options.corsOrigin)
    ? [...options.corsOrigin]
    : typeof options.corsOrigin === "string"
      ? [options.corsOrigin]
      : ["http://127.0.0.1:5173", "http://localhost:5173"];

  const app = Fastify({ logger: false });
  await app.register(cors, {
    origin: corsOriginList,
    credentials: true,
  });
  await app.register(cookie);

  const memorySql = new FakeSqlClient();

  app.get("/health", async () =>
    Object.freeze({
      ok: true as const,
      data: Object.freeze({
        service: "@laundry/server",
        mode: runtime.mode === "pg" ? "local-pg" : "local-memory",
        platform: runtime.platform.persistence === "sql" ? "sql" : "memory",
        cookies: cookiePolicy.secure ? "host-secure" : "local-http",
        at: Date.now(),
      }),
    }),
  );

  app.get("/api/v2/local/staff", async (request, reply) => {
    try {
      const resolved = await resolveSession(runtime, request);
      if (
        resolved === null ||
        resolved.session.org_id !== LOCAL_PROFILE.orgId ||
        resolved.session.store_id !== LOCAL_PROFILE.storeId
      ) {
        reply.code(401);
        return fail("AUTHENTICATION_FAILED");
      }
      return Object.freeze({ ok: true as const, data: runtime.staffDirectory });
    } catch (error) {
      if (error instanceof AuthError) {
        reply.code(401);
        return fail("AUTHENTICATION_FAILED");
      }
      reply.code(500);
      return fail("TRANSACTION_FAILED");
    }
  });

  app.post("/api/v2/auth/login", async (request, reply) => {
    try {
      const prepared = await preparePasswordLogin(runtime.identity.login, request.body);
      const projection = await requireProjection(prepareAccessSessionProjection(runtime, prepared));
      const issued = await issueSession(runtime.identity.sessions, {
        ...prepared,
        expected_role: projection.role,
      });
      const accessSession = buildAccessSessionResponse(issued, projection);
      setAuthCookies(reply, cookiePolicy, issued.refresh.refresh_token, issued.csrf.csrf_token);
      return Object.freeze({ ok: true as const, data: accessSession });
    } catch (error) {
      return mapIdentityHttpError(error, reply, request);
    }
  });

  app.post("/api/v2/auth/refresh", async (request, reply) => {
    const refreshSecret = request.cookies[cookiePolicy.refreshName];
    if (typeof refreshSecret !== "string" || refreshSecret.length === 0) {
      reply.code(401);
      return fail("AUTHENTICATION_FAILED");
    }
    try {
      const preview = await previewRefreshSession(runtime.identity.sessions, refreshSecret);
      if (preview === null) {
        await rotateRefresh(runtime.identity.sessions, refreshSecret);
        throw sessionInvalid();
      }
      const projection = await requireProjection(prepareAccessSessionProjection(runtime, preview));
      const issued = await rotateRefresh(runtime.identity.sessions, refreshSecret, {
        expected_role: projection.role,
      });
      const accessSession = buildAccessSessionResponse(issued, projection);
      setAuthCookies(reply, cookiePolicy, issued.refresh.refresh_token, issued.csrf.csrf_token);
      return Object.freeze({ ok: true as const, data: accessSession });
    } catch (error) {
      if (error instanceof IdentityError) clearAuthCookies(reply, cookiePolicy);
      return mapIdentityHttpError(error, reply, request);
    }
  });

  app.post("/api/v2/auth/logout", async (request, reply) => {
    try {
      const resolved = await resolveSession(runtime, request);
      if (resolved !== null) {
        const { session } = resolved;
        await logoutSession(runtime.identity.sessions, {
          org_id: session.org_id,
          store_id: session.store_id,
          staff_id: session.staff_id,
          device_id: session.device_id,
          session_id: session.session_id,
          family_id: session.family_id,
          session_version: session.session_version,
        });
      }
      return Object.freeze({
        ok: true as const,
        data: Object.freeze({ logged_out: true as const }),
      });
    } catch (error) {
      request.log.error({ err: error }, "logout failed");
      reply.code(500);
      return fail("TRANSACTION_FAILED");
    } finally {
      clearAuthCookies(reply, cookiePolicy);
    }
  });

  registerPinRoutes(app, {
    runtime,
    cookiePolicy,
    resolveSession,
    requireCsrf,
    mapIdentityHttpError,
    setAuthCookies,
    prepareAccessSessionProjection: (binding) => prepareAccessSessionProjection(runtime, binding),
    buildAccessSessionResponse,
    isRecord,
    fail,
  });

  const runWithSql = async <T>(fn: (sql: SqlClient) => Promise<T>): Promise<T> => {
    if (runtime.mode === "pg" && runtime.pool !== null) {
      return withPoolClient(runtime.pool, (sql) => fn(sql));
    }
    return fn(memorySql);
  };

  app.post("/v1/commands/:name", async (request, reply) => {
    try {
      const resolved = await resolveSession(runtime, request);
      if (resolved === null) {
        reply.code(401);
        return fail("AUTHENTICATION_FAILED");
      }
      const params = request.params as { name?: string };
      const name = typeof params.name === "string" ? params.name : "";
      if (name.length === 0) {
        reply.code(400);
        return fail("VALIDATION_FAILED");
      }
      const body = isRecord(request.body) ? request.body : {};
      // Confirm / step-up second hop: body may be { confirm_ref } only (WYSIWYS).
      const confirmRef =
        typeof body.confirm_ref === "string" && body.confirm_ref.length > 0
          ? body.confirm_ref
          : undefined;
      const input = confirmRef !== undefined ? Object.freeze({}) : body;
      const { registry, chainHooks } = createRegisteredM1Bus({
        identity: runtime.identity,
        platform: runtime.platform,
        order: runtime.order,
        catalog: runtime.catalog,
        print: runtime.print,
        stats: runtime.stats,
        customer: runtime.customer,
        shift: runtime.shift,
        photo: runtime.photo,
      });
      const tenant = tenantFromSession(resolved.session);
      const actor = actorFromSession(resolved);
      const result = await runWithSql((sql) =>
        executeCommand(sql, tenant, name, input, {
          registry,
          actor,
          chainHooks,
          pendingStore: runtime.pendingStore,
          stepUpProofStore: runtime.stepUpProofStore,
          sessionBinding: Object.freeze({
            sessionId: resolved.session.session_id,
            sessionVersion: resolved.session.session_version,
          }),
          ...(confirmRef !== undefined ? { confirmRef } : {}),
        }),
      );

      if (!result.ok) {
        // Policy gates are authorization outcomes, not bad requests.
        if (
          result.error.code === "POLICY_STEP_UP_REQUIRED" ||
          result.error.code === "POLICY_CONFIRMATION_REQUIRED" ||
          result.error.code === "POLICY_DENIED" ||
          result.error.code === "PERMISSION_DENIED"
        ) {
          reply.code(403);
        } else {
          reply.code(400);
        }
      }
      return result;
    } catch (error) {
      request.log.error({ err: error }, "command request failed");
      reply.code(500);
      return fail("TRANSACTION_FAILED");
    }
  });

  app.post("/v1/queries/:name", async (request, reply) => {
    try {
      const resolved = await resolveSession(runtime, request);
      if (resolved === null) {
        reply.code(401);
        return fail("AUTHENTICATION_FAILED");
      }
      const params = request.params as { name?: string };
      const name = typeof params.name === "string" ? params.name : "";
      if (name.length === 0) {
        reply.code(400);
        return fail("VALIDATION_FAILED");
      }
      const body = isRecord(request.body) ? request.body : {};
      const { queryRegistry } = createRegisteredM1Bus({
        identity: runtime.identity,
        platform: runtime.platform,
        order: runtime.order,
        catalog: runtime.catalog,
        print: runtime.print,
        stats: runtime.stats,
        customer: runtime.customer,
        shift: runtime.shift,
        photo: runtime.photo,
      });
      const tenant = tenantFromSession(resolved.session);
      const actor = actorFromSession(resolved);
      const result = await runWithSql((sql) =>
        executeQuery(sql, tenant, name, body, {
          registry: queryRegistry,
          actor,
        }),
      );

      if (!result.ok) {
        reply.code(400);
      }
      return result;
    } catch (error) {
      request.log.error({ err: error }, "query request failed");
      reply.code(500);
      return fail("TRANSACTION_FAILED");
    }
  });

  return app;
}
