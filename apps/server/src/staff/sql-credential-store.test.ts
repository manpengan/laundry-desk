import assert from "node:assert/strict";
import test from "node:test";

import type { QueryResult, SqlClient, TenantContext } from "../db/types.js";
import { createSqlStaffCredentialStore } from "./sql-credential-store.js";
import { revokeTargetSessions } from "./sql-credential-support.js";

const TENANT: TenantContext = Object.freeze({
  orgId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  storeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  staffId: "11111111-1111-4111-8111-111111111111",
});
const ADMIN_A = TENANT.staffId;
const ADMIN_B = "22222222-2222-4222-8222-222222222222";
const TARGET = "33333333-3333-4333-8333-333333333333";
const SETUP = "44444444-4444-4444-8444-444444444444";

type SqlCall = Readonly<{ sql: string; params: readonly unknown[] }>;
type UnknownResult = Readonly<{ rows: readonly unknown[]; rowCount: number }>;

function scriptedClient(
  calls: SqlCall[],
  respond: (sql: string, params: readonly unknown[]) => UnknownResult,
): SqlClient {
  return Object.freeze({
    query: async <TRow>(sql: string, params: readonly unknown[] = []) => {
      calls.push(Object.freeze({ sql, params }));
      return respond(sql, params) as QueryResult<TRow>;
    },
  });
}

function issue(setupRef = SETUP) {
  return Object.freeze({
    setupRef,
    targetStaffId: TARGET,
    roleRowId: "55555555-5555-4555-8555-555555555555",
    createdAt: 1_000,
    expiresAt: 1_900,
  });
}

test("SQL staff create persists only an inactive sentinel and non-secret setup authority", async () => {
  const calls: SqlCall[] = [];
  const client = scriptedClient(calls, (sql) => {
    if (sql.includes("FROM staff_store_roles role")) {
      return { rows: [{ exists: 1 }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  });
  const result = await createSqlStaffCredentialStore(client, TENANT).create(
    ADMIN_A,
    {
      username: "cashier-a",
      display_name: "店员甲",
      role: "admin",
      privacy_admin: true,
      reason: "private-create-reason",
    },
    issue(),
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.match(calls[0]?.sql ?? "", /pg_advisory_xact_lock/iu);
  assert.match(calls[1]?.sql ?? "", /ORDER BY staff_id FOR UPDATE/iu);
  assert.deepEqual(result.setup, {
    credential_setup_ref: SETUP,
    target_staff_id: TARGET,
    expires_at: 1_900,
    status: "pending",
  });
  const staffInsert = calls.find((call) => call.sql.includes("INSERT INTO staffs"));
  assert.equal(staffInsert?.params[3], "!laundry-credential-pending");
  const roleInsert = calls.find((call) => call.sql.includes("INSERT INTO staff_store_roles"));
  assert.match(roleInsert?.sql ?? "", /false,false/u);
  const setupInsert = calls.find((call) =>
    call.sql.includes("INSERT INTO staff_credential_setups"),
  );
  assert.deepEqual(setupInsert?.params.slice(4, 9), [ADMIN_A, "create", "admin", true, 1]);
  assert.doesNotMatch(JSON.stringify(calls), /private-create-reason/u);
});

test("SQL completion is creator-bound, single-use CAS with same-client audit", async () => {
  const calls: SqlCall[] = [];
  let pendingPasswordHash = "!laundry-credential-pending";
  const client = scriptedClient(calls, (sql) => {
    if (sql.includes("FROM staff_credential_setups setup")) {
      return {
        rows: [
          {
            setup_id: SETUP,
            created_by_staff_id: ADMIN_A,
            purpose: "create",
            activate_role: "staff",
            activate_privacy_admin: false,
            target_permission_version: 1,
            status: "pending",
            expires_at_epoch: "1900",
            staff_id: TARGET,
            username: "cashier-b",
            display_name: "店员乙",
            password_hash: pendingPasswordHash,
            pin_hash: null,
            permission_version: 1,
            staff_active: false,
            role: "staff",
            privacy_admin: false,
            role_active: false,
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.includes("FROM staff_store_roles role")) {
      return { rows: [{ exists: 1 }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  });
  const store = createSqlStaffCredentialStore(client, TENANT);
  const completed = await store.complete(ADMIN_A, {
    credential_setup_ref: SETUP,
    password_hash: "password-hash",
    pin_hash: "pin-hash",
    now: 1_100,
    device_id: "66666666-6666-4666-8666-666666666666",
  });

  assert.deepEqual(completed, {
    ok: true,
    result: { target_staff_id: TARGET, permission_version: 2, status: "active" },
  });
  assert.match(calls[0]?.sql ?? "", /pg_advisory_xact_lock/iu);
  assert.match(calls[1]?.sql ?? "", /ORDER BY staff_id FOR UPDATE/iu);
  assert.equal(calls.filter((call) => call.sql.includes("UPDATE staffs SET")).length, 1);
  assert.equal(calls.filter((call) => call.sql.includes("SET status = 'consumed'")).length, 1);
  const audit = calls.find((call) => call.sql.includes("INSERT INTO audit_log"));
  assert.equal(audit?.params[5], "staff.credentials.complete");
  assert.doesNotMatch(JSON.stringify(audit), /password-hash|pin-hash/u);

  calls.length = 0;
  const rejected = await store.complete(ADMIN_B, {
    credential_setup_ref: SETUP,
    password_hash: "unused-password-hash",
    pin_hash: "unused-pin-hash",
    now: 1_100,
    device_id: null,
  });
  assert.deepEqual(rejected, { ok: false });
  assert.equal(
    calls.some((call) => call.sql.includes("UPDATE staffs SET")),
    false,
  );
  assert.equal(
    calls.some((call) => call.sql.includes("INSERT INTO audit_log")),
    false,
  );

  calls.length = 0;
  pendingPasswordHash = "unexpected-existing-hash";
  const corruptState = await store.complete(ADMIN_A, {
    credential_setup_ref: SETUP,
    password_hash: "unused-password-hash",
    pin_hash: "unused-pin-hash",
    now: 1_100,
    device_id: null,
  });
  assert.deepEqual(corruptState, { ok: false });
  assert.equal(
    calls.some((call) => call.sql.includes("UPDATE staffs SET")),
    false,
  );
});

test("SQL reset reissues an inactive setup to a different current admin", async () => {
  const calls: SqlCall[] = [];
  const newSetup = "77777777-7777-4777-8777-777777777777";
  const client = scriptedClient(calls, (sql) => {
    if (sql.includes("FROM staff_store_roles role")) {
      return { rows: [{ exists: 1 }], rowCount: 1 };
    }
    if (sql.includes("FOR UPDATE OF staff, role")) {
      return {
        rows: [
          {
            staff_id: TARGET,
            username: "cashier-c",
            display_name: "店员丙",
            password_hash: "!laundry-credential-pending",
            pin_hash: null,
            role: "staff",
            privacy_admin: false,
            staff_active: false,
            role_active: false,
            permission_version: 4,
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.includes("status IN ('pending', 'expired')")) {
      return {
        rows: [
          {
            id: SETUP,
            purpose: "create",
            activate_role: "admin",
            activate_privacy_admin: true,
            target_permission_version: 4,
            status: "pending",
          },
        ],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 1 };
  });
  const result = await createSqlStaffCredentialStore(client, TENANT).reset(
    ADMIN_B,
    { target_staff_id: TARGET, expected_permission_version: 4, reason: "重新签发" },
    issue(newSetup),
  );

  assert.equal(result.ok, true);
  assert.match(calls[0]?.sql ?? "", /pg_advisory_xact_lock/iu);
  assert.match(calls[1]?.sql ?? "", /ORDER BY staff_id FOR UPDATE/iu);
  const expired = calls.find((call) => call.sql.includes("SET status = 'expired'"));
  assert.equal(expired?.params[2], SETUP);
  const inserted = calls.find((call) => call.sql.includes("INSERT INTO staff_credential_setups"));
  assert.deepEqual(inserted?.params.slice(4, 9), [ADMIN_B, "reset", "admin", true, 4]);
  assert.equal(
    calls.some((call) => call.sql.includes("UPDATE staffs SET")),
    false,
  );
  assert.equal(
    calls.some((call) => call.sql.includes("UPDATE sessions SET")),
    false,
  );
});

test("SQL credential reset uses the organization-wide definer revocation boundary", async () => {
  const calls: SqlCall[] = [];
  const client = scriptedClient(calls, () => ({ rows: [], rowCount: 1 }));

  await revokeTargetSessions(client, TENANT, ADMIN_A, TARGET);

  assert.equal(calls.length, 1);
  assert.match(calls[0]?.sql ?? "", /laundry_revoke_staff_sessions/iu);
  assert.deepEqual(calls[0]?.params, [TENANT.orgId, TENANT.storeId, ADMIN_A, TARGET]);
});
