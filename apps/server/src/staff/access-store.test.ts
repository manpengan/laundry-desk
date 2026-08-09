import assert from "node:assert/strict";
import test from "node:test";

import type { SqlClient, TenantContext } from "../db/types.js";
import {
  createMemoryStaffAccessStore,
  createMemoryStaffAccessState,
  createSqlStaffAccessStore,
  type StaffAccessRow,
} from "./access-store.js";

const ADMIN_A: StaffAccessRow = Object.freeze({
  staff_id: "11111111-1111-4111-8111-111111111111",
  username: "admin-a",
  display_name: "店长甲",
  role: "admin",
  privacy_admin: true,
  is_active: true,
  permission_version: 1,
});

const ADMIN_B: StaffAccessRow = Object.freeze({
  staff_id: "22222222-2222-4222-8222-222222222222",
  username: "admin-b",
  display_name: "店长乙",
  role: "admin",
  privacy_admin: true,
  is_active: true,
  permission_version: 3,
});

test("staff access change increments permission version and keeps immutable rows", async () => {
  const store = createMemoryStaffAccessStore([ADMIN_A, ADMIN_B]);
  const result = await store.set(ADMIN_A.staff_id, {
    target_staff_id: ADMIN_B.staff_id,
    expected_permission_version: 3,
    role: "staff",
    privacy_admin: false,
    is_active: true,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.before.permission_version, 3);
  assert.equal(result.after.permission_version, 4);
  assert.equal(result.after.role, "staff");
  assert.equal(Object.isFrozen(result.after), true);
});

test("staff access rejects self change and stale optimistic version", async () => {
  const store = createMemoryStaffAccessStore([ADMIN_A, ADMIN_B]);
  assert.deepEqual(
    await store.set(ADMIN_A.staff_id, {
      target_staff_id: ADMIN_A.staff_id,
      expected_permission_version: 1,
      role: "staff",
      privacy_admin: false,
      is_active: true,
    }),
    { ok: false, reason: "self_change" },
  );
  assert.deepEqual(
    await store.set(ADMIN_A.staff_id, {
      target_staff_id: ADMIN_B.staff_id,
      expected_permission_version: 2,
      role: "admin",
      privacy_admin: true,
      is_active: true,
    }),
    { ok: false, reason: "stale" },
  );
});

test("staff access keeps at least one active admin and privacy administrator", async () => {
  const only = createMemoryStaffAccessStore([ADMIN_A]);
  const result = await only.set(ADMIN_B.staff_id, {
    target_staff_id: ADMIN_A.staff_id,
    expected_permission_version: 1,
    role: "staff",
    privacy_admin: false,
    is_active: true,
  });
  assert.deepEqual(result, { ok: false, reason: "last_admin" });

  const privacyOnly = createMemoryStaffAccessStore([
    ADMIN_A,
    Object.freeze({ ...ADMIN_B, privacy_admin: false }),
  ]);
  const revoked = await privacyOnly.set(ADMIN_B.staff_id, {
    target_staff_id: ADMIN_A.staff_id,
    expected_permission_version: 1,
    role: "admin",
    privacy_admin: false,
    is_active: true,
  });
  assert.deepEqual(revoked, { ok: false, reason: "last_privacy_admin" });
});

test("staff access rejects activation and role changes while credentials are pending", async () => {
  const pending = Object.freeze({
    ...ADMIN_B,
    privacy_admin: false,
    is_active: false,
  });
  const state = createMemoryStaffAccessState([ADMIN_A, pending]);
  state.markCredentialPending(ADMIN_B.staff_id);
  const store = createMemoryStaffAccessStore(state);

  assert.deepEqual(
    await store.set(ADMIN_A.staff_id, {
      target_staff_id: ADMIN_B.staff_id,
      expected_permission_version: ADMIN_B.permission_version,
      role: "admin",
      privacy_admin: true,
      is_active: true,
    }),
    { ok: false, reason: "credential_pending" },
  );
  assert.deepEqual(
    await store.set(ADMIN_A.staff_id, {
      target_staff_id: ADMIN_B.staff_id,
      expected_permission_version: ADMIN_B.permission_version,
      role: "staff",
      privacy_admin: false,
      is_active: false,
    }),
    { ok: false, reason: "credential_pending" },
  );
});

test("SQL staff access stops before mutation when a credential setup is pending", async () => {
  const statements: string[] = [];
  const client = {
    query: async (sql: string) => {
      statements.push(sql);
      if (sql.includes("ORDER BY staff.username")) {
        return { rows: [ADMIN_B], rowCount: 1 };
      }
      if (sql.includes("FROM staff_credential_setups")) {
        return { rows: [{ exists: 1 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
  } as unknown as SqlClient;
  const tenant: TenantContext = Object.freeze({
    orgId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    storeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    staffId: ADMIN_A.staff_id,
  });

  const result = await createSqlStaffAccessStore(client, tenant).set(ADMIN_A.staff_id, {
    target_staff_id: ADMIN_B.staff_id,
    expected_permission_version: ADMIN_B.permission_version,
    role: "staff",
    privacy_admin: false,
    is_active: false,
  });
  assert.deepEqual(result, { ok: false, reason: "credential_pending" });
  assert.match(statements[0] ?? "", /pg_advisory_xact_lock/iu);
  assert.match(statements[1] ?? "", /ORDER BY staff_id FOR UPDATE/iu);
  assert.equal(
    statements.some((sql) => sql.includes("UPDATE staffs")),
    false,
  );
});

test("SQL access change stops before the role update when the staff CAS loses", async () => {
  const statements: string[] = [];
  const client = {
    query: async (sql: string) => {
      statements.push(sql);
      if (sql.includes("ORDER BY staff.username")) {
        return { rows: [ADMIN_B], rowCount: 1 };
      }
      if (sql.includes("count(*) FILTER")) {
        return { rows: [{ admins: "1", privacy_admins: "1" }], rowCount: 1 };
      }
      if (sql.includes("UPDATE staffs")) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 1 };
    },
  } as unknown as SqlClient;
  const tenant: TenantContext = Object.freeze({
    orgId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    storeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    staffId: ADMIN_A.staff_id,
  });

  const result = await createSqlStaffAccessStore(client, tenant).set(ADMIN_A.staff_id, {
    target_staff_id: ADMIN_B.staff_id,
    expected_permission_version: ADMIN_B.permission_version,
    role: "staff",
    privacy_admin: false,
    is_active: true,
  });

  assert.deepEqual(result, { ok: false, reason: "stale" });
  assert.equal(
    statements.some((sql) => sql.includes("UPDATE staff_store_roles")),
    false,
  );
});
