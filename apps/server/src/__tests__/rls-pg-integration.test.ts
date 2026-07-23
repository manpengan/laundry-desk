/** Real PG RLS, pooled-session and transaction/audit integration gate. */

import assert from "node:assert/strict";
import test from "node:test";

import { createM1CommandRegistry } from "../bus/registry.js";
import { executeCommand } from "../bus/executor.js";
import type { ActorContext } from "../bus/types.js";
import { withPoolClient } from "../db/pg-sql-client.js";
import { createPgPool, type PgPool, resolvePgUrls } from "../db/pg-pool.js";
import { TenantGucError } from "../db/guc.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import type { TenantContext } from "../db/types.js";
import { withWorkerTenantTransaction } from "../db/worker-transaction.js";
import { seedDemoIdentity } from "../local/pg-seed.js";
import { DEMO_ADMIN_ID, DEMO_ORG_ID, DEMO_STAFF_A_ID, DEMO_STORE_ID } from "../local/demo-ids.js";

const urls =
  process.env.LAUNDRY_USE_LOCAL_PG === "1" || process.env.LAUNDRY_USE_LOCAL_PG === "true"
    ? resolvePgUrls(process.env)
    : null;

const OTHER_ORG = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER_STORE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const OTHER_STAFF = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const SETTING_ID = "99999999-9999-4999-8999-999999999901";
const AUDIT_ID = "99999999-9999-4999-8999-999999999902";
const TRIGGER_NAME = "v2_integration_audit_failure";
const FUNCTION_NAME = "v2_integration_fail_audit";

const TENANT: TenantContext = Object.freeze({
  orgId: DEMO_ORG_ID,
  storeId: DEMO_STORE_ID,
  staffId: DEMO_ADMIN_ID,
});

const ACTOR: ActorContext = Object.freeze({
  staffId: DEMO_ADMIN_ID,
  deviceId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  via: "ui",
});

async function seedOtherTenant(pool: PgPool): Promise<void> {
  await pool.query(
    `INSERT INTO orgs (id, code, name, created_at, updated_at)
     VALUES ($1, 'rls-integration', 'RLS Integration', now(), now())
     ON CONFLICT (id) DO UPDATE SET code = EXCLUDED.code, name = EXCLUDED.name, updated_at = EXCLUDED.updated_at`,
    [OTHER_ORG],
  );
  await pool.query(
    `INSERT INTO stores (id, org_id, code, name, timezone, created_at, updated_at)
     VALUES ($1, $2, 'rls', 'RLS Integration', 'Asia/Shanghai', now(), now())
     ON CONFLICT (id) DO UPDATE SET code = EXCLUDED.code, name = EXCLUDED.name, updated_at = EXCLUDED.updated_at`,
    [OTHER_STORE, OTHER_ORG],
  );
  await pool.query(
    `INSERT INTO staffs (
       id, org_id, username, password_hash, display_name, is_active,
       permission_version, created_at, updated_at
     ) VALUES ($1, $2, 'rls-integration', 'not-a-real-hash', 'RLS Integration', true, 1, now(), now())
     ON CONFLICT (id) DO UPDATE SET username = EXCLUDED.username, updated_at = EXCLUDED.updated_at`,
    [OTHER_STAFF, OTHER_ORG],
  );
}

async function countStaff(pool: PgPool, orgId: string, staffId: string): Promise<number> {
  return withPoolClient(pool, async (sql) =>
    withTenantTransaction(
      sql,
      { orgId, storeId: orgId === DEMO_ORG_ID ? DEMO_STORE_ID : OTHER_STORE, staffId },
      async (tx) => {
        const result = await tx.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM staffs WHERE id = $1::uuid",
          [staffId],
        );
        return Number(result.rows[0]?.count ?? "0");
      },
    ),
  );
}

async function countWithoutGuc(pool: PgPool): Promise<number> {
  const result = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM staffs");
  return Number(result.rows[0]?.count ?? "0");
}

async function installAuditFailureTrigger(pool: PgPool): Promise<void> {
  await pool.query(`DROP TRIGGER IF EXISTS ${TRIGGER_NAME} ON audit_log`);
  await pool.query(`
    CREATE OR REPLACE FUNCTION ${FUNCTION_NAME}()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW.command = 'identity.logout' AND NEW.entity_id = '${SETTING_ID}' THEN
        RAISE EXCEPTION 'forced audit failure';
      END IF;
      RETURN NEW;
    END;
    $$
  `);
  await pool.query(
    `CREATE TRIGGER ${TRIGGER_NAME}
     BEFORE INSERT ON audit_log
     FOR EACH ROW EXECUTE FUNCTION ${FUNCTION_NAME}()`,
  );
}

async function removeAuditFailureTrigger(pool: PgPool): Promise<void> {
  await pool.query(`DROP TRIGGER IF EXISTS ${TRIGGER_NAME} ON audit_log`);
  await pool.query(`DROP FUNCTION IF EXISTS ${FUNCTION_NAME}()`);
}

test(
  "real PG is default-closed and pooled tenant context never leaks",
  { skip: urls === null },
  async () => {
    assert.ok(urls);
    const adminPool = createPgPool({ connectionString: urls.admin });
    const appPool = createPgPool({ connectionString: urls.app, max: 1 });
    try {
      await seedDemoIdentity(adminPool);
      await seedOtherTenant(adminPool);

      assert.equal(await countWithoutGuc(appPool), 0);
      const emptyGuc = await withPoolClient(appPool, async (sql) => {
        await sql.query("BEGIN");
        try {
          await sql.query("SELECT set_config('app.org_id', '', true)");
          await sql.query("SELECT set_config('app.store_id', '', true)");
          const result = await sql.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM staffs",
          );
          await sql.query("COMMIT");
          return result;
        } catch (error) {
          await sql.query("ROLLBACK");
          throw error;
        }
      });
      assert.equal(Number(emptyGuc.rows[0]?.count ?? "0"), 0);

      assert.equal(await countStaff(appPool, DEMO_ORG_ID, DEMO_STAFF_A_ID), 1);
      assert.equal(await countStaff(appPool, OTHER_ORG, DEMO_STAFF_A_ID), 0);
      assert.equal(await countWithoutGuc(appPool), 0);

      await assert.rejects(
        () =>
          withPoolClient(appPool, async (sql) =>
            withTenantTransaction(sql, TENANT, async () => {
              throw new Error("force rollback");
            }),
          ),
        /force rollback/u,
      );
      assert.equal(await countWithoutGuc(appPool), 0);

      await assert.rejects(
        () =>
          withPoolClient(appPool, async (sql) =>
            withWorkerTenantTransaction(
              sql,
              { orgId: DEMO_ORG_ID, storeId: DEMO_STORE_ID },
              async () => 0,
            ),
          ),
        TenantGucError,
      );
      assert.equal(await countWithoutGuc(appPool), 0);

      await assert.rejects(
        () => appPool.query("SET row_security = off; SELECT count(*) FROM staffs"),
        /row-level security/u,
      );
    } finally {
      await appPool.end();
      await adminPool.end();
    }
  },
);

test(
  "real PG rolls back the business mutation when append-only audit insert fails",
  { skip: urls === null },
  async () => {
    assert.ok(urls);
    const adminPool = createPgPool({ connectionString: urls.admin });
    const appPool = createPgPool({ connectionString: urls.app, max: 1 });
    try {
      await seedDemoIdentity(adminPool);
      await installAuditFailureTrigger(adminPool);

      const registry = createM1CommandRegistry();
      registry.registerHandler("identity.logout", async ({ client }) => {
        await client.query(
          `INSERT INTO settings (id, org_id, key, value_json, updated_at, updated_by_staff_id)
           VALUES ($1::uuid, $2::uuid, 'audit.rollback.probe', '"must-not-commit"', now(), $3::uuid)`,
          [SETTING_ID, DEMO_ORG_ID, DEMO_ADMIN_ID],
        );
        return { result: Object.freeze({}), audit: { entity: "settings", entityId: SETTING_ID } };
      });

      const result = await withPoolClient(appPool, async (sql) =>
        executeCommand(
          sql,
          TENANT,
          "identity.logout",
          {},
          { registry, actor: ACTOR, newId: () => AUDIT_ID },
        ),
      );
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, "TRANSACTION_FAILED");

      const settings = await withPoolClient(appPool, async (sql) =>
        withTenantTransaction(sql, TENANT, (tx) =>
          tx.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM settings WHERE id = $1::uuid",
            [SETTING_ID],
          ),
        ),
      );
      assert.equal(Number(settings.rows[0]?.count ?? "0"), 0);
    } finally {
      await removeAuditFailureTrigger(adminPool);
      await appPool.end();
      await adminPool.end();
    }
  },
);
