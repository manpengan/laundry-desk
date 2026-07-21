/**
 * C6 session lifecycle: issue access tokens, refresh rotation with family reuse detection,
 * logout revoke. Cookie material is descriptor-only (no real HTTP server).
 */

import {
  ACCESS_TOKEN_TTL_SECONDS,
  CSRF_COOKIE_DESCRIPTOR,
  REFRESH_COOKIE_CLEAR_DESCRIPTOR,
  REFRESH_COOKIE_DESCRIPTOR,
  REFRESH_TOKEN_TTL_SECONDS,
  classifyLogoutStorageMutation,
  classifyRefreshCasCommit,
  planRefreshMutation,
  planRefreshRevocation,
} from "@laundry/contracts";

import {
  buildAccessClaims,
  createAccessTokenSigner,
  hashOpaqueSecret,
  mintCsrfProof,
  newUuid,
  randomToken,
  type AccessTokenSigner,
} from "./crypto-util.js";
import type {
  AuthenticationMethod,
  IdentityClock,
  IdentityError,
  RefreshRepository,
  SessionIssueResult,
  SessionRecord,
  SessionRepository,
  Uuid,
} from "./types.js";
import { IdentityError as IdError } from "./types.js";

export type { SessionIssueResult };

export type SessionServiceDeps = Readonly<{
  sessions: SessionRepository;
  refresh: RefreshRepository;
  clock: IdentityClock;
  accessTokenSigner: AccessTokenSigner;
}>;

export type IssueSessionInput = Readonly<{
  org_id: Uuid;
  store_id: Uuid;
  staff_id: Uuid;
  device_id: Uuid;
  permission_version: number;
  authentication_method: AuthenticationMethod;
  /** When replacing a prior session (login re-auth / pin switch). */
  previous?: Readonly<{
    session_id: Uuid;
    family_id: Uuid;
    session_version: number;
  }>;
}>;

const authFailed = (): IdentityError =>
  new IdError("AUTHENTICATION_FAILED", "Authentication failed");

const toSessionView = (session: SessionRecord): SessionIssueResult["session"] =>
  Object.freeze({
    session_id: session.session_id,
    session_version: session.session_version,
    org_id: session.org_id,
    store_id: session.store_id,
    staff_id: session.staff_id,
    device_id: session.device_id,
    permission_version: session.permission_version,
  });

const buildAccessToken = (
  signer: AccessTokenSigner,
  session: SessionRecord,
  now: number,
  method: AuthenticationMethod,
): string => {
  const claims = buildAccessClaims({
    session_id: session.session_id,
    session_version: session.session_version,
    org_id: session.org_id,
    store_id: session.store_id,
    staff_id: session.staff_id,
    device_id: session.device_id,
    permission_version: session.permission_version,
    authentication_method: method,
    now,
  });
  return signer.sign(claims);
};

const mintRefreshMaterial = (refreshSecret: string): SessionIssueResult["refresh"] =>
  Object.freeze({
    refresh_token: refreshSecret,
    cookie: Object.freeze({ ...REFRESH_COOKIE_DESCRIPTOR }),
  });

const mintCsrfMaterial = (): SessionIssueResult["csrf"] => {
  const csrf_token = mintCsrfProof();
  return Object.freeze({
    csrf_token,
    cookie: Object.freeze({ ...CSRF_COOKIE_DESCRIPTOR }),
  });
};

/**
 * Create a new session + refresh family + access token.
 * Access token is memory_only in the response shape; never a cookie.
 */
export const issueSession = async (
  deps: SessionServiceDeps,
  input: IssueSessionInput,
): Promise<SessionIssueResult> => {
  const now = deps.clock.nowEpochSeconds();
  const sessionId = newUuid();
  const familyId = newUuid();
  const tokenId = newUuid();
  const refreshSecret = randomToken();
  const tokenHash = hashOpaqueSecret(refreshSecret);

  if (input.previous !== undefined) {
    await deps.sessions.revoke(input.previous.session_id, input.previous.session_version + 1, now);
    await deps.refresh.revokeFamily(input.previous.family_id);
  }

  const session: SessionRecord = Object.freeze({
    session_id: sessionId,
    session_version: 1,
    org_id: input.org_id,
    store_id: input.store_id,
    staff_id: input.staff_id,
    device_id: input.device_id,
    permission_version: input.permission_version,
    authentication_method: input.authentication_method,
    status: "active",
    family_id: familyId,
    created_at: now,
    revoked_at: null,
  });

  await deps.sessions.insert(session);
  await deps.refresh.insertFamily(
    Object.freeze({ family_id: familyId, session_id: sessionId, status: "active" }),
  );
  await deps.refresh.insertToken(
    Object.freeze({
      status: "active" as const,
      token_id: tokenId,
      family_id: familyId,
      session_id: sessionId,
      token_hash: tokenHash,
      expires_at: now + REFRESH_TOKEN_TTL_SECONDS,
    }),
  );

  const access_token = buildAccessToken(
    deps.accessTokenSigner,
    session,
    now,
    input.authentication_method,
  );

  return Object.freeze({
    access_token,
    token_type: "Bearer" as const,
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    storage: "memory_only" as const,
    session: toSessionView(session),
    refresh: mintRefreshMaterial(refreshSecret),
    csrf: mintCsrfMaterial(),
  });
};

export type RefreshResult = SessionIssueResult;

/**
 * Rotate refresh token. Reuse of a rotated token invalidates the whole family.
 */
export const rotateRefresh = async (
  deps: SessionServiceDeps,
  refreshSecret: string,
): Promise<RefreshResult> => {
  const now = deps.clock.nowEpochSeconds();
  const tokenHash = hashOpaqueSecret(refreshSecret);
  const token = await deps.refresh.getTokenByHash(tokenHash);
  const family = token.status === "unknown" ? null : await deps.refresh.getFamily(token.family_id);
  const session = token.status === "unknown" ? null : await deps.sessions.get(token.session_id);

  const replacementTokenId = newUuid();
  const plan = planRefreshMutation({
    token:
      token.status === "unknown"
        ? { status: "unknown" }
        : {
            status: token.status,
            token_id: token.token_id,
            family_id: token.family_id,
            session_id: token.session_id,
            expires_at: token.expires_at,
            ...(token.status === "rotated"
              ? { replacement_token_id: token.replacement_token_id }
              : {}),
          },
    family,
    session:
      session === null
        ? null
        : {
            status: session.status,
            session_id: session.session_id,
            session_version: session.session_version,
          },
    now_epoch_seconds: now,
    replacement_token_id: replacementTokenId,
  });

  if (plan.kind === "reject") throw authFailed();

  if (plan.kind === "revoke") {
    if (session !== null) {
      await deps.sessions.revoke(session.session_id, plan.next_session_version, now);
    }
    if (family !== null) {
      await deps.refresh.revokeFamily(family.family_id);
    }
    throw authFailed();
  }

  // plan.kind === "rotate"
  const matched = await deps.refresh.rotateToken(plan.compare.token_id, replacementTokenId);
  const disposition = classifyRefreshCasCommit({ matched_rows: matched });
  if (disposition.kind !== "committed" || session === null || family === null) {
    throw authFailed();
  }

  const newSecret = randomToken();
  const newHash = hashOpaqueSecret(newSecret);
  await deps.refresh.insertToken(
    Object.freeze({
      status: "active" as const,
      token_id: replacementTokenId,
      family_id: family.family_id,
      session_id: session.session_id,
      token_hash: newHash,
      expires_at: now + REFRESH_TOKEN_TTL_SECONDS,
    }),
  );

  const access_token = buildAccessToken(deps.accessTokenSigner, session, now, "refresh");

  return Object.freeze({
    access_token,
    token_type: "Bearer" as const,
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    storage: "memory_only" as const,
    session: toSessionView(session),
    refresh: mintRefreshMaterial(newSecret),
    csrf: mintCsrfMaterial(),
  });
};

export type LogoutResult = Readonly<{
  logged_out: true;
  clear_cookies: readonly [typeof REFRESH_COOKIE_CLEAR_DESCRIPTOR, ReturnType<typeof csrfClear>];
}>;

const csrfClear = (): Readonly<{
  name: string;
  secure: true;
  http_only: false;
  same_site: "strict";
  path: "/";
  max_age_seconds: 0;
}> =>
  Object.freeze({
    name: CSRF_COOKIE_DESCRIPTOR.name,
    secure: true as const,
    http_only: false as const,
    same_site: "strict" as const,
    path: "/" as const,
    max_age_seconds: 0 as const,
  });

/** Revoke session + family; returns cookie clear descriptors only. */
export const logoutSession = async (
  deps: SessionServiceDeps,
  input: Readonly<{ session_id: Uuid; family_id: Uuid; session_version: number }>,
): Promise<LogoutResult> => {
  const now = deps.clock.nowEpochSeconds();
  const plan = planRefreshRevocation({
    cause: "logout",
    session_version: input.session_version,
  });
  if (plan.kind !== "revoke") throw authFailed();

  const sessionMatched = (await deps.sessions.revoke(
    input.session_id,
    plan.next_session_version,
    now,
  ))
    ? 1
    : 0;
  const familyMatched = (await deps.refresh.revokeFamily(input.family_id)) ? 1 : 0;
  classifyLogoutStorageMutation({
    matched_session_rows: sessionMatched as 0 | 1,
    matched_family_rows: familyMatched as 0 | 1,
  });

  return Object.freeze({
    logged_out: true as const,
    clear_cookies: Object.freeze([
      REFRESH_COOKIE_CLEAR_DESCRIPTOR,
      csrfClear(),
    ]) as LogoutResult["clear_cookies"],
  });
};

export const createSessionService = (deps: SessionServiceDeps) =>
  Object.freeze({
    issueSession: (input: IssueSessionInput) => issueSession(deps, input),
    rotateRefresh: (secret: string) => rotateRefresh(deps, secret),
    logoutSession: (
      input: Readonly<{
        session_id: Uuid;
        family_id: Uuid;
        session_version: number;
      }>,
    ) => logoutSession(deps, input),
    accessTokenSigner: deps.accessTokenSigner,
  });

export { createAccessTokenSigner };
