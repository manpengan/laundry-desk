/**
 * C6 password login: org_code / store_code / username / password → session.
 * Does not write access tokens into cookies (memory_only). Refresh/CSRF are cookie descriptors.
 */

import { randomBytes } from "node:crypto";

import { LoginRequestSchema, type LoginRequest } from "@laundry/contracts";

import type { PasswordPort } from "./password.js";
import { issueSession, type IssueSessionInput, type SessionServiceDeps } from "./session.js";
import type { OrgStoreRepository, SessionIssueResult, StaffRepository } from "./types.js";
import { IdentityError } from "./types.js";

export type PasswordLoginDeps = Readonly<{
  staff: StaffRepository;
  orgStore: OrgStoreRepository;
  passwordPort: PasswordPort;
  /** Test seams may inject a cheap valid hash for their PasswordPort implementation. */
  dummyPasswordHash?: string;
}>;

export type LoginServiceDeps = PasswordLoginDeps &
  Readonly<{
    sessions: SessionServiceDeps;
  }>;

export type LoginResult = SessionIssueResult;
export type PreparedPasswordLogin = IssueSessionInput;

const authFailed = (): IdentityError =>
  new IdentityError("AUTHENTICATION_FAILED", "Authentication failed");

/*
 * Generated from an unreachable random value using the production Argon2id
 * parameters. A hash is not a credential; retaining no matching plaintext makes
 * it suitable only for constant-work authentication failures.
 */
const DEFAULT_DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$g1ARIub2U3mp2igkzlY3EQ$iZYLO1U176MTYwPbSngUUAC8TqsOIoBe1uRYPCY3KXo";
const MALFORMED_REQUEST_PASSWORD = randomBytes(32).toString("base64url");

function candidateFromMalformedRequest(rawRequest: unknown): string {
  try {
    if (typeof rawRequest !== "object" || rawRequest === null || Array.isArray(rawRequest)) {
      return MALFORMED_REQUEST_PASSWORD;
    }
    const password = (rawRequest as Readonly<Record<string, unknown>>).password;
    return typeof password === "string" && password.length > 0 && password.length <= 1_024
      ? password
      : MALFORMED_REQUEST_PASSWORD;
  } catch {
    return MALFORMED_REQUEST_PASSWORD;
  }
}

function parseLoginRequest(rawRequest: unknown): LoginRequest | null {
  try {
    const parsed = LoginRequestSchema.safeParse(rawRequest);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Authenticate staff and open a browser session.
 * Client-reported org_id/store_id headers must never be used here — only codes + credentials.
 */
export const preparePasswordLogin = async (
  deps: PasswordLoginDeps,
  rawRequest: unknown,
): Promise<PreparedPasswordLogin> => {
  const request = parseLoginRequest(rawRequest);
  const dummyPasswordHash = deps.dummyPasswordHash ?? DEFAULT_DUMMY_PASSWORD_HASH;
  if (request === null) {
    await deps.passwordPort.verifyPassword(
      candidateFromMalformedRequest(rawRequest),
      dummyPasswordHash,
    );
    throw authFailed();
  }

  const orgStore = await deps.orgStore.findByCodes(request.org_code, request.store_code);
  const staff =
    orgStore === null
      ? null
      : await deps.staff.findByOrgUsername(orgStore.org_id, request.username);
  const activeStaff = staff?.is_active === true && staff.org_id === orgStore?.org_id ? staff : null;
  const passwordMatches = await deps.passwordPort.verifyPassword(
    request.password,
    activeStaff?.password_hash ?? dummyPasswordHash,
  );
  if (orgStore === null || activeStaff === null || !passwordMatches) throw authFailed();

  return Object.freeze({
    org_id: orgStore.org_id,
    store_id: orgStore.store_id,
    staff_id: activeStaff.staff_id,
    device_id: request.device_id,
    permission_version: activeStaff.permission_version,
    authentication_method: "password",
    replacement: Object.freeze({ kind: "login" as const }),
  });
};

export const loginWithPassword = async (
  deps: LoginServiceDeps,
  rawRequest: unknown,
): Promise<LoginResult> =>
  issueSession(deps.sessions, await preparePasswordLogin(deps, rawRequest));

export const createLoginService = (deps: LoginServiceDeps) =>
  Object.freeze({
    login: (rawRequest: unknown) => loginWithPassword(deps, rawRequest),
  });
