import type { FastifyReply, FastifyRequest } from "fastify";

import {
  createCommandError,
  CSRF_HEADER_NAME,
  type CommandErrorCode,
  type CsrfRequestSurface,
} from "@laundry/contracts";

import { AuthError, type AuthContext } from "../auth/context.js";
import { checkCsrfDoubleSubmit } from "../auth/csrf.js";
import { resolveSessionFromBearer } from "../auth/resolve-session.js";
import {
  loadSessionStaffAuthority,
  type AccessSessionProjection,
  type AuthorizedSession,
} from "../auth/session-view.js";
import { hashOpaqueSecret } from "../identity/crypto-util.js";
import type { RefreshFamilyRecord, RefreshTokenRecord, SessionRecord } from "../identity/types.js";
import { IdentityError } from "../identity/types.js";
import type { LocalRuntime } from "../local/demo-seed.js";
import { LOCAL_PROFILE } from "../local/profile.js";
import {
  csrfCookieClearOptions,
  csrfCookieOptions,
  refreshCookieClearOptions,
  refreshCookieOptions,
  type CookiePolicy,
} from "./cookie-policy.js";
import { safeErrorContext } from "./local-logger.js";
import type { LoginRateLimitInput, LoginRateLimiter } from "./login-rate-limit.js";
import type { LocalRequestSecurityPolicy } from "./request-security.js";
import type { SecurityEventSink } from "./security-events.js";

export type FailureEnvelope = Readonly<{
  ok: false;
  error: ReturnType<typeof createCommandError>;
}>;

export type RouteSecurityContext = Readonly<{
  runtime: LocalRuntime;
  cookiePolicy: CookiePolicy;
  requestSecurity: LocalRequestSecurityPolicy;
  securityEvents: SecurityEventSink;
}>;

export type AuthRouteContext = RouteSecurityContext &
  Readonly<{
    loginRateLimiter: LoginRateLimiter;
  }>;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function fail(code: CommandErrorCode): FailureEnvelope {
  return Object.freeze({
    ok: false as const,
    error: createCommandError(code),
  });
}

export function setAuthCookies(
  reply: FastifyReply,
  policy: CookiePolicy,
  refreshSecret: string,
  csrfToken: string,
): void {
  reply.setCookie(policy.refreshName, refreshSecret, { ...refreshCookieOptions(policy) });
  reply.setCookie(policy.csrfName, csrfToken, { ...csrfCookieOptions(policy) });
}

export function clearAuthCookies(reply: FastifyReply, policy: CookiePolicy): void {
  reply.clearCookie(policy.refreshName, { ...refreshCookieClearOptions(policy) });
  reply.clearCookie(policy.csrfName, { ...csrfCookieClearOptions(policy) });
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

export async function resolveSession(
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

export const sessionInvalid = (): IdentityError =>
  new IdentityError("SESSION_INVALID", "Authentication failed");

export async function requireProjection(
  projection: Promise<AccessSessionProjection | null>,
): Promise<AccessSessionProjection> {
  const resolved = await projection;
  if (resolved === null) throw sessionInvalid();
  return resolved;
}

export function mapIdentityHttpError(
  error: unknown,
  reply: FastifyReply,
  request?: FastifyRequest,
): FailureEnvelope {
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
  request?.log.error(safeErrorContext(error), "identity request failed");
  reply.code(500);
  return fail("TRANSACTION_FAILED");
}

type KnownRefreshToken = Exclude<RefreshTokenRecord, { status: "unknown" }>;
export type RefreshBinding = Readonly<{
  session: SessionRecord;
  family: RefreshFamilyRecord;
  token: KnownRefreshToken;
}>;

export async function resolveRefreshBinding(
  runtime: LocalRuntime,
  refreshSecret: string,
  activeTokenOnly: boolean,
): Promise<RefreshBinding | null> {
  const token = await runtime.identity.sessions.refresh.getTokenByHash(
    hashOpaqueSecret(refreshSecret),
  );
  if (token.status === "unknown" || (activeTokenOnly && token.status !== "active")) return null;
  const [session, family] = await Promise.all([
    runtime.identity.sessions.sessions.get(token.session_id),
    runtime.identity.sessions.refresh.getFamily(token.family_id),
  ]);
  if (session === null || family === null) return null;
  if (!validRefreshBinding(runtime, session, family, token, activeTokenOnly)) return null;
  return Object.freeze({ session, family, token });
}

function validRefreshBinding(
  runtime: LocalRuntime,
  session: SessionRecord,
  family: RefreshFamilyRecord,
  token: KnownRefreshToken,
  activeTokenOnly: boolean,
): boolean {
  if (
    session.status !== "active" ||
    family.status !== "active" ||
    session.session_id !== token.session_id ||
    session.family_id !== token.family_id ||
    family.session_id !== token.session_id ||
    session.org_id !== LOCAL_PROFILE.orgId ||
    session.store_id !== LOCAL_PROFILE.storeId
  ) {
    return false;
  }
  return (
    !activeTokenOnly ||
    (token.status === "active" &&
      token.expires_at > runtime.identity.sessions.clock.nowEpochSeconds())
  );
}

function csrfRequestSurface(
  request: FastifyRequest,
  policy: LocalRequestSecurityPolicy,
): CsrfRequestSurface {
  const origin = request.headers.origin;
  const fetchSite = request.headers["sec-fetch-site"];
  if (origin === policy.browserOrigin && fetchSite === "same-site") {
    return Object.freeze({ kind: "browser" as const, fetch_site: "same-site" as const });
  }
  if (origin === policy.desktopOrigin && fetchSite === "same-origin") {
    return Object.freeze({
      kind: "trusted-desktop" as const,
      fetch_site: "same-origin" as const,
    });
  }
  return Object.freeze({ kind: "untrusted" as const });
}

function recordCsrfRejection(
  context: RouteSecurityContext,
  request: FastifyRequest,
  session: SessionRecord,
): void {
  context.securityEvents.record(request, {
    reason: "CSRF_REJECTED",
    ip: request.ip,
    session_id: session.session_id,
  });
}

export async function requireCsrf(
  context: RouteSecurityContext,
  request: FastifyRequest,
  reply: FastifyReply,
  session: SessionRecord,
  rotationNonce?: string,
): Promise<true | FailureEnvelope> {
  const { runtime } = context;
  const header = request.headers[CSRF_HEADER_NAME.toLowerCase()];
  const cookieValue = request.cookies[context.cookiePolicy.csrfName];
  const currentToken =
    rotationNonce === undefined
      ? await runtime.identity.sessions.refresh.getActiveTokenForSession(session.session_id)
      : null;
  const nonce = rotationNonce ?? currentToken?.token_id;
  if (
    nonce === undefined ||
    (currentToken !== null &&
      (currentToken.family_id !== session.family_id ||
        currentToken.expires_at <= runtime.identity.sessions.clock.nowEpochSeconds()))
  ) {
    recordCsrfRejection(context, request, session);
    reply.code(403);
    return fail("CSRF_REJECTED");
  }
  const result = checkCsrfDoubleSubmit({
    method: "POST",
    surface: csrfRequestSurface(request, context.requestSecurity),
    cookie_token: cookieValue,
    header_token: typeof header === "string" ? header : undefined,
    proof_signer: runtime.csrfProofSigner,
    proof_binding: {
      session_id: session.session_id,
      session_version: session.session_version,
      rotation_nonce: nonce,
    },
  });
  if (!result.allowed) {
    recordCsrfRejection(context, request, session);
    reply.code(403);
    return fail("CSRF_REJECTED");
  }
  return true;
}

const INVALID_RATE_LIMIT_DIMENSION = "invalid";

export function loginRateLimitInput(request: FastifyRequest): LoginRateLimitInput {
  const body = isRecord(request.body) ? request.body : {};
  const dimension = (value: unknown): string =>
    typeof value === "string" && /^[\x21-\x7E]{1,128}$/u.test(value)
      ? value
      : INVALID_RATE_LIMIT_DIMENSION;
  return Object.freeze({
    org_code: dimension(body.org_code),
    store_code: dimension(body.store_code),
    username: dimension(body.username),
    ip: request.ip,
  });
}

function accountDimension(input: LoginRateLimitInput) {
  return Object.freeze({
    org_code: input.org_code,
    store_code: input.store_code,
    username: input.username,
  });
}

export function rateLimited(
  request: FastifyRequest,
  reply: FastifyReply,
  securityEvents: SecurityEventSink,
  input: LoginRateLimitInput,
  retryAfterSeconds: number,
): FailureEnvelope {
  securityEvents.record(request, {
    reason: "LOGIN_RATE_LIMITED",
    account: accountDimension(input),
    ip: input.ip,
  });
  reply.header("Retry-After", String(retryAfterSeconds));
  reply.code(429);
  return fail("RATE_LIMITED");
}

export function recordLoginFailure(
  request: FastifyRequest,
  securityEvents: SecurityEventSink,
  input: LoginRateLimitInput,
): void {
  securityEvents.record(request, {
    reason: "LOGIN_FAILED",
    account: accountDimension(input),
    ip: input.ip,
  });
}
