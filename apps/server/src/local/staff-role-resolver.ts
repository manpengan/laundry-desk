import type { PgPool } from "../db/pg-pool.js";
import { LOCAL_MEMORY_STAFF_DIRECTORY, type LocalStaffDirectoryEntry } from "./staff-directory.js";
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

export function createPgStaffRoleResolver(
  pool: PgPool,
  loadDirectory: (pool: PgPool) => Promise<readonly LocalStaffDirectoryEntry[]>,
): StaffRoleResolver {
  return async (orgId, storeId, staffId) => {
    if (orgId !== LOCAL_PROFILE.orgId || storeId !== LOCAL_PROFILE.storeId) return null;
    const directory = await loadDirectory(pool);
    return directory.find((entry) => entry.staff_id === staffId)?.role ?? null;
  };
}
