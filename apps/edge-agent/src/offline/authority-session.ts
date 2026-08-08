import type { DesktopSessionView, EdgeAuthorityData } from "@laundry/contracts";

import type { VerifiedOfflineReadAuthority } from "./read-authority.js";

export type AuthoritySessionBinding = Readonly<{
  sessionId: string;
  sessionVersion: number;
  orgId: string;
  storeId: string;
  staffId: string;
  deviceId: string;
  permissionVersion: number;
  role: DesktopSessionView["role"];
}>;

export type ReadAuthoritySessionBinding = Readonly<{
  session: AuthoritySessionBinding;
  authority: VerifiedOfflineReadAuthority;
}>;

export function bindAuthoritySession(session: DesktopSessionView): AuthoritySessionBinding {
  return Object.freeze({
    sessionId: session.session.session_id,
    sessionVersion: session.session.session_version,
    orgId: session.session.org_id,
    storeId: session.session.store_id,
    staffId: session.session.staff_id,
    deviceId: session.session.device_id,
    permissionVersion: session.session.permission_version,
    role: session.role,
  });
}

export function authorityMatchesSession(
  binding: AuthoritySessionBinding,
  session: DesktopSessionView,
): boolean {
  return (
    binding.sessionId === session.session.session_id &&
    binding.sessionVersion === session.session.session_version &&
    binding.orgId === session.session.org_id &&
    binding.storeId === session.session.store_id &&
    binding.staffId === session.session.staff_id &&
    binding.deviceId === session.session.device_id &&
    binding.permissionVersion === session.session.permission_version &&
    binding.role === session.role
  );
}

export function authorityCanRebindSession(
  binding: AuthoritySessionBinding,
  session: DesktopSessionView,
): boolean {
  return (
    binding.orgId === session.session.org_id &&
    binding.storeId === session.session.store_id &&
    binding.staffId === session.session.staff_id &&
    binding.deviceId === session.session.device_id &&
    binding.permissionVersion === session.session.permission_version &&
    binding.role === session.role
  );
}

export function bindReadAuthoritySession(
  session: DesktopSessionView,
  data: EdgeAuthorityData,
): ReadAuthoritySessionBinding {
  return Object.freeze({
    session: bindAuthoritySession(session),
    authority: Object.freeze({
      serverPublicKeySpki: data.server_public_key_spki,
      offlineGrant: data.offline_grant,
    }),
  });
}

export function readAuthorityMatchesSession(
  binding: ReadAuthoritySessionBinding,
  session: DesktopSessionView,
): boolean {
  return authorityMatchesSession(binding.session, session);
}
