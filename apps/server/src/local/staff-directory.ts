/** Query and validate the local runtime's active in-store staff directory. */

import { z } from "zod";

import type { PgPool } from "../db/pg-pool.js";
import { withStoreGuc } from "../db/tenant-guc-client.js";
import { DEMO_STAFF_A_ID, DEMO_STAFF_B_ID } from "./demo-ids.js";
import { LOCAL_PROFILE } from "./profile.js";

export type LocalStaffDirectoryEntry = Readonly<{
  staff_id: string;
  display_name: string;
  role: "admin" | "staff";
  username: string;
  privacy_admin: boolean;
}>;

type PgStaffDirectoryRow = Readonly<{
  staff_id: string;
  display_name: string;
  role: string;
  username: string;
  privacy_admin: boolean;
}>;

export const LOCAL_MEMORY_STAFF_DIRECTORY: readonly LocalStaffDirectoryEntry[] = Object.freeze([
  Object.freeze({
    staff_id: DEMO_STAFF_A_ID,
    display_name: "店员甲",
    role: "staff",
    username: "staff",
    privacy_admin: false,
  }),
  Object.freeze({
    staff_id: DEMO_STAFF_B_ID,
    display_name: "店员乙",
    role: "staff",
    username: "staffb",
    privacy_admin: false,
  }),
  Object.freeze({
    staff_id: LOCAL_PROFILE.adminStaffId,
    display_name: "店长",
    role: "admin",
    username: "admin",
    privacy_admin: true,
  }),
]);

const PgStaffDirectoryRowSchema = z
  .object({
    staff_id: z.uuid(),
    display_name: z.string().trim().min(1),
    role: z.enum(["admin", "staff"]),
    username: z.string().trim().min(1),
    privacy_admin: z.boolean(),
  })
  .strict()
  .readonly();

export async function loadPgStaffDirectory(
  pool: PgPool,
): Promise<readonly LocalStaffDirectoryEntry[]> {
  const rows = await withStoreGuc(
    pool,
    {
      orgId: LOCAL_PROFILE.orgId,
      storeId: LOCAL_PROFILE.storeId,
      staffId: LOCAL_PROFILE.adminStaffId,
    },
    async (client) => {
      const result = await client.query<PgStaffDirectoryRow>(
        `SELECT staff.id::text AS staff_id, staff.display_name, role.role, staff.username,
                role.is_privacy_admin AS privacy_admin
           FROM staffs staff
           JOIN staff_store_roles role
             ON role.org_id = staff.org_id
            AND role.staff_id = staff.id
          WHERE staff.org_id = $1::uuid
            AND role.store_id = $2::uuid
            AND staff.is_active = true
            AND role.is_active = true
          ORDER BY staff.username, staff.id`,
        [LOCAL_PROFILE.orgId, LOCAL_PROFILE.storeId],
      );
      return result.rows.map((row) => PgStaffDirectoryRowSchema.parse(row));
    },
  );
  return rows;
}
