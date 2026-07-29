/**
 * Seed fictional secondary staff for the real local Web acceptance.
 *
 * The production bootstrap intentionally creates only the administrator.
 * Quick-switch needs a second actor, so the browser suite installs a bounded,
 * idempotent fixture by copying the bootstrap administrator's password/PIN
 * hashes. No credential is logged or placed in SQL text.
 */
import { createRequire } from "node:module";

import { loadLocalConfig } from "../../../tools/local/config.mjs";

const requireFromServer = createRequire(new URL("../../server/package.json", import.meta.url));
const pg = requireFromServer("pg");

const ORG_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STORE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ADMIN_ID = "11111111-1111-4111-8111-111111111103";
const FIXTURE_STAFF = Object.freeze([
  Object.freeze({
    id: "11111111-1111-4111-8111-111111111101",
    roleId: "55555555-5555-4555-8555-111111111101",
    username: "e2e-staff-a",
    displayName: "E2E Staff One",
  }),
  Object.freeze({
    id: "11111111-1111-4111-8111-111111111102",
    roleId: "55555555-5555-4555-8555-111111111102",
    username: "e2e-staff-b",
    displayName: "E2E Staff Two",
  }),
]);

function adminDatabaseUrl(password) {
  const url = new URL("postgresql://127.0.0.1:8543/laundry_v2");
  url.username = "postgres";
  url.password = password;
  return url.toString();
}

async function seedStaff(client, staff) {
  await client.query(
    `INSERT INTO staffs (
       id, org_id, username, password_hash, pin_hash, display_name,
       is_active, permission_version, created_at, updated_at
     )
     SELECT $1::uuid, $2::uuid, $3, admin.password_hash, admin.pin_hash, $4,
            true, 1, now(), now()
       FROM staffs admin
      WHERE admin.id = $5::uuid
        AND admin.org_id = $2::uuid
        AND admin.password_hash IS NOT NULL
        AND admin.pin_hash IS NOT NULL
     ON CONFLICT (id) DO UPDATE SET
       username = EXCLUDED.username,
       password_hash = EXCLUDED.password_hash,
       pin_hash = EXCLUDED.pin_hash,
       display_name = EXCLUDED.display_name,
       is_active = true,
       updated_at = EXCLUDED.updated_at`,
    [staff.id, ORG_ID, staff.username, staff.displayName, ADMIN_ID],
  );
  await client.query(
    `INSERT INTO staff_store_roles (
       id, org_id, store_id, staff_id, role, is_active, created_at, updated_at
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'staff', true, now(), now())
     ON CONFLICT (id) DO UPDATE SET
       role = EXCLUDED.role,
       is_active = true,
       updated_at = EXCLUDED.updated_at`,
    [staff.roleId, ORG_ID, STORE_ID, staff.id],
  );
}

export default async function globalSetup() {
  const config = await loadLocalConfig();
  const pool = new pg.Pool({
    connectionString: adminDatabaseUrl(config.postgresSuperuserPassword),
    max: 1,
  });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE laundry_owner");
    for (const staff of FIXTURE_STAFF) {
      await seedStaff(client, staff);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}
