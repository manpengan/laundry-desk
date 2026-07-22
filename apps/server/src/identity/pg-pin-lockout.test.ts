/**
 * Unit tests for memory pin lockout repo (no Postgres required).
 * PG durable path is covered by pg-store.test when LAUNDRY_USE_LOCAL_PG=1.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createMemoryPinLockoutRepo } from "./pg-pin-repo.js";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STORE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const STAFF = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const DEVICE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

test("memory pin lockout upsert / get / clear", async () => {
  const lockouts = createMemoryPinLockoutRepo();
  assert.equal(await lockouts.get(ORG, STORE, STAFF, DEVICE), null);

  await lockouts.upsert({
    org_id: ORG,
    store_id: STORE,
    staff_id: STAFF,
    device_id: DEVICE,
    locked_until: 1_700_000_900,
    failed_attempts: 5,
  });

  const row = await lockouts.get(ORG, STORE, STAFF, DEVICE);
  assert.ok(row);
  assert.equal(row.failed_attempts, 5);
  assert.equal(row.locked_until, 1_700_000_900);

  await lockouts.upsert({
    org_id: ORG,
    store_id: STORE,
    staff_id: STAFF,
    device_id: DEVICE,
    locked_until: 1_700_001_800,
    failed_attempts: 7,
  });
  const updated = await lockouts.get(ORG, STORE, STAFF, DEVICE);
  assert.equal(updated?.failed_attempts, 7);
  assert.equal(updated?.locked_until, 1_700_001_800);

  await lockouts.clear(ORG, STORE, STAFF, DEVICE);
  assert.equal(await lockouts.get(ORG, STORE, STAFF, DEVICE), null);
});
