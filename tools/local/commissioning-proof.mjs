import assert from "node:assert/strict";

import {
  BOOTSTRAP_APPROVER_STAFF_ID,
  BOOTSTRAP_COMMISSION_AUDIT_ID,
  BOOTSTRAP_FEATURE_ROW_ID,
  LOCAL_FEATURE_PROFILE_VERSION,
  assertLocalCommissionedReady,
} from "../../apps/server/dist/local/bootstrap.js";
import { createPgPool } from "../../apps/server/dist/db/pg-pool.js";
import { loadLocalConfig } from "./config.mjs";

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

try {
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
  const audit = Object.freeze({
    before: JSON.parse(row.before_json),
    after: JSON.parse(row.after_json),
  });
  assert.deepEqual(audit.after, {
    commissioned: true,
    active_admin_count: 2,
    feature_profile_version: LOCAL_FEATURE_PROFILE_VERSION,
  });
  assert.equal(/password|pin|secret|token|credential/iu.test(JSON.stringify(audit)), false);
  process.stdout.write("LOCAL_COMMISSIONING_PROOF_OK state=commissioned admins=2\n");
} finally {
  await Promise.allSettled([adminPool.end(), appPool.end()]);
}
