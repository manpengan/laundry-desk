import assert from "node:assert/strict";
import test from "node:test";

import type { StaffRecord } from "../identity/types.js";
import { createMemoryStaffAccessState, type StaffAccessRow } from "./access-store.js";
import { createMemoryStaffCredentialStore } from "./memory-credential-store.js";

const ORG_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ADMIN_A_ID = "11111111-1111-4111-8111-111111111111";
const ADMIN_B_ID = "22222222-2222-4222-8222-222222222222";
const STAFF_ID = "33333333-3333-4333-8333-333333333333";

const ADMIN_A: StaffAccessRow = Object.freeze({
  staff_id: ADMIN_A_ID,
  username: "admin-a",
  display_name: "店长甲",
  role: "admin",
  privacy_admin: true,
  is_active: true,
  permission_version: 1,
});

const ADMIN_B: StaffAccessRow = Object.freeze({
  ...ADMIN_A,
  staff_id: ADMIN_B_ID,
  username: "admin-b",
  display_name: "店长乙",
});

const issue = (setupRef: string, targetStaffId: string, at = 1_000) =>
  Object.freeze({
    setupRef,
    targetStaffId,
    roleRowId: "44444444-4444-4444-8444-444444444444",
    createdAt: at,
    expiresAt: at + 900,
  });

function fixture() {
  const identities = new Map<string, StaffRecord>();
  const revoked: string[] = [];
  const state = createMemoryStaffAccessState([ADMIN_A, ADMIN_B]);
  const store = createMemoryStaffCredentialStore(state, {
    orgId: ORG_ID,
    findStaff: async (staffId) => identities.get(staffId) ?? null,
    upsertStaff: (staff) => identities.set(staff.staff_id, staff),
    revokeSessions: async (staffId) => {
      revoked.push(staffId);
    },
  });
  return { state, store, identities, revoked };
}

test("staff create stays inactive until creator completes the single-use setup", async () => {
  const { state, store, identities } = fixture();
  const setupRef = "55555555-5555-4555-8555-555555555555";
  const created = await store.create(
    ADMIN_A_ID,
    {
      username: "cashier-c",
      display_name: "店员丙",
      role: "staff",
      privacy_admin: false,
      reason: "入职",
    },
    issue(setupRef, STAFF_ID),
  );
  assert.equal(created.ok, true);
  assert.equal(state.read().find((row) => row.staff_id === STAFF_ID)?.is_active, false);
  assert.equal(identities.get(STAFF_ID)?.password_hash, "!laundry-credential-pending");

  const wrongActor = await store.complete(ADMIN_B_ID, {
    credential_setup_ref: setupRef,
    password_hash: "hash-password",
    pin_hash: "hash-pin",
    now: 1_100,
    device_id: null,
  });
  assert.deepEqual(wrongActor, { ok: false });

  const completed = await store.complete(ADMIN_A_ID, {
    credential_setup_ref: setupRef,
    password_hash: "hash-password",
    pin_hash: "hash-pin",
    now: 1_100,
    device_id: null,
  });
  assert.deepEqual(completed, {
    ok: true,
    result: { target_staff_id: STAFF_ID, permission_version: 2, status: "active" },
  });
  assert.equal(identities.get(STAFF_ID)?.password_hash, "hash-password");
  assert.equal(identities.get(STAFF_ID)?.pin_hash, "hash-pin");
  assert.equal(state.read().find((row) => row.staff_id === STAFF_ID)?.is_active, true);
  assert.deepEqual(
    await store.complete(ADMIN_A_ID, {
      credential_setup_ref: setupRef,
      password_hash: "other-password-hash",
      pin_hash: "other-pin-hash",
      now: 1_200,
      device_id: null,
    }),
    { ok: false },
  );
});

test("credential reset revokes sessions and requires a current active admin", async () => {
  const { state, store, identities, revoked } = fixture();
  identities.set(
    ADMIN_B_ID,
    Object.freeze({
      staff_id: ADMIN_B_ID,
      org_id: ORG_ID,
      username: ADMIN_B.username,
      password_hash: "old-password-hash",
      pin_hash: "old-pin-hash",
      display_name: ADMIN_B.display_name,
      is_active: true,
      permission_version: 1,
    }),
  );
  const resetRef = "66666666-6666-4666-8666-666666666666";
  const reset = await store.reset(
    ADMIN_A_ID,
    { target_staff_id: ADMIN_B_ID, expected_permission_version: 1, reason: "遗忘密码" },
    issue(resetRef, ADMIN_B_ID),
  );
  assert.equal(reset.ok, true);
  assert.deepEqual(revoked, [ADMIN_B_ID]);
  assert.equal(state.read().find((row) => row.staff_id === ADMIN_B_ID)?.permission_version, 2);
  assert.equal(identities.get(ADMIN_B_ID)?.password_hash, "!laundry-credential-pending");

  const only = createMemoryStaffAccessState([ADMIN_A]);
  const onlyStore = createMemoryStaffCredentialStore(only, {
    orgId: ORG_ID,
    findStaff: async () => null,
    upsertStaff: () => undefined,
    revokeSessions: async () => undefined,
  });
  assert.deepEqual(
    await onlyStore.reset(
      ADMIN_B_ID,
      { target_staff_id: ADMIN_A_ID, expected_permission_version: 1, reason: "不可移除末位" },
      issue("77777777-7777-4777-8777-777777777777", ADMIN_A_ID),
    ),
    { ok: false, reason: "not_found" },
  );
});

test("lost or expired setup can be reissued by a current R5-approved admin", async () => {
  const { store } = fixture();
  const oldRef = "88888888-8888-4888-8888-888888888888";
  await store.create(
    ADMIN_A_ID,
    {
      username: "cashier-d",
      display_name: "店员丁",
      role: "admin",
      privacy_admin: true,
      reason: "入职",
    },
    issue(oldRef, STAFF_ID),
  );
  assert.deepEqual(
    await store.complete(ADMIN_A_ID, {
      credential_setup_ref: oldRef,
      password_hash: "hash-password",
      pin_hash: "hash-pin",
      now: 2_000,
      device_id: null,
    }),
    { ok: false },
  );
  const newRef = "99999999-9999-4999-8999-999999999999";
  const reissued = await store.reset(
    ADMIN_B_ID,
    { target_staff_id: STAFF_ID, expected_permission_version: 1, reason: "重新签发" },
    issue(newRef, STAFF_ID, 2_001),
  );
  assert.equal(reissued.ok, true);
  assert.deepEqual(
    await store.complete(ADMIN_A_ID, {
      credential_setup_ref: oldRef,
      password_hash: "old-password-hash",
      pin_hash: "old-pin-hash",
      now: 2_100,
      device_id: null,
    }),
    { ok: false },
  );
  const completed = await store.complete(ADMIN_B_ID, {
    credential_setup_ref: newRef,
    password_hash: "new-password-hash",
    pin_hash: "new-pin-hash",
    now: 2_100,
    device_id: null,
  });
  assert.equal(completed.ok, true);
});
