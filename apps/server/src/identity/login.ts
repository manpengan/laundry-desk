/**
 * C6 password login: org_code / store_code / username / password → session.
 * Does not write access tokens into cookies (memory_only). Refresh/CSRF are cookie descriptors.
 */

import { LoginRequestSchema, type LoginRequest } from "@laundry/contracts";

import type { PasswordPort } from "./password.js";
import { issueSession, type SessionServiceDeps } from "./session.js";
import type { OrgStoreRepository, SessionIssueResult, StaffRepository } from "./types.js";
import { IdentityError } from "./types.js";

export type LoginServiceDeps = Readonly<{
  staff: StaffRepository;
  orgStore: OrgStoreRepository;
  passwordPort: PasswordPort;
  sessions: SessionServiceDeps;
}>;

export type LoginResult = SessionIssueResult;

const authFailed = (): IdentityError =>
  new IdentityError("AUTHENTICATION_FAILED", "Authentication failed");

/**
 * Authenticate staff and open a browser session.
 * Client-reported org_id/store_id headers must never be used here — only codes + credentials.
 */
export const loginWithPassword = async (
  deps: LoginServiceDeps,
  rawRequest: unknown,
): Promise<LoginResult> => {
  let request: LoginRequest;
  try {
    request = LoginRequestSchema.parse(rawRequest);
  } catch {
    throw authFailed();
  }

  const orgStore = await deps.orgStore.findByCodes(request.org_code, request.store_code);
  if (orgStore === null) throw authFailed();

  const staff = await deps.staff.findByOrgUsername(orgStore.org_id, request.username);
  if (staff === null || !staff.is_active) throw authFailed();

  const ok = await deps.passwordPort.verifyPassword(request.password, staff.password_hash);
  if (!ok) throw authFailed();

  return issueSession(deps.sessions, {
    org_id: orgStore.org_id,
    store_id: orgStore.store_id,
    staff_id: staff.staff_id,
    device_id: request.device_id,
    permission_version: staff.permission_version,
    authentication_method: "password",
  });
};

export const createLoginService = (deps: LoginServiceDeps) =>
  Object.freeze({
    login: (rawRequest: unknown) => loginWithPassword(deps, rawRequest),
  });
