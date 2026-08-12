import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import {
  BOOTSTRAP_APPROVER_ROLE_ID,
  BOOTSTRAP_APPROVER_STAFF_ID,
  BOOTSTRAP_COMMISSION_AUDIT_ID,
  BOOTSTRAP_FEATURE_ROW_ID,
  LOCAL_FEATURE_PROFILE_VERSION,
  assertLocalCommissionedReady,
  commissionLocalIdentity,
  localRuntimeCommissioningState,
} from "../../apps/server/dist/local/bootstrap.js";
import { createPgPool } from "../../apps/server/dist/db/pg-pool.js";
import { createPasswordPort } from "../../apps/server/dist/identity/password.js";
import { LOCAL_PROFILE } from "../../apps/server/dist/local/profile.js";
import {
  applyRuntimeMigrations,
  loadMigrationBundle,
} from "../../apps/server/dist/runtime/migration-bundle.js";
import { loadLocalConfig } from "./config.mjs";

const required = (name) => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error("COMMISSIONING_INPUT_REQUIRED");
  return value;
};

const project = required("COMPOSE_PROJECT_NAME");
if (
  process.env.LAUNDRY_COMMISSIONING_ACCEPTANCE_ISOLATED !== "1" ||
  !/^laundry-commission-pg-[a-z0-9]+$/u.test(project)
) {
  throw new Error("COMMISSIONING_ISOLATED_VOLUME_REQUIRED");
}

const config = await loadLocalConfig({ env: process.env });
const databaseUrl = (username, password) => {
  const url = new URL("postgresql://127.0.0.1:8543/laundry_v2");
  url.username = username;
  url.password = password;
  return url.toString();
};
const adminPool = createPgPool({
  connectionString: databaseUrl("postgres", config.postgresSuperuserPassword),
  max: 1,
});
const appPool = createPgPool({
  connectionString: databaseUrl("laundry_app", config.postgresAppPassword),
  max: 1,
});

const restorePreCommissioningMigration = async () => {
  const client = await adminPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE laundry_owner");
    const metadata = await client.query(
      `UPDATE local_bootstrap_metadata
          SET approver_staff_id = NULL, commissioned_at = NULL, feature_profile_version = 0
        WHERE singleton = true
          AND approver_staff_id = $1::uuid
          AND commissioned_at IS NOT NULL
          AND feature_profile_version = $2`,
      [BOOTSTRAP_APPROVER_STAFF_ID, LOCAL_FEATURE_PROFILE_VERSION],
    );
    assert.equal(metadata.rowCount, 1);
    await client.query("DELETE FROM audit_log WHERE id = $1::uuid", [
      BOOTSTRAP_COMMISSION_AUDIT_ID,
    ]);
    await client.query("DELETE FROM store_features WHERE id = $1::uuid", [
      BOOTSTRAP_FEATURE_ROW_ID,
    ]);
    await client.query("DELETE FROM staff_store_roles WHERE id = $1::uuid", [
      BOOTSTRAP_APPROVER_ROLE_ID,
    ]);
    await client.query("DELETE FROM staffs WHERE id = $1::uuid", [BOOTSTRAP_APPROVER_STAFF_ID]);
    await client.query(
      `DROP FUNCTION public.laundry_local_commissioning_state(
        uuid, uuid, uuid, text, boolean, uuid, uuid, uuid, uuid, integer
      )`,
    );
    await client.query("DROP TABLE public.staff_credential_setups");
    await client.query(`ALTER TABLE public.local_bootstrap_metadata
      DROP CONSTRAINT local_bootstrap_metadata_approver_staff_fk,
      DROP CONSTRAINT local_bootstrap_metadata_commissioned_chk,
      DROP CONSTRAINT local_bootstrap_metadata_feature_profile_version_chk,
      DROP CONSTRAINT local_bootstrap_metadata_distinct_approver_chk,
      DROP COLUMN approver_staff_id,
      DROP COLUMN commissioned_at,
      DROP COLUMN feature_profile_version`);
    await client.query("RESET ROLE");
    const ledger = await client.query(
      "DELETE FROM public.laundry_schema_migrations WHERE filename = $1",
      ["0045_store_commissioning_staff_credentials.sql"],
    );
    assert.equal(ledger.rowCount, 1);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

const migrateLegacyVolume = async () => {
  const migrations = await loadMigrationBundle(
    fileURLToPath(new URL("../../packages/db/src/migrations/", import.meta.url)),
  );
  assert.equal(migrations.head, "0059_marketing_campaigns.sql");
  await applyRuntimeMigrations(adminPool, migrations);
  const result = await adminPool.query(
    "SELECT count(*)::integer AS count FROM laundry_schema_migrations WHERE filename = $1",
    [migrations.head],
  );
  assert.equal(result.rows[0]?.count, 1);
};

try {
  await assertLocalCommissionedReady(appPool);
  await restorePreCommissioningMigration();
  await migrateLegacyVolume();
  assert.equal(await localRuntimeCommissioningState(appPool), "commission_required");
  await assert.rejects(() => assertLocalCommissionedReady(appPool), /LOCAL_RUNTIME_NOT_READY/u);

  const result = await commissionLocalIdentity(
    { pool: adminPool, passwordPort: createPasswordPort() },
    {
      profile: LOCAL_PROFILE,
      approverUsername: required("LAUNDRY_BOOTSTRAP_APPROVER_USERNAME"),
      approverDisplayName: required("LAUNDRY_BOOTSTRAP_APPROVER_DISPLAY_NAME"),
      approverPassword: required("LAUNDRY_BOOTSTRAP_APPROVER_PASSWORD"),
      approverPin: required("LAUNDRY_BOOTSTRAP_APPROVER_PIN"),
    },
  );
  assert.equal(result.status, "commissioned");
  assert.equal(await localRuntimeCommissioningState(appPool), "commissioned");
  await assertLocalCommissionedReady(appPool);

  const proof = await adminPool.query(
    `SELECT metadata.approver_staff_id::text, metadata.commissioned_at,
            metadata.feature_profile_version, features.fulfillment, features.membership,
            features.shift_closing, features.delivery, features.marketing, features.ai,
            audit.via, audit.command, audit.entity, audit.before_json, audit.after_json
       FROM local_bootstrap_metadata metadata
       JOIN store_features features ON features.id = $1::uuid
       JOIN audit_log audit ON audit.id = $2::uuid
      WHERE metadata.singleton = true`,
    [BOOTSTRAP_FEATURE_ROW_ID, BOOTSTRAP_COMMISSION_AUDIT_ID],
  );
  const row = proof.rows[0];
  assert.ok(row);
  assert.equal(row.approver_staff_id, BOOTSTRAP_APPROVER_STAFF_ID);
  assert.ok(row.commissioned_at instanceof Date);
  assert.equal(row.feature_profile_version, LOCAL_FEATURE_PROFILE_VERSION);
  assert.deepEqual(
    [row.fulfillment, row.membership, row.shift_closing, row.delivery, row.marketing, row.ai],
    [true, true, true, false, false, false],
  );
  assert.deepEqual(
    [row.via, row.command, row.entity],
    ["runtime", "local.commissioning.complete", "local_commissioning"],
  );
  assert.deepEqual(JSON.parse(row.before_json), {
    commissioned: false,
    active_admin_count: 1,
    feature_profile_version: 0,
  });
  assert.deepEqual(JSON.parse(row.after_json), {
    commissioned: true,
    active_admin_count: 2,
    feature_profile_version: LOCAL_FEATURE_PROFILE_VERSION,
  });
  for (const secret of [
    required("LAUNDRY_BOOTSTRAP_APPROVER_PASSWORD"),
    required("LAUNDRY_BOOTSTRAP_APPROVER_PIN"),
  ]) {
    assert.equal(JSON.stringify(row).includes(secret), false);
  }
  process.stdout.write("LOCAL_COMMISSIONING_PG_ACCEPTANCE_OK state=commissioned\n");
} finally {
  await Promise.allSettled([adminPool.end(), appPool.end()]);
}
