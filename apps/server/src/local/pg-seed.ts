/**
 * Seed demo org/store/staff into formal packages/db tables (LOCAL ONLY).
 * Idempotent on fixed demo UUIDs — safe to re-run against compose Postgres.
 */

import type { PgPool } from "../db/pg-pool.js";
import { DEMO_PASSWORD, DEMO_PIN, DEMO_STAFF_A_ID, DEMO_STAFF_B_ID } from "./demo-ids.js";
import { createPasswordPort } from "../identity/password.js";
import { LOCAL_PROFILE } from "./profile.js";

export type SeedDemoResult = Readonly<{
  org_id: string;
  store_id: string;
  staff_ids: readonly string[];
}>;

/**
 * Upsert the local profile + admin/staff/staffb with demo password/PIN hashes.
 * Call with admin/superuser URL so FORCE RLS does not block bootstrap.
 */
export async function seedDemoIdentity(pool: PgPool): Promise<SeedDemoResult> {
  const passwordPort = createPasswordPort();
  const passwordHash = await passwordPort.hashPassword(DEMO_PASSWORD);
  const pinHash = await passwordPort.hashPassword(DEMO_PIN);
  const now = new Date();

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `INSERT INTO orgs (id, code, name, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $4)
       ON CONFLICT (id) DO UPDATE SET code = EXCLUDED.code, name = EXCLUDED.name,
         updated_at = EXCLUDED.updated_at`,
      [LOCAL_PROFILE.orgId, LOCAL_PROFILE.orgCode, LOCAL_PROFILE.orgName, now],
    );

    await client.query(
      `INSERT INTO stores (id, org_id, code, name, timezone, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6)
       ON CONFLICT (id) DO UPDATE SET code = EXCLUDED.code, name = EXCLUDED.name,
         updated_at = EXCLUDED.updated_at`,
      [
        LOCAL_PROFILE.storeId,
        LOCAL_PROFILE.orgId,
        LOCAL_PROFILE.storeCode,
        LOCAL_PROFILE.storeName,
        LOCAL_PROFILE.timezone,
        now,
      ],
    );

    const staffRows: ReadonlyArray<Readonly<{ id: string; username: string; name: string }>> = [
      { id: LOCAL_PROFILE.adminStaffId, username: "admin", name: "店长" },
      { id: DEMO_STAFF_A_ID, username: "staff", name: "店员甲" },
      { id: DEMO_STAFF_B_ID, username: "staffb", name: "店员乙" },
    ];

    for (const row of staffRows) {
      await client.query(
        `INSERT INTO staffs (
           id, org_id, username, password_hash, pin_hash, display_name,
           is_active, permission_version, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,true,1,$7,$7)
         ON CONFLICT (id) DO UPDATE SET
           username = EXCLUDED.username,
           password_hash = EXCLUDED.password_hash,
           pin_hash = EXCLUDED.pin_hash,
           display_name = EXCLUDED.display_name,
           is_active = true,
           updated_at = EXCLUDED.updated_at`,
        [row.id, LOCAL_PROFILE.orgId, row.username, passwordHash, pinHash, row.name, now],
      );

      // Deterministic role row id derived from staff id last segment
      const roleUuid = `55555555-5555-4555-8555-${row.id.slice(-12)}`;
      await client.query(
        `INSERT INTO staff_store_roles (
           id, org_id, store_id, staff_id, role, is_active, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,true,$6,$6)
         ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, is_active = true,
           updated_at = EXCLUDED.updated_at`,
        [
          roleUuid,
          LOCAL_PROFILE.orgId,
          LOCAL_PROFILE.storeId,
          row.id,
          row.username === "admin" ? "admin" : "staff",
          now,
        ],
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // prefer original
    }
    throw error;
  } finally {
    client.release();
  }

  return Object.freeze({
    org_id: LOCAL_PROFILE.orgId,
    store_id: LOCAL_PROFILE.storeId,
    staff_ids: Object.freeze([LOCAL_PROFILE.adminStaffId, DEMO_STAFF_A_ID, DEMO_STAFF_B_ID]),
  });
}
