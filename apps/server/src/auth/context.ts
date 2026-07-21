/**
 * C8 AuthContext — actor + tenant only from server-side session resolve.
 * Never trust client-reported org_id / store_id / staff_id as authority.
 */

import type { AuthenticationMethod, Uuid } from "../identity/types.js";

export type AuthActor = Readonly<{
  staff_id: Uuid;
  device_id: Uuid;
  via: "ui" | "ai" | "automation";
}>;

export type AuthTenant = Readonly<{
  org_id: Uuid;
  store_id: Uuid;
}>;

/**
 * Request-scoped authentication context.
 * Built exclusively by resolveSessionFromBearer (or equivalent server path).
 */
export type AuthContext = Readonly<{
  actor: AuthActor;
  tenant: AuthTenant;
  session_id: Uuid;
  session_version: number;
  family_id: Uuid;
  permission_version: number;
  authentication_method: AuthenticationMethod;
}>;

/** Headers clients might try to spoof for tenant authority — C8 must ignore/reject. */
export const FORBIDDEN_TENANT_AUTHORITY_HEADERS = Object.freeze([
  "x-org-id",
  "x-store-id",
  "x-staff-id",
  "x-tenant-org-id",
  "x-tenant-store-id",
  "org_id",
  "store_id",
  "staff_id",
] as const);

export type ForbiddenTenantHeader = (typeof FORBIDDEN_TENANT_AUTHORITY_HEADERS)[number];

export class AuthError extends Error {
  readonly code: "AUTHENTICATION_FAILED" | "CSRF_REJECTED" | "TENANT_SPOOF_REJECTED";

  constructor(
    code: "AUTHENTICATION_FAILED" | "CSRF_REJECTED" | "TENANT_SPOOF_REJECTED",
    message: string,
  ) {
    super(message);
    this.name = "AuthError";
    this.code = code;
  }
}
