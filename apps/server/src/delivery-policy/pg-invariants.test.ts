import assert from "node:assert/strict";
import test from "node:test";

import { createPgPool, resolvePgUrls, type PgPool } from "../db/pg-pool.js";
import { withPoolClient } from "../db/pg-sql-client.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import type { SqlClient, TenantContext } from "../db/types.js";
import { DEMO_ADMIN_ID, DEMO_ORG_ID, DEMO_STAFF_A_ID, DEMO_STORE_ID } from "../local/demo-ids.js";

const pgUrls =
  process.env.LAUNDRY_USE_LOCAL_PG === "1" || process.env.LAUNDRY_USE_LOCAL_PG === "true"
    ? resolvePgUrls(process.env)
    : null;

const TENANT: TenantContext = Object.freeze({
  orgId: DEMO_ORG_ID,
  storeId: DEMO_STORE_ID,
  staffId: DEMO_ADMIN_ID,
});

const withAppTransaction = <T>(
  pool: PgPool,
  operation: (client: SqlClient) => Promise<T>,
): Promise<T> => withPoolClient(pool, (client) => withTenantTransaction(client, TENANT, operation));

function rejectsWith(code: string, message: RegExp) {
  return (error: unknown): boolean => {
    const pgError = error as Readonly<{ code?: unknown; message?: unknown }>;
    assert.equal(pgError.code, code);
    assert.match(String(pgError.message), message);
    return true;
  };
}

async function deletePolicy(pool: PgPool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE laundry_owner");
    await client.query("DELETE FROM delivery_policies WHERE org_id = $1 AND store_id = $2", [
      DEMO_ORG_ID,
      DEMO_STORE_ID,
    ]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

test(
  "real PostgreSQL delivery policy rejects malformed app writes and owns version metadata",
  { skip: pgUrls === null },
  async () => {
    assert.ok(pgUrls);
    const adminPool = createPgPool({ connectionString: pgUrls.admin });
    const appPool = createPgPool({ connectionString: pgUrls.app });
    const validAreas = [{ code: "north", name: "北区", fee_cents: 800, is_active: true }];
    const validWindows = [{ weekday: 1, start_minute: 540, end_minute: 1_020 }];
    try {
      await deletePolicy(adminPool);
      const inserted = await withAppTransaction(appPool, (client) =>
        client.query<Readonly<{ version: number; updated_at: Date }>>(
          `INSERT INTO delivery_policies (
             org_id, store_id, accepting_appointments, minimum_lead_minutes,
             maximum_advance_days, slot_minutes, max_appointments_per_slot,
             service_areas_json, weekly_windows_json, version, updated_at, updated_by_staff_id
           ) VALUES ($1,$2,true,120,14,60,3,$3::jsonb,$4::jsonb,1,'2000-01-01',$5)
           RETURNING version, updated_at`,
          [
            DEMO_ORG_ID,
            DEMO_STORE_ID,
            JSON.stringify(validAreas),
            JSON.stringify(validWindows),
            DEMO_ADMIN_ID,
          ],
        ),
      );
      assert.equal(inserted.rows[0]?.version, 1);
      assert.ok((inserted.rows[0]?.updated_at.getTime() ?? 0) > Date.parse("2000-01-01"));

      await assert.rejects(
        () =>
          withAppTransaction(appPool, (client) =>
            client.query(
              `UPDATE delivery_policies
                  SET service_areas_json = $3::jsonb, version = 2,
                      updated_by_staff_id = $4
                WHERE org_id = $1 AND store_id = $2`,
              [
                DEMO_ORG_ID,
                DEMO_STORE_ID,
                JSON.stringify([{ ...validAreas[0], bogus: true }]),
                DEMO_ADMIN_ID,
              ],
            ),
          ),
        rejectsWith("23514", /delivery_policies_service_areas_json_chk/u),
      );
      await assert.rejects(
        () =>
          withAppTransaction(appPool, (client) =>
            client.query(
              `UPDATE delivery_policies SET version = 3, updated_by_staff_id = $3
                WHERE org_id = $1 AND store_id = $2`,
              [DEMO_ORG_ID, DEMO_STORE_ID, DEMO_ADMIN_ID],
            ),
          ),
        rejectsWith("23514", /version must advance by one/u),
      );
      await assert.rejects(
        () =>
          withAppTransaction(appPool, (client) =>
            client.query(
              `UPDATE delivery_policies SET version = 2, updated_by_staff_id = $3
                WHERE org_id = $1 AND store_id = $2`,
              [DEMO_ORG_ID, DEMO_STORE_ID, DEMO_STAFF_A_ID],
            ),
          ),
        rejectsWith("42501", /actor unavailable/u),
      );
    } finally {
      await deletePolicy(adminPool);
      await appPool.end();
      await adminPool.end();
    }
  },
);
