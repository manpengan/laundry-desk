/**
 * C8 session resolve from Authorization: Bearer <access_token>.
 * Loads server session after token verify; rejects client tenant-authority headers.
 */

import type { AccessTokenClaims } from "@laundry/contracts";

import type { AccessTokenSigner } from "../identity/crypto-util.js";
import type { IdentityClock, SessionRecord, SessionRepository } from "../identity/types.js";
import { AuthError, FORBIDDEN_TENANT_AUTHORITY_HEADERS, type AuthContext } from "./context.js";

export type ResolveSessionInput = Readonly<{
  authorizationHeader: string | null | undefined;
  /**
   * Raw request headers (lower-case keys recommended).
   * Presence of spoof headers for tenant authority is rejected — never used as source of truth.
   */
  headers?: Readonly<Record<string, string | undefined>>;
  via?: AuthContext["actor"]["via"];
}>;

export type ResolveSessionDeps = Readonly<{
  sessions: SessionRepository;
  accessTokenSigner: AccessTokenSigner;
  clock: IdentityClock;
}>;

const BEARER_RE = /^Bearer\s+(\S+)$/iu;

const extractBearer = (header: string | null | undefined): string | null => {
  if (header === null || header === undefined || header.trim() === "") return null;
  const match = BEARER_RE.exec(header.trim());
  return match?.[1] ?? null;
};

/**
 * Reject if the client attempts to assert org/store/staff authority via headers.
 * Tenant always comes from the verified server session, never from these headers.
 */
export const assertNoTenantAuthorityHeaders = (
  headers: Readonly<Record<string, string | undefined>> | undefined,
): void => {
  if (headers === undefined) return;
  const keys = Object.keys(headers);
  for (const key of keys) {
    const lower = key.toLowerCase();
    if (
      (FORBIDDEN_TENANT_AUTHORITY_HEADERS as readonly string[]).includes(lower) &&
      headers[key] !== undefined &&
      headers[key] !== ""
    ) {
      throw new AuthError(
        "TENANT_SPOOF_REJECTED",
        "Client tenant authority headers are not accepted",
      );
    }
  }
};

const claimsMatchSession = (claims: AccessTokenClaims, session: SessionRecord): boolean =>
  session.status === "active" &&
  claims.session_id === session.session_id &&
  claims.session_version === session.session_version &&
  claims.org_id === session.org_id &&
  claims.store_id === session.store_id &&
  claims.staff_id === session.staff_id &&
  claims.device_id === session.device_id &&
  claims.permission_version === session.permission_version;

/**
 * Resolve AuthContext from Bearer access token + server session record.
 * Fail-closed on missing/invalid token, expired claims, revoked session, or version mismatch.
 */
export const resolveSessionFromBearer = async (
  deps: ResolveSessionDeps,
  input: ResolveSessionInput,
): Promise<AuthContext> => {
  assertNoTenantAuthorityHeaders(input.headers);

  const token = extractBearer(input.authorizationHeader);
  if (token === null) {
    throw new AuthError("AUTHENTICATION_FAILED", "Missing bearer token");
  }

  const claims = deps.accessTokenSigner.verify(token);
  if (claims === null) {
    throw new AuthError("AUTHENTICATION_FAILED", "Invalid access token");
  }

  const now = deps.clock.nowEpochSeconds();
  if (now < claims.iat || now >= claims.exp) {
    throw new AuthError("AUTHENTICATION_FAILED", "Access token expired");
  }

  const session = await deps.sessions.get(claims.session_id);
  if (session === null || !claimsMatchSession(claims, session)) {
    throw new AuthError("AUTHENTICATION_FAILED", "Session is not active");
  }

  return Object.freeze({
    actor: Object.freeze({
      staff_id: session.staff_id,
      device_id: session.device_id,
      via: input.via ?? "ui",
    }),
    tenant: Object.freeze({
      org_id: session.org_id,
      store_id: session.store_id,
    }),
    session_id: session.session_id,
    session_version: session.session_version,
    family_id: session.family_id,
    permission_version: session.permission_version,
    authentication_method: session.authentication_method,
  });
};

export const createSessionResolver = (deps: ResolveSessionDeps) =>
  Object.freeze({
    resolve: (input: ResolveSessionInput) => resolveSessionFromBearer(deps, input),
    assertNoTenantAuthorityHeaders,
  });
