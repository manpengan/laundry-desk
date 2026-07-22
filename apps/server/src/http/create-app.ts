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

import { executeCommand } from "../bus/executor.js";
import type { ActorContext } from "../bus/types.js";
import { FakeSqlClient } from "../db/fake-client.js";
import type { TenantContext } from "../db/types.js";
import { createRegisteredM1Bus } from "../handlers/register-m1.js";
import { createAccessTokenSigner } from "../identity/crypto-util.js";
import { loginWithPassword } from "../identity/login.js";
import { createQuickSwitchChallenge, verifyQuickSwitchPin } from "../identity/pin.js";
import { logoutSession, rotateRefresh } from "../identity/session.js";
import type { SessionIssueResult, SessionRecord } from "../identity/types.js";
import { IdentityError } from "../identity/types.js";
import type { LocalRuntime } from "../local/demo-seed.js";
import { LOCAL_COOKIE_NAMES } from "./types.js";

export type CreateAppOptions = Readonly<{
  runtime: LocalRuntime;
  corsOrigin?: string | readonly string[];
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBearer(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(\S+)$/iu.exec(header.trim());
  return match?.[1] ?? null;
}

function fail(code: CommandErrorCode) {
  return Object.freeze({
    ok: false as const,
    error: createCommandError(code),
  });
}

function setAuthCookies(reply: FastifyReply, refreshSecret: string, csrfToken: string): void {
  reply.setCookie(LOCAL_COOKIE_NAMES.refresh, refreshSecret, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: false,
  });
  reply.setCookie(LOCAL_COOKIE_NAMES.csrf, csrfToken, {
    httpOnly: false,
    sameSite: "lax",
    path: "/",
    secure: false,
  });
}

function clearAuthCookies(reply: FastifyReply): void {
  reply.clearCookie(LOCAL_COOKIE_NAMES.refresh, { path: "/" });
  reply.clearCookie(LOCAL_COOKIE_NAMES.csrf, { path: "/" });
}

function publicAccessBody(issued: SessionIssueResult) {
  return Object.freeze({
    access_token: issued.access_token,
    token_type: issued.token_type,
    expires_in: issued.expires_in,
    storage: issued.storage,
    session: issued.session,
  });
}

function tenantFromSession(session: SessionRecord): TenantContext {
  return Object.freeze({
    orgId: session.org_id,
    storeId: session.store_id,
    staffId: session.staff_id,
  });
}

function actorFromSession(session: SessionRecord): ActorContext {
  const isAdmin = session.staff_id.endsWith("111103") || session.staff_id.includes("103");
  return Object.freeze({
    staffId: session.staff_id,
    deviceId: session.device_id,
    via: "ui" as const,
    permissions: isAdmin
      ? Object.freeze(["settings_admin", "staff_read", "staff_write"])
      : Object.freeze(["staff_read"]),
  });
}

async function resolveSession(
  runtime: LocalRuntime,
  token: string | null,
): Promise<SessionRecord | null> {
  if (token === null || token.length === 0) return null;
  const signer = createAccessTokenSigner(runtime.accessTokenSecret);
  const claims = signer.verify(token);
  if (claims === null) return null;
  const session = await runtime.identity.sessions.sessions.get(claims.session_id);
  if (session === null || session.status !== "active") return null;
  if (session.session_version !== claims.session_version) return null;
  return session;
}

function mapIdentityHttpError(error: unknown, reply: FastifyReply) {
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
  reply.code(500);
  return fail("TRANSACTION_FAILED");
}

function requireCsrf(request: FastifyRequest, reply: FastifyReply): true | ReturnType<typeof fail> {
  const header = request.headers[CSRF_HEADER_NAME.toLowerCase()];
  const cookieVal = request.cookies[LOCAL_COOKIE_NAMES.csrf];
  if (typeof header !== "string" || header.length === 0 || header !== cookieVal) {
    reply.code(403);
    return fail("CSRF_REJECTED");
  }
  return true;
}

/** Build a fully configured Fastify instance (no listen). Prefer inject() in tests. */
export async function createLocalApp(options: CreateAppOptions): Promise<FastifyInstance> {
  const { runtime } = options;
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

  const sql = new FakeSqlClient();

  app.get("/health", async () =>
    Object.freeze({
      ok: true as const,
      data: Object.freeze({
        service: "@laundry/server",
        mode: runtime.mode === "pg" ? "local-pg" : "local-memory",
        at: Date.now(),
      }),
    }),
  );

  app.get("/api/v2/local/staff", async () =>
    Object.freeze({ ok: true as const, data: runtime.staffDirectory }),
  );

  app.post("/api/v2/auth/login", async (request, reply) => {
    try {
      const issued = await loginWithPassword(runtime.identity.login, request.body);
      setAuthCookies(reply, issued.refresh.refresh_token, issued.csrf.csrf_token);
      return Object.freeze({ ok: true as const, data: publicAccessBody(issued) });
    } catch (error) {
      return mapIdentityHttpError(error, reply);
    }
  });

  app.post("/api/v2/auth/refresh", async (request, reply) => {
    const refreshSecret = request.cookies[LOCAL_COOKIE_NAMES.refresh];
    if (typeof refreshSecret !== "string" || refreshSecret.length === 0) {
      reply.code(401);
      return fail("AUTHENTICATION_FAILED");
    }
    try {
      const issued = await rotateRefresh(runtime.identity.sessions, refreshSecret);
      setAuthCookies(reply, issued.refresh.refresh_token, issued.csrf.csrf_token);
      return Object.freeze({ ok: true as const, data: publicAccessBody(issued) });
    } catch (error) {
      clearAuthCookies(reply);
      return mapIdentityHttpError(error, reply);
    }
  });

  app.post("/api/v2/auth/logout", async (request, reply) => {
    const accessToken = readBearer(request);
    const session = await resolveSession(runtime, accessToken);
    try {
      if (session !== null) {
        await logoutSession(runtime.identity.sessions, {
          session_id: session.session_id,
          family_id: session.family_id,
          session_version: session.session_version,
        });
      }
    } catch {
      // still clear cookies
    }
    clearAuthCookies(reply);
    return Object.freeze({ ok: true as const, data: Object.freeze({ logged_out: true as const }) });
  });

  app.post("/api/v2/auth/pin/challenges", async (request, reply) => {
    const session = await resolveSession(runtime, readBearer(request));
    if (session === null) {
      reply.code(401);
      return fail("AUTHENTICATION_FAILED");
    }
    const csrf = requireCsrf(request, reply);
    if (csrf !== true) return csrf;
    const body = isRecord(request.body) ? request.body : {};
    try {
      if (body.purpose !== "quick_switch" || typeof body.target_staff_id !== "string") {
        reply.code(400);
        return fail("VALIDATION_FAILED");
      }
      const challenge = await createQuickSwitchChallenge(runtime.identity.pin, {
        purpose: "quick_switch",
        session,
        target_staff_id: body.target_staff_id,
      });
      return Object.freeze({
        ok: true as const,
        data: Object.freeze({
          challenge_id: challenge.challenge_id,
          purpose: challenge.purpose,
          expires_at: challenge.expires_at,
          max_attempts: challenge.max_attempts,
        }),
      });
    } catch (error) {
      return mapIdentityHttpError(error, reply);
    }
  });

  app.post("/api/v2/auth/pin/challenges/:challengeId/verify", async (request, reply) => {
    const session = await resolveSession(runtime, readBearer(request));
    if (session === null) {
      reply.code(401);
      return fail("AUTHENTICATION_FAILED");
    }
    const csrf = requireCsrf(request, reply);
    if (csrf !== true) return csrf;
    const params = request.params as { challengeId?: string };
    const body = isRecord(request.body) ? request.body : {};
    const challengeId =
      typeof body.challenge_id === "string"
        ? body.challenge_id
        : typeof params.challengeId === "string"
          ? params.challengeId
          : "";
    const pin = typeof body.pin === "string" ? body.pin : "";
    try {
      const issued = await verifyQuickSwitchPin(runtime.identity.pin, {
        challenge_id: challengeId,
        pin,
        session,
      });
      setAuthCookies(reply, issued.refresh.refresh_token, issued.csrf.csrf_token);
      return Object.freeze({ ok: true as const, data: publicAccessBody(issued) });
    } catch (error) {
      return mapIdentityHttpError(error, reply);
    }
  });

  app.post("/v1/commands/:name", async (request, reply) => {
    const session = await resolveSession(runtime, readBearer(request));
    if (session === null) {
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
    const { registry, chainHooks } = createRegisteredM1Bus({
      identity: runtime.identity,
      platform: runtime.platform,
    });
    const result = await executeCommand(sql, tenantFromSession(session), name, body, {
      registry,
      actor: actorFromSession(session),
      chainHooks,
    });
    if (!result.ok) {
      reply.code(400);
    }
    return result;
  });

  return app;
}
