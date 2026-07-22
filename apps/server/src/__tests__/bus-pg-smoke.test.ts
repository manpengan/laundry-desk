/**
 * Bus + real Postgres smoke: platform.settings.set under laundry_app + GUC.
 * Opt-in: LAUNDRY_USE_LOCAL_PG=1 (CI skips — no compose).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { executeCommand } from "../bus/executor.js";
import type { ActorContext } from "../bus/types.js";
import { createPgPool, resolvePgUrls } from "../db/pg-pool.js";
import { withPoolClient } from "../db/pg-sql-client.js";
import type { TenantContext } from "../db/types.js";
import { createRegisteredM1Bus } from "../handlers/register-m1.js";
import { seedDemoIdentity } from "../local/pg-seed.js";
import { DEMO_ADMIN_ID, DEMO_ORG_ID, DEMO_STORE_ID } from "../local/demo-ids.js";

const urls =
  process.env.LAUNDRY_USE_LOCAL_PG === "1" || process.env.LAUNDRY_USE_LOCAL_PG === "true"
    ? resolvePgUrls(process.env)
    : null;

const maybe = urls === null ? test.skip : test;

const TENANT: TenantContext = Object.freeze({
  orgId: DEMO_ORG_ID,
  storeId: DEMO_STORE_ID,
  staffId: DEMO_ADMIN_ID,
});

const ACTOR: ActorContext = Object.freeze({
  staffId: DEMO_ADMIN_ID,
  deviceId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  via: "ui" as const,
  permissions: Object.freeze(["settings_admin", "staff_read", "staff_write"]),
});

maybe("platform.settings.set persists settings + audit_log under laundry_app", async () => {
  assert.ok(urls);
  const adminPool = createPgPool({ connectionString: urls.admin });
  const appPool = createPgPool({ connectionString: urls.app });
  try {
    await seedDemoIdentity(adminPool);

    const { registry, chainHooks } = createRegisteredM1Bus({
      platform: Object.freeze({
        persistence: "sql" as const,
        // Placeholders — sql mode rebinds from ctx.client inside handlers.
        settings: {
          getMany: async () => Object.freeze({}),
          setMany: async () => undefined,
        },
        features: {
          get: async () =>
            Object.freeze({
              fulfillment: true,
              membership: false,
              shift_closing: false,
              delivery: false,
              marketing: false,
              ai: false,
            }),
        },
        audit: { list: async () => Object.freeze([]) },
      }),
    });

    const key = `smoke.bus.min_order_cents`;
    const value = JSON.stringify(2500);

    const result = await withPoolClient(appPool, async (sql) =>
      executeCommand(
        sql,
        TENANT,
        "platform.settings.set",
        { entries: [{ key, value_json: value }] },
        {
          registry,
          actor: ACTOR,
          chainHooks,
        },
      ),
    );

    assert.equal(result.ok, true, JSON.stringify(result));
    if (result.ok) {
      assert.equal(result.data.execution, "executed");
    }

    // Verify rows via app role + GUC (not superuser bypass).
    await withPoolClient(appPool, async (sql) => {
      await sql.query("BEGIN");
      await sql.query(`SELECT set_config('app.org_id', $1, true)`, [TENANT.orgId]);
      await sql.query(`SELECT set_config('app.store_id', $1, true)`, [TENANT.storeId]);
      await sql.query(`SELECT set_config('app.staff_id', $1, true)`, [TENANT.staffId]);

      const settings = await sql.query<{ key: string; value_json: string }>(
        `SELECT key, value_json FROM settings WHERE org_id = $1 AND key = $2`,
        [TENANT.orgId, key],
      );
      assert.equal(settings.rows.length, 1);
      assert.equal(settings.rows[0]?.value_json, value);

      const audits = await sql.query<{ command: string; entity: string | null }>(
        `SELECT command, entity FROM audit_log
          WHERE org_id = $1 AND store_id = $2 AND command = 'platform.settings.set'
          ORDER BY at DESC LIMIT 1`,
        [TENANT.orgId, TENANT.storeId],
      );
      assert.equal(audits.rows.length, 1);
      assert.equal(audits.rows[0]?.entity, "settings");

      await sql.query("COMMIT");
    });
  } finally {
    await adminPool.end();
    await appPool.end();
  }
});
