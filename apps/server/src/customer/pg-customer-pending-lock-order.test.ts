import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { createPgPool, resolvePgUrls } from "../db/pg-pool.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import type { SqlClient, TenantContext } from "../db/types.js";
import { DEMO_ADMIN_ID, DEMO_ORG_ID, DEMO_STORE_ID } from "../local/demo-ids.js";
import { seedPgTestIdentityFixture } from "../local/pg-test-fixture.js";
import { hashCanonical } from "../pending-actions/canonical.js";
import { deferred, waitForLock } from "./pg-customer-privacy-test-support.js";

const urls =
  process.env.LAUNDRY_USE_LOCAL_PG === "1" || process.env.LAUNDRY_USE_LOCAL_PG === "true"
    ? resolvePgUrls(process.env)
    : null;

const TENANT: TenantContext = Object.freeze({
  orgId: DEMO_ORG_ID,
  storeId: DEMO_STORE_ID,
  staffId: DEMO_ADMIN_ID,
});

test(
  "pending privacy guard takes the phone advisory before the customer anchor",
  { skip: urls === null },
  async () => {
    assert.ok(urls);
    const adminPool = createPgPool({ connectionString: urls.admin });
    const appPool = createPgPool({ connectionString: urls.app, max: 2 });
    const updateClient = await appPool.connect();
    const pendingClient = await appPool.connect();
    const customerId = randomUUID();
    const pendingNonce = randomUUID();
    const idempotencyKey = randomUUID();
    const oldPhone = "13800008884";
    const newPhone = "13800008885";
    const phoneLocked = deferred();
    const allowUpdate = deferred();
    try {
      await seedPgTestIdentityFixture(adminPool);
      await adminPool.query(
        `INSERT INTO customers (id, org_id, phone, name, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, 'Pending lock order', now(), now())`,
        [customerId, DEMO_ORG_ID, oldPhone],
      );
      const pendingPid = await pendingClient.query<Readonly<{ pid: number }>>(
        "SELECT pg_backend_pid() AS pid",
      );
      const updating = withTenantTransaction(
        updateClient as unknown as SqlClient,
        TENANT,
        async (tx) => {
          await tx.query("SET LOCAL statement_timeout = '5s'");
          await tx.query("SELECT customer_phone_erased($1)", [newPhone]);
          phoneLocked.resolve();
          await allowUpdate.promise;
          const result = await tx.query(
            `UPDATE customers
                SET phone = $3, version = version + 1, updated_at = now()
              WHERE org_id = $1::uuid AND id = $2::uuid AND anonymized_at IS NULL`,
            [DEMO_ORG_ID, customerId, newPhone],
          );
          return result.rowCount;
        },
      );
      await phoneLocked.promise;

      const args = Object.freeze({ customer_id: customerId, customer_phone: oldPhone });
      const inserting = withTenantTransaction(
        pendingClient as unknown as SqlClient,
        TENANT,
        async (tx) => {
          await tx.query("SET LOCAL statement_timeout = '5s'");
          return tx.query(
            `INSERT INTO ai_pending_actions (
               nonce, org_id, store_id, command, command_version, args_json,
               authority_present, args_hash, entity_versions_json, creator_staff_id,
               idempotency_key, created_at_epoch, expires_at_epoch, status,
               effective_risk, policy_outcome, requires_other_approver
             ) VALUES (
               $1::uuid, $2::uuid, $3::uuid, 'customer.update', '1.0.0', $4::jsonb,
               false, $5, '[]'::jsonb, $6::uuid,
               $7::uuid, 1775174400, 1775174700, 'pending',
               'R3', 'confirm', false
             )`,
            [
              pendingNonce,
              DEMO_ORG_ID,
              DEMO_STORE_ID,
              JSON.stringify(args),
              hashCanonical(args),
              DEMO_ADMIN_ID,
              idempotencyKey,
            ],
          );
        },
      );
      await waitForLock(adminPool, pendingPid.rows[0]!.pid);
      allowUpdate.resolve();

      const [updated, inserted] = await Promise.allSettled([updating, inserting]);
      assert.deepEqual(updated, { status: "fulfilled", value: 1 });
      assert.equal(inserted.status, "fulfilled");
      if (inserted.status === "fulfilled") assert.equal(inserted.value.rowCount, 1);
      const current = await adminPool.query<Readonly<{ phone: string }>>(
        "SELECT phone FROM customers WHERE id = $1::uuid",
        [customerId],
      );
      assert.equal(current.rows[0]?.phone, newPhone);
    } finally {
      allowUpdate.resolve();
      updateClient.release();
      pendingClient.release();
      await adminPool.query("DELETE FROM ai_pending_actions WHERE nonce = $1::uuid", [
        pendingNonce,
      ]);
      await adminPool.query("DELETE FROM customers WHERE id = $1::uuid", [customerId]);
      await Promise.all([appPool.end(), adminPool.end()]);
    }
  },
);
