import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { createPgPool, resolvePgUrls, type PgPool, type PgPoolClient } from "../db/pg-pool.js";
import { createSessionSqlClient } from "../db/pg-sql-client.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import type { TenantContext } from "../db/types.js";
import { createPasswordPort } from "../identity/password.js";
import { bootstrapLocalIdentity } from "../local/bootstrap.js";
import { parsePgTestFixtureEnvironment } from "../local/pg-test-fixture.js";
import { LOCAL_PROFILE } from "../local/profile.js";
import { createSqlStaffAccessStore } from "./access-store.js";
import { createSqlStaffCredentialStore } from "./sql-credential-store.js";

const urls =
  process.env.LAUNDRY_USE_LOCAL_PG === "1" || process.env.LAUNDRY_USE_LOCAL_PG === "true"
    ? resolvePgUrls(process.env)
    : null;
const maybe = urls === null ? test.skip : test;
const TENANT: TenantContext = Object.freeze({
  orgId: LOCAL_PROFILE.orgId,
  storeId: LOCAL_PROFILE.storeId,
  staffId: LOCAL_PROFILE.adminStaffId,
});

async function waitForDatabaseLock(pool: PgPool, pid: number): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await pool.query<{ wait_event_type: string | null; wait_event: string | null }>(
      `SELECT wait_event_type, wait_event
         FROM pg_catalog.pg_stat_activity
        WHERE pid = $1`,
      [pid],
    );
    const row = result.rows[0];
    if (row?.wait_event_type === "Lock" && row.wait_event !== null) return row.wait_event;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for PostgreSQL lock contention");
}

async function backendPid(client: PgPoolClient): Promise<number> {
  const result = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  const pid = result.rows[0]?.pid;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid)) {
    throw new Error("PostgreSQL backend PID unavailable");
  }
  return pid;
}

maybe(
  "real PG credential complete/reset serialize before row locks without a deadlock",
  { timeout: 20_000 },
  async () => {
    assert.ok(urls);
    const fixture = parsePgTestFixtureEnvironment(process.env);
    const adminPool = createPgPool({ connectionString: urls.admin, max: 3 });
    const appPool = createPgPool({ connectionString: urls.app, max: 3 });
    const targetStaffId = randomUUID();
    const targetRoleId = randomUUID();
    const setupRef = randomUUID();
    const reissueRef = randomUUID();
    const blocker = await adminPool.connect();
    const completingClient = await appPool.connect();
    const resettingClient = await appPool.connect();
    const accessClient = await appPool.connect();
    let blockerOpen = false;

    try {
      await bootstrapLocalIdentity(
        { pool: adminPool, passwordPort: createPasswordPort() },
        {
          profile: LOCAL_PROFILE,
          adminUsername: fixture.adminUsername,
          adminDisplayName: fixture.adminDisplayName,
          adminPassword: fixture.adminPassword,
          adminPin: fixture.adminPin,
          approverUsername: fixture.approverUsername,
          approverDisplayName: fixture.approverDisplayName,
          approverPassword: fixture.approverPassword,
          approverPin: fixture.approverPin,
          demoOnly: false,
        },
      );
      await adminPool.query(
        `INSERT INTO staffs (
           id, org_id, username, password_hash, pin_hash, display_name,
           is_active, permission_version, created_at, updated_at
         ) VALUES ($1::uuid,$2::uuid,$3,'!laundry-credential-pending',NULL,
                   'Credential Lock Target',false,1,NOW(),NOW())`,
        [targetStaffId, LOCAL_PROFILE.orgId, `credential-lock-${targetStaffId.slice(0, 8)}`],
      );
      await adminPool.query(
        `INSERT INTO staff_store_roles (
           id, org_id, store_id, staff_id, role, is_active, is_privacy_admin, created_at, updated_at
         ) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,'staff',false,false,NOW(),NOW())`,
        [targetRoleId, LOCAL_PROFILE.orgId, LOCAL_PROFILE.storeId, targetStaffId],
      );
      await adminPool.query(
        `INSERT INTO staff_credential_setups (
           id, org_id, store_id, staff_id, created_by_staff_id, purpose, activate_role,
           activate_privacy_admin, target_permission_version, status, expires_at, created_at
         ) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,'create','staff',
                   false,1,'pending',NOW() + interval '10 minutes',NOW())`,
        [
          setupRef,
          LOCAL_PROFILE.orgId,
          LOCAL_PROFILE.storeId,
          targetStaffId,
          LOCAL_PROFILE.adminStaffId,
        ],
      );

      await Promise.all([
        completingClient.query("SET lock_timeout = '5s'"),
        resettingClient.query("SET lock_timeout = '5s'"),
        accessClient.query("SET lock_timeout = '5s'"),
      ]);
      const [completingPid, resettingPid, accessPid] = await Promise.all([
        backendPid(completingClient),
        backendPid(resettingClient),
        backendPid(accessClient),
      ]);
      await blocker.query("BEGIN");
      blockerOpen = true;
      await blocker.query("SELECT id FROM staff_credential_setups WHERE id = $1::uuid FOR UPDATE", [
        setupRef,
      ]);

      const completion = withTenantTransaction(
        createSessionSqlClient(completingClient),
        TENANT,
        (tx) =>
          createSqlStaffCredentialStore(tx, TENANT).complete(LOCAL_PROFILE.adminStaffId, {
            credential_setup_ref: setupRef,
            password_hash: "completed-password-hash",
            pin_hash: "completed-pin-hash",
            now: Math.floor(Date.now() / 1_000),
            device_id: null,
          }),
      );
      await waitForDatabaseLock(adminPool, completingPid);

      const reset = withTenantTransaction(createSessionSqlClient(resettingClient), TENANT, (tx) =>
        createSqlStaffCredentialStore(tx, TENANT).reset(
          LOCAL_PROFILE.adminStaffId,
          {
            target_staff_id: targetStaffId,
            expected_permission_version: 1,
            reason: "concurrent lock-order regression",
          },
          {
            setupRef: reissueRef,
            targetStaffId,
            roleRowId: randomUUID(),
            createdAt: Math.floor(Date.now() / 1_000),
            expiresAt: Math.floor(Date.now() / 1_000) + 600,
          },
        ),
      );
      const resetWaitEvent = await waitForDatabaseLock(adminPool, resettingPid);
      const access = withTenantTransaction(createSessionSqlClient(accessClient), TENANT, (tx) =>
        createSqlStaffAccessStore(tx, TENANT).set(LOCAL_PROFILE.adminStaffId, {
          target_staff_id: targetStaffId,
          expected_permission_version: 2,
          role: "staff",
          privacy_admin: false,
          is_active: true,
        }),
      );
      const accessWaitEvent = await waitForDatabaseLock(adminPool, accessPid);
      await blocker.query("COMMIT");
      blockerOpen = false;

      const outcomes = await Promise.allSettled([completion, reset, access]);
      for (const outcome of outcomes) {
        if (outcome.status === "rejected") {
          const code =
            typeof outcome.reason === "object" &&
            outcome.reason !== null &&
            "code" in outcome.reason
              ? outcome.reason.code
              : undefined;
          assert.notEqual(code, "40P01", "credential lifecycle must never deadlock");
        }
      }
      assert.equal(resetWaitEvent.toLowerCase(), "advisory");
      assert.equal(accessWaitEvent.toLowerCase(), "advisory");
      assert.equal(outcomes[0]?.status, "fulfilled");
      assert.equal(outcomes[1]?.status, "fulfilled");
      assert.equal(outcomes[2]?.status, "fulfilled");
      if (
        outcomes[0]?.status !== "fulfilled" ||
        outcomes[1]?.status !== "fulfilled" ||
        outcomes[2]?.status !== "fulfilled"
      )
        return;
      assert.deepEqual(outcomes[0].value, {
        ok: true,
        result: { target_staff_id: targetStaffId, permission_version: 2, status: "active" },
      });
      assert.deepEqual(outcomes[1].value, { ok: false, reason: "stale" });
      assert.deepEqual(outcomes[2].value, {
        ok: true,
        before: {
          staff_id: targetStaffId,
          username: `credential-lock-${targetStaffId.slice(0, 8)}`,
          display_name: "Credential Lock Target",
          role: "staff",
          privacy_admin: false,
          is_active: true,
          permission_version: 2,
        },
        after: {
          staff_id: targetStaffId,
          username: `credential-lock-${targetStaffId.slice(0, 8)}`,
          display_name: "Credential Lock Target",
          role: "staff",
          privacy_admin: false,
          is_active: true,
          permission_version: 3,
        },
      });

      const persisted = await adminPool.query<{
        is_active: boolean;
        permission_version: number;
        setup_status: string;
        reissue_count: number;
      }>(
        `SELECT staff.is_active, staff.permission_version, setup.status AS setup_status,
                (SELECT count(*)::integer FROM staff_credential_setups WHERE id = $2::uuid)
                  AS reissue_count
           FROM staffs staff JOIN staff_credential_setups setup ON setup.staff_id = staff.id
          WHERE staff.id = $1::uuid AND setup.id = $3::uuid`,
        [targetStaffId, reissueRef, setupRef],
      );
      assert.deepEqual(persisted.rows[0], {
        is_active: true,
        permission_version: 3,
        setup_status: "consumed",
        reissue_count: 0,
      });
    } finally {
      if (blockerOpen) await blocker.query("ROLLBACK").catch(() => undefined);
      await Promise.allSettled([
        completingClient.query("ROLLBACK"),
        resettingClient.query("ROLLBACK"),
        accessClient.query("ROLLBACK"),
      ]);
      completingClient.release();
      resettingClient.release();
      accessClient.release();
      blocker.release();
      await adminPool.query("DELETE FROM audit_log WHERE entity_id = $1", [targetStaffId]);
      await adminPool.query("DELETE FROM staff_credential_setups WHERE staff_id = $1::uuid", [
        targetStaffId,
      ]);
      await adminPool.query("DELETE FROM staff_store_roles WHERE staff_id = $1::uuid", [
        targetStaffId,
      ]);
      await adminPool.query("DELETE FROM staffs WHERE id = $1::uuid", [targetStaffId]);
      await Promise.allSettled([adminPool.end(), appPool.end()]);
    }
  },
);
