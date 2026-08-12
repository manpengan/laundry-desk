import type { PgPool } from "../db/pg-pool.js";
import type { StaffRepository } from "../identity/types.js";
import type { StaffAccessStore } from "../staff/access-store.js";
import {
  LOCAL_MEMORY_STAFF_DIRECTORY,
  type LocalStaffDirectoryEntry,
  type StaffDirectoryScope,
} from "./staff-directory.js";
import { LOCAL_PROFILE } from "./profile.js";

export type StaffRoleResolver = (
  orgId: string,
  storeId: string,
  staffId: string,
) => Promise<"admin" | "staff" | null>;

export const resolveMemoryStaffRole: StaffRoleResolver = async (orgId, storeId, staffId) => {
  if (orgId !== LOCAL_PROFILE.orgId || storeId !== LOCAL_PROFILE.storeId) return null;
  return LOCAL_MEMORY_STAFF_DIRECTORY.find((entry) => entry.staff_id === staffId)?.role ?? null;
};

export function createMemoryStaffRoleResolver(
  access: StaffAccessStore,
  staff: StaffRepository,
): StaffRoleResolver {
  return async (orgId, storeId, staffId) => {
    if (orgId !== LOCAL_PROFILE.orgId || storeId !== LOCAL_PROFILE.storeId) return null;
    const [identity, rows] = await Promise.all([staff.findById(orgId, staffId), access.list()]);
    const authority = rows.find((row) => row.staff_id === staffId);
    if (identity?.is_active !== true || authority?.is_active !== true) return null;
    return authority.role;
  };
}

export function createPgStaffRoleResolver(
  pool: PgPool,
  loadDirectory: (
    pool: PgPool,
    scope?: StaffDirectoryScope,
  ) => Promise<readonly LocalStaffDirectoryEntry[]>,
): StaffRoleResolver {
  return async (orgId, storeId, staffId) => {
    const directory = await loadDirectory(pool, Object.freeze({ orgId, storeId, staffId }));
    return directory.find((entry) => entry.staff_id === staffId)?.role ?? null;
  };
}
