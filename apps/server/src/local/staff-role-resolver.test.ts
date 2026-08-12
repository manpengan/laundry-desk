import assert from "node:assert/strict";
import test from "node:test";

import type { PgPool } from "../db/pg-pool.js";
import type { StaffRecord } from "../identity/types.js";
import { createMemoryStaffAccessStore } from "../staff/access-store.js";
import { LOCAL_PROFILE } from "./profile.js";
import { createMemoryStaffRoleResolver, createPgStaffRoleResolver } from "./staff-role-resolver.js";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const STORE_ID = "22222222-2222-4222-8222-222222222222";
const STAFF_ID = "33333333-3333-4333-8333-333333333333";

test("PG staff role resolution loads the exact requested store scope", async () => {
  const pool = Object.freeze({}) as PgPool;
  const scopes: unknown[] = [];
  const resolve = createPgStaffRoleResolver(pool, async (actualPool, scope) => {
    assert.equal(actualPool, pool);
    scopes.push(scope);
    return Object.freeze([
      Object.freeze({
        staff_id: STAFF_ID,
        display_name: "Remote Owner",
        role: "admin" as const,
        username: "remote-owner",
        privacy_admin: true,
      }),
    ]);
  });

  assert.equal(await resolve(ORG_ID, STORE_ID, STAFF_ID), "admin");
  assert.deepEqual(scopes, [
    Object.freeze({ orgId: ORG_ID, storeId: STORE_ID, staffId: STAFF_ID }),
  ]);
});

test("PG staff role resolution rejects a missing target in the scoped directory", async () => {
  const resolve = createPgStaffRoleResolver(Object.freeze({}) as PgPool, async () =>
    Object.freeze([]),
  );
  assert.equal(await resolve(ORG_ID, STORE_ID, STAFF_ID), null);
});

test("memory role resolution follows mutable access authority after demotion", async () => {
  const access = createMemoryStaffAccessStore([
    Object.freeze({
      staff_id: LOCAL_PROFILE.adminStaffId,
      username: "admin",
      display_name: "店长",
      role: "admin" as const,
      privacy_admin: true,
      is_active: true,
      permission_version: 1,
    }),
    Object.freeze({
      staff_id: STAFF_ID,
      username: "approver",
      display_name: "审批人",
      role: "admin" as const,
      privacy_admin: false,
      is_active: true,
      permission_version: 1,
    }),
  ]);
  const identity: StaffRecord = Object.freeze({
    staff_id: STAFF_ID,
    org_id: LOCAL_PROFILE.orgId,
    username: "approver",
    display_name: "审批人",
    password_hash: "test",
    pin_hash: "test",
    is_active: true,
    permission_version: 1,
  });
  const resolve = createMemoryStaffRoleResolver(
    access,
    Object.freeze({
      findByOrgUsername: async () => identity,
      findById: async () => identity,
    }),
  );
  assert.equal(await resolve(LOCAL_PROFILE.orgId, LOCAL_PROFILE.storeId, STAFF_ID), "admin");
  const changed = await access.set(LOCAL_PROFILE.adminStaffId, {
    target_staff_id: STAFF_ID,
    expected_permission_version: 1,
    role: "staff",
    privacy_admin: false,
    is_active: true,
  });
  assert.equal(changed.ok, true);
  assert.equal(await resolve(LOCAL_PROFILE.orgId, LOCAL_PROFILE.storeId, STAFF_ID), "staff");
});
