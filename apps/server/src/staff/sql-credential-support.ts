import type { SqlClient, TenantContext } from "../db/types.js";
import type { StaffAccessRow } from "./access-store.js";
import type { StaffCredentialIssue, StaffCredentialSetupResult } from "./credential-types.js";

export const PENDING_PASSWORD_HASH = "!laundry-credential-pending";

export type TargetRow = Readonly<{
  staff_id: string;
  username: string;
  display_name: string;
  password_hash: string;
  pin_hash: string | null;
  role: string;
  privacy_admin: boolean;
  staff_active: boolean;
  role_active: boolean;
  permission_version: number;
}>;

export function accessRow(
  row: TargetRow,
  active = row.staff_active && row.role_active,
): StaffAccessRow {
  if (
    (row.role !== "admin" && row.role !== "staff") ||
    !Number.isSafeInteger(row.permission_version)
  ) {
    throw new Error("Invalid staff credential target row");
  }
  return Object.freeze({
    staff_id: row.staff_id,
    username: row.username,
    display_name: row.display_name,
    role: row.role,
    privacy_admin: row.privacy_admin,
    is_active: active,
    permission_version: row.permission_version,
  });
}

export const setupResult = (issue: StaffCredentialIssue): StaffCredentialSetupResult =>
  Object.freeze({
    credential_setup_ref: issue.setupRef,
    target_staff_id: issue.targetStaffId,
    expires_at: issue.expiresAt,
    status: "pending" as const,
  });

export async function hasActiveAdmin(
  client: SqlClient,
  tenant: TenantContext,
  actorStaffId: string,
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1
       FROM staff_store_roles role
       JOIN staffs staff ON staff.org_id = role.org_id AND staff.id = role.staff_id
      WHERE role.org_id = $1::uuid AND role.store_id = $2::uuid
        AND role.staff_id = $3::uuid AND role.role = 'admin'
        AND role.is_active AND staff.is_active
      LIMIT 1`,
    [tenant.orgId, tenant.storeId, actorStaffId],
  );
  return result.rows.length === 1;
}

/** Serialize credential completion/reset row locking for one tenant store. */
export async function lockStaffCredentialLifecycle(
  client: SqlClient,
  tenant: TenantContext,
): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `laundry:staff-credentials:${tenant.orgId}:${tenant.storeId}`,
  ]);
}

export async function lockAuthorityRows(client: SqlClient, tenant: TenantContext): Promise<void> {
  await client.query(
    `SELECT staff_id FROM staff_store_roles
      WHERE org_id = $1::uuid AND store_id = $2::uuid
      ORDER BY staff_id FOR UPDATE`,
    [tenant.orgId, tenant.storeId],
  );
}

export async function countOtherAuthorities(
  client: SqlClient,
  tenant: TenantContext,
  staffId: string,
): Promise<Readonly<{ admins: number; privacyAdmins: number }>> {
  const result = await client.query<{ admins: string; privacy_admins: string }>(
    `SELECT count(*) FILTER (WHERE role.role = 'admin')::text AS admins,
            count(*) FILTER (WHERE role.is_privacy_admin)::text AS privacy_admins
       FROM staff_store_roles role
       JOIN staffs staff ON staff.org_id = role.org_id AND staff.id = role.staff_id
      WHERE role.org_id = $1::uuid AND role.store_id = $2::uuid
        AND role.staff_id <> $3::uuid AND role.is_active AND staff.is_active`,
    [tenant.orgId, tenant.storeId, staffId],
  );
  return Object.freeze({
    admins: Number(result.rows[0]?.admins ?? "0"),
    privacyAdmins: Number(result.rows[0]?.privacy_admins ?? "0"),
  });
}

export async function insertSetup(
  client: SqlClient,
  tenant: TenantContext,
  actorStaffId: string,
  issue: StaffCredentialIssue,
  purpose: "create" | "reset",
  role: "admin" | "staff",
  privacyAdmin: boolean,
  permissionVersion: number,
): Promise<boolean> {
  const result = await client.query(
    `INSERT INTO staff_credential_setups (
       id, org_id, store_id, staff_id, created_by_staff_id, purpose,
       activate_role, activate_privacy_admin, target_permission_version,
       status, expires_at, consumed_at, created_at
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8, $9,
       'pending', to_timestamp($10), NULL, to_timestamp($11)
     ) ON CONFLICT DO NOTHING`,
    [
      issue.setupRef,
      tenant.orgId,
      tenant.storeId,
      issue.targetStaffId,
      actorStaffId,
      purpose,
      role,
      privacyAdmin,
      permissionVersion,
      issue.expiresAt,
      issue.createdAt,
    ],
  );
  return result.rowCount === 1;
}

export async function revokeTargetSessions(
  client: SqlClient,
  tenant: TenantContext,
  actorStaffId: string,
  staffId: string,
): Promise<void> {
  await client.query(
    "SELECT public.laundry_revoke_staff_sessions($1::uuid, $2::uuid, $3::uuid, $4::uuid)",
    [tenant.orgId, tenant.storeId, actorStaffId, staffId],
  );
}
