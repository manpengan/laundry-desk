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
  RefreshFamilyRecord,
  RefreshRepository,
  RefreshTokenRecord,
  SessionIssueReplacement,
  SessionIssueResult,
  SessionLifecycleRepository,
  SessionRecord,
  SessionRepository,
  Uuid,
} from "./types.js";
import { IdentityError as IdError } from "./types.js";

export type { SessionIssueResult };

export type SessionServiceDeps = Readonly<{
  sessions: SessionRepository;
  refresh: RefreshRepository;
  lifecycle: SessionLifecycleRepository;
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
  /** Atomic replacement policy for password login or PIN quick-switch. */
  replacement?: SessionIssueReplacement;
  /** Server-owned role observed while preparing the response projection. */
  expected_role?: "admin" | "staff";
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

  const access_token = buildAccessToken(
    deps.accessTokenSigner,
    session,
    now,
    input.authentication_method,
  );
  const refresh = mintRefreshMaterial(refreshSecret);
  const csrf = mintCsrfMaterial();
  const family = Object.freeze({
    family_id: familyId,
    session_id: sessionId,
    status: "active" as const,
  });
  const token = Object.freeze({
    status: "active" as const,
    token_id: tokenId,
    family_id: familyId,
    session_id: sessionId,
    token_hash: tokenHash,
    expires_at: now + REFRESH_TOKEN_TTL_SECONDS,
  });
  const committed = await deps.lifecycle.commitIssue({
    session,
    family,
    token,
    ...(input.replacement === undefined ? {} : { replacement: input.replacement }),
    ...(input.expected_role === undefined ? {} : { expected_role: input.expected_role }),
  });
  if (committed !== 1) throw authFailed();

  return Object.freeze({
    access_token,
    token_type: "Bearer" as const,
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    storage: "memory_only" as const,
    session: toSessionView(session),
    refresh,
    csrf,
  });
};

export type RefreshResult = SessionIssueResult;

type RefreshSnapshot = Readonly<{
  token: RefreshTokenRecord;
  family: RefreshFamilyRecord | null;
  session: SessionRecord | null;
}>;

async function loadRefreshSnapshot(
  deps: SessionServiceDeps,
  tokenHash: string,
): Promise<RefreshSnapshot> {
  const token = await deps.refresh.getTokenByHash(tokenHash);
  const [family, session] =
    token.status === "unknown"
      ? [null, null]
      : await Promise.all([
          deps.refresh.getFamily(token.family_id),
          deps.sessions.get(token.session_id),
        ]);
  return Object.freeze({ token, family, session });
}

function planRefreshSnapshot(snapshot: RefreshSnapshot, now: number, replacementTokenId: Uuid) {
  const { token, family, session } = snapshot;
  return planRefreshMutation({
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
}

/**
 * Resolve the currently active refresh binding without mutating rotation state.
 * HTTP uses this only to prepare server-owned response authority before the CAS mutation.
 * A null preview must still flow through rotateRefresh so reuse detection can revoke the family.
 */
export const previewRefreshSession = async (
  deps: SessionServiceDeps,
  refreshSecret: string,
): Promise<SessionRecord | null> => {
  const token = await deps.refresh.getTokenByHash(hashOpaqueSecret(refreshSecret));
  if (token.status !== "active" || token.expires_at <= deps.clock.nowEpochSeconds()) return null;
  const [family, session] = await Promise.all([
    deps.refresh.getFamily(token.family_id),
    deps.sessions.get(token.session_id),
  ]);
  if (
    family === null ||
    family.status !== "active" ||
    family.family_id !== token.family_id ||
    family.session_id !== token.session_id ||
    session === null ||
    session.status !== "active" ||
    session.session_id !== token.session_id ||
    session.family_id !== token.family_id
  ) {
    return null;
  }
  return session;
};

/**
 * Rotate refresh token. Reuse of a rotated token invalidates the whole family.
 */
export const rotateRefresh = async (
  deps: SessionServiceDeps,
  refreshSecret: string,
  expectation: Readonly<{ expected_role?: "admin" | "staff" }> = Object.freeze({}),
): Promise<RefreshResult> => {
  const now = deps.clock.nowEpochSeconds();
  const tokenHash = hashOpaqueSecret(refreshSecret);
  const snapshot = await loadRefreshSnapshot(deps, tokenHash);
  const replacementTokenId = newUuid();
  const plan = planRefreshSnapshot(snapshot, now, replacementTokenId);

  if (plan.kind === "reject") throw authFailed();
  const { session, family } = snapshot;
  if (snapshot.token.status === "unknown" || session === null || family === null) {
    throw authFailed();
  }

  const newSecret = randomToken();
  const replacementToken = Object.freeze({
    status: "active" as const,
    token_id: replacementTokenId,
    family_id: family.family_id,
    session_id: session.session_id,
    token_hash: hashOpaqueSecret(newSecret),
    expires_at: now + REFRESH_TOKEN_TTL_SECONDS,
  });
  const access_token = buildAccessToken(
    deps.accessTokenSigner,
    session,
    now,
    session.authentication_method,
  );
  const refresh = mintRefreshMaterial(newSecret);
  const csrf = mintCsrfMaterial();
  const disposition = await deps.lifecycle.commitRefreshUse({
    session,
    family,
    presented_token_id: snapshot.token.token_id,
    presented_token_hash: tokenHash,
    replacement_token: replacementToken,
    ...(expectation.expected_role === undefined
      ? {}
      : { expected_role: expectation.expected_role }),
    now,
  });
  if (disposition !== "rotated") throw authFailed();

  return Object.freeze({
    access_token,
    token_type: "Bearer" as const,
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    storage: "memory_only" as const,
    session: toSessionView(session),
    refresh,
    csrf,
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
  input: Readonly<{
    org_id: Uuid;
    store_id: Uuid;
    staff_id: Uuid;
    device_id: Uuid;
    session_id: Uuid;
    family_id: Uuid;
    session_version: number;
  }>,
): Promise<LogoutResult> => {
  const now = deps.clock.nowEpochSeconds();
  const plan = planRefreshRevocation({
    cause: "logout",
    session_version: input.session_version,
  });
  if (plan.kind !== "revoke") throw authFailed();

  const matched = await deps.lifecycle.revokeSessionFamily({
    ...input,
    revoked_at: now,
  });
  classifyLogoutStorageMutation({
    matched_session_rows: matched,
    matched_family_rows: matched,
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
    rotateRefresh: (
      secret: string,
      expectation?: Readonly<{ expected_role?: "admin" | "staff" }>,
    ) => rotateRefresh(deps, secret, expectation),
    logoutSession: (
      input: Readonly<{
        org_id: Uuid;
        store_id: Uuid;
        staff_id: Uuid;
        device_id: Uuid;
        session_id: Uuid;
        family_id: Uuid;
        session_version: number;
      }>,
    ) => logoutSession(deps, input),
    accessTokenSigner: deps.accessTokenSigner,
  });

export { createAccessTokenSigner };
