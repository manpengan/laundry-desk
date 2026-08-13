import type { AuthorizedSession } from "../auth/session-view.js";
import { loadSessionStaffAuthority } from "../auth/session-view.js";
import type { ByokRuntime } from "./byok-runtime.js";
import type { ByokTransactionContext } from "./byok-types.js";

function sessionStillMatches(
  current: AuthorizedSession["session"] | null,
  expected: AuthorizedSession["session"],
): boolean {
  return (
    current !== null &&
    current.status === "active" &&
    current.session_id === expected.session_id &&
    current.session_version === expected.session_version &&
    current.family_id === expected.family_id &&
    current.org_id === expected.org_id &&
    current.store_id === expected.store_id &&
    current.staff_id === expected.staff_id &&
    current.device_id === expected.device_id &&
    current.permission_version === expected.permission_version &&
    current.authentication_method === expected.authentication_method
  );
}

async function memoryRequesterIsCurrent(
  runtime: ByokRuntime,
  authorized: AuthorizedSession,
): Promise<boolean> {
  const current = await runtime.local.identity.sessions.sessions.get(authorized.session.session_id);
  const authority = await loadSessionStaffAuthority(runtime.local, {
    org_id: authorized.session.org_id,
    store_id: authorized.session.store_id,
    staff_id: authorized.session.staff_id,
    permission_version: authorized.session.permission_version,
  });
  return sessionStillMatches(current, authorized.session) && authority?.role === "admin";
}

/**
 * Revalidates an R5 requester after approver authority has locked the staff rows.
 * Session/family locks close logout/revocation until the credential transaction commits.
 */
export async function requesterAuthorityIsCurrent(
  runtime: ByokRuntime,
  authorized: AuthorizedSession,
  transaction: ByokTransactionContext,
): Promise<boolean> {
  if (runtime.local.mode !== "pg") return memoryRequesterIsCurrent(runtime, authorized);
  const session = authorized.session;
  const result = await transaction.client.query<Readonly<{ session_id: string }>>(
    `SELECT auth_session.id::text AS session_id
       FROM sessions AS auth_session
       JOIN staffs AS staff
         ON staff.org_id = auth_session.org_id AND staff.id = auth_session.staff_id
       JOIN staff_store_roles AS role
         ON role.org_id = auth_session.org_id
        AND role.store_id = auth_session.store_id
        AND role.staff_id = auth_session.staff_id
       JOIN refresh_families AS family
         ON family.org_id = auth_session.org_id
        AND family.store_id = auth_session.store_id
        AND family.session_id = auth_session.id
      WHERE auth_session.org_id = $1::uuid
        AND auth_session.store_id = $2::uuid
        AND auth_session.staff_id = $3::uuid
        AND auth_session.id = $4::uuid
        AND auth_session.session_version = $5
        AND auth_session.permission_version = $6
        AND auth_session.device_id = $7::uuid
        AND auth_session.authentication_method = $8
        AND auth_session.status = 'active'
        AND staff.is_active = true
        AND staff.permission_version = $6
        AND role.is_active = true
        AND role.role = 'admin'
        AND family.id = $9::uuid
        AND family.status = 'active'
      LIMIT 2
      FOR SHARE OF auth_session, family`,
    [
      session.org_id,
      session.store_id,
      session.staff_id,
      session.session_id,
      session.session_version,
      session.permission_version,
      session.device_id,
      session.authentication_method,
      session.family_id,
    ],
  );
  return result.rows.length === 1 && result.rows[0]?.session_id === session.session_id;
}
