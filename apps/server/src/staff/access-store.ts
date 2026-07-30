import type { SqlClient, TenantContext } from "../db/types.js";

export type StaffAccessRow = Readonly<{
  staff_id: string;
  username: string;
  display_name: string;
  role: "admin" | "staff";
  privacy_admin: boolean;
  is_active: boolean;
  permission_version: number;
}>;

export type StaffAccessChange = Readonly<{
  target_staff_id: string;
  expected_permission_version: number;
  role: "admin" | "staff";
  privacy_admin: boolean;
  is_active: boolean;
}>;

export type StaffAccessChangeResult =
  | Readonly<{ ok: true; before: StaffAccessRow; after: StaffAccessRow }>
  | Readonly<{
      ok: false;
      reason: "not_found" | "stale" | "self_change" | "last_admin" | "last_privacy_admin";
    }>;

export type StaffAccessStore = Readonly<{
  list: () => Promise<readonly StaffAccessRow[]>;
  set: (actorStaffId: string, change: StaffAccessChange) => Promise<StaffAccessChangeResult>;
}>;

type StaffAccessDbRow = Readonly<{
  staff_id: string;
  username: string;
  display_name: string;
  role: string;
  privacy_admin: boolean;
  is_active: boolean;
  permission_version: number;
}>;

const freezeRow = (row: StaffAccessDbRow): StaffAccessRow => {
  if (
    (row.role !== "admin" && row.role !== "staff") ||
    !Number.isSafeInteger(row.permission_version) ||
    row.permission_version < 1
  ) {
    throw new Error("Invalid staff access row");
  }
  return Object.freeze({
    staff_id: row.staff_id,
    username: row.username,
    display_name: row.display_name,
    role: row.role,
    privacy_admin: row.privacy_admin,
    is_active: row.is_active,
    permission_version: row.permission_version,
  });
};

const LIST_SQL = `SELECT staff.id::text AS staff_id, staff.username, staff.display_name,
                          role.role, role.is_privacy_admin AS privacy_admin,
                          (staff.is_active AND role.is_active) AS is_active,
                          staff.permission_version
                     FROM staff_store_roles role
                     JOIN staffs staff
                       ON staff.org_id = role.org_id
                      AND staff.id = role.staff_id
                    WHERE role.org_id = $1::uuid
                      AND role.store_id = $2::uuid
                    ORDER BY staff.username, staff.id`;

async function revokeTargetSessions(
  client: SqlClient,
  tenant: TenantContext,
  staffId: string,
): Promise<void> {
  await client.query(
    `WITH revoked_sessions AS (
       UPDATE sessions
          SET status = 'revoked', session_version = session_version + 1, revoked_at = NOW()
        WHERE org_id = $1::uuid AND store_id = $2::uuid
          AND staff_id = $3::uuid AND status = 'active'
       RETURNING id
     ), revoked_families AS (
       UPDATE refresh_families
          SET status = 'revoked', revoked_at = NOW()
        WHERE status = 'active' AND session_id IN (SELECT id FROM revoked_sessions)
       RETURNING id
     )
     UPDATE refresh_tokens
        SET status = 'revoked', revoked_at = NOW()
      WHERE status = 'active' AND family_id IN (SELECT id FROM revoked_families)`,
    [tenant.orgId, tenant.storeId, staffId],
  );
}

async function countOtherAuthorities(
  client: SqlClient,
  tenant: TenantContext,
  targetStaffId: string,
): Promise<Readonly<{ admins: number; privacyAdmins: number }>> {
  const result = await client.query<{ admins: string; privacy_admins: string }>(
    `SELECT count(*) FILTER (WHERE role.role = 'admin')::text AS admins,
            count(*) FILTER (WHERE role.is_privacy_admin)::text AS privacy_admins
       FROM staff_store_roles role
       JOIN staffs staff ON staff.org_id = role.org_id AND staff.id = role.staff_id
      WHERE role.org_id = $1::uuid AND role.store_id = $2::uuid
        AND role.staff_id <> $3::uuid AND role.is_active AND staff.is_active`,
    [tenant.orgId, tenant.storeId, targetStaffId],
  );
  return Object.freeze({
    admins: Number(result.rows[0]?.admins ?? "0"),
    privacyAdmins: Number(result.rows[0]?.privacy_admins ?? "0"),
  });
}

export function createSqlStaffAccessStore(
  client: SqlClient,
  tenant: TenantContext,
): StaffAccessStore {
  const list = async (): Promise<readonly StaffAccessRow[]> => {
    const result = await client.query<StaffAccessDbRow>(LIST_SQL, [tenant.orgId, tenant.storeId]);
    return Object.freeze(result.rows.map(freezeRow));
  };

  return Object.freeze({
    list,
    set: async (actorStaffId, change) => {
      if (actorStaffId === change.target_staff_id) {
        return Object.freeze({ ok: false as const, reason: "self_change" as const });
      }
      await client.query(
        `SELECT role.staff_id
           FROM staff_store_roles role
          WHERE role.org_id = $1::uuid AND role.store_id = $2::uuid
          FOR UPDATE`,
        [tenant.orgId, tenant.storeId],
      );
      const before = (await list()).find((row) => row.staff_id === change.target_staff_id);
      if (before === undefined) {
        return Object.freeze({ ok: false as const, reason: "not_found" as const });
      }
      if (before.permission_version !== change.expected_permission_version) {
        return Object.freeze({ ok: false as const, reason: "stale" as const });
      }
      const other = await countOtherAuthorities(client, tenant, change.target_staff_id);
      if (
        before.is_active &&
        before.role === "admin" &&
        (!change.is_active || change.role !== "admin")
      ) {
        if (other.admins < 1) {
          return Object.freeze({ ok: false as const, reason: "last_admin" as const });
        }
      }
      if (
        before.is_active &&
        before.privacy_admin &&
        (!change.is_active || !change.privacy_admin)
      ) {
        if (other.privacyAdmins < 1) {
          return Object.freeze({ ok: false as const, reason: "last_privacy_admin" as const });
        }
      }
      const staffUpdate = await client.query(
        `UPDATE staffs
            SET is_active = $4, permission_version = permission_version + 1, updated_at = NOW()
          WHERE org_id = $1::uuid AND id = $2::uuid AND permission_version = $3`,
        [
          tenant.orgId,
          change.target_staff_id,
          change.expected_permission_version,
          change.is_active,
        ],
      );
      if (staffUpdate.rowCount !== 1) {
        return Object.freeze({ ok: false as const, reason: "stale" as const });
      }
      const roleUpdate = await client.query(
        `UPDATE staff_store_roles
            SET role = $4, is_privacy_admin = $5, is_active = $6, updated_at = NOW()
          WHERE org_id = $1::uuid AND store_id = $2::uuid AND staff_id = $3::uuid`,
        [
          tenant.orgId,
          tenant.storeId,
          change.target_staff_id,
          change.role,
          change.privacy_admin,
          change.is_active,
        ],
      );
      if (roleUpdate.rowCount !== 1) {
        throw new Error("Staff access role row disappeared during update");
      }
      await revokeTargetSessions(client, tenant, change.target_staff_id);
      const after = (await list()).find((row) => row.staff_id === change.target_staff_id);
      if (after === undefined) throw new Error("Updated staff access row disappeared");
      return Object.freeze({ ok: true as const, before, after });
    },
  });
}

export function createMemoryStaffAccessStore(seed: readonly StaffAccessRow[]): StaffAccessStore {
  let rows = Object.freeze(seed.map((row) => Object.freeze({ ...row })));
  return Object.freeze({
    list: async () => rows,
    set: async (actorStaffId, change) => {
      if (actorStaffId === change.target_staff_id) {
        return Object.freeze({ ok: false as const, reason: "self_change" as const });
      }
      const before = rows.find((row) => row.staff_id === change.target_staff_id);
      if (before === undefined) {
        return Object.freeze({ ok: false as const, reason: "not_found" as const });
      }
      if (before.permission_version !== change.expected_permission_version) {
        return Object.freeze({ ok: false as const, reason: "stale" as const });
      }
      const other = rows.filter((row) => row.staff_id !== change.target_staff_id && row.is_active);
      if (
        before.is_active &&
        before.role === "admin" &&
        (!change.is_active || change.role !== "admin") &&
        !other.some((row) => row.role === "admin")
      ) {
        return Object.freeze({ ok: false as const, reason: "last_admin" as const });
      }
      if (
        before.is_active &&
        before.privacy_admin &&
        (!change.is_active || !change.privacy_admin) &&
        !other.some((row) => row.privacy_admin)
      ) {
        return Object.freeze({ ok: false as const, reason: "last_privacy_admin" as const });
      }
      const after = Object.freeze({
        ...before,
        role: change.role,
        privacy_admin: change.privacy_admin,
        is_active: change.is_active,
        permission_version: before.permission_version + 1,
      });
      rows = Object.freeze(rows.map((row) => (row.staff_id === after.staff_id ? after : row)));
      return Object.freeze({ ok: true as const, before, after });
    },
  });
}
