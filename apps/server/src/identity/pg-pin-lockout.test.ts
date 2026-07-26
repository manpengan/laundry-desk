/**
 * Unit tests for memory pin lockout repo (no Postgres required).
 * PG durable path is covered by pg-store.test when LAUNDRY_USE_LOCAL_PG=1.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  CONSUME_PIN_SUCCESS_SQL,
  createMemoryPinLockoutRepo,
  LOOKUP_PIN_MUTATION_ACTOR_SQL,
  RECORD_PIN_FAILURE_SQL,
  SELECT_PIN_LOCKOUT_FOR_UPDATE_SQL,
} from "./pg-pin-repo.js";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STORE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const STAFF = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const DEVICE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

test("PG counter lookup locks partial window rows without filtering by active lock", () => {
  assert.match(SELECT_PIN_LOCKOUT_FOR_UPDATE_SQL, /FOR UPDATE/u);
  assert.doesNotMatch(SELECT_PIN_LOCKOUT_FOR_UPDATE_SQL, /locked_until\s*>/iu);
  assert.equal((SELECT_PIN_LOCKOUT_FOR_UPDATE_SQL.match(/\$[1-4]/gu) ?? []).length, 4);
});

test("PG failure update derives the audit actor from its bound session", () => {
  assert.match(LOOKUP_PIN_MUTATION_ACTOR_SQL, /FROM laundry_auth_lookup_pin\(\$1::uuid\)/iu);
  assert.match(LOOKUP_PIN_MUTATION_ACTOR_SQL, /requester_staff_id::text/iu);
  assert.match(RECORD_PIN_FAILURE_SQL, /FROM sessions AS requester_session/iu);
  assert.match(RECORD_PIN_FAILURE_SQL, /requester_session\.id = challenge\.session_id/iu);
  assert.match(RECORD_PIN_FAILURE_SQL, /requester_session\.org_id = challenge\.org_id/iu);
  assert.match(RECORD_PIN_FAILURE_SQL, /requester_session\.store_id = challenge\.store_id/iu);
  assert.match(RECORD_PIN_FAILURE_SQL, /requester_session\.device_id = challenge\.device_id/iu);
  assert.match(
    RECORD_PIN_FAILURE_SQL,
    /requester_session\.session_version = challenge\.session_version/iu,
  );
  assert.match(RECORD_PIN_FAILURE_SQL, /requester_session\.staff_id = \$9::uuid/iu);
  assert.match(
    RECORD_PIN_FAILURE_SQL,
    /RETURNING challenge\.max_attempts,\s*requester_session\.staff_id::text/iu,
  );
  assert.doesNotMatch(RECORD_PIN_FAILURE_SQL, /RETURNING\s+max_attempts,\s*requester_staff_id/iu);
});

test("PG success consume revalidates the same database-derived requester", () => {
  assert.match(CONSUME_PIN_SUCCESS_SQL, /FROM sessions AS requester_session/iu);
  assert.match(CONSUME_PIN_SUCCESS_SQL, /requester_session\.id = challenge\.session_id/iu);
  assert.match(CONSUME_PIN_SUCCESS_SQL, /requester_session\.staff_id = \$8::uuid/iu);
  assert.match(
    CONSUME_PIN_SUCCESS_SQL,
    /requester_session\.session_version = challenge\.session_version/iu,
  );
});

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
    last_failed_at: 1_700_000_000,
  });

  const row = await lockouts.get(ORG, STORE, STAFF, DEVICE);
  assert.ok(row);
  assert.equal(row.failed_attempts, 5);
  assert.equal(row.locked_until, 1_700_000_900);
  assert.equal(row.last_failed_at, 1_700_000_000);

  await lockouts.upsert({
    org_id: ORG,
    store_id: STORE,
    staff_id: STAFF,
    device_id: DEVICE,
    locked_until: 1_700_001_800,
    failed_attempts: 7,
    last_failed_at: 1_700_000_900,
  });
  const updated = await lockouts.get(ORG, STORE, STAFF, DEVICE);
  assert.equal(updated?.failed_attempts, 7);
  assert.equal(updated?.locked_until, 1_700_001_800);
  assert.equal(updated?.last_failed_at, 1_700_000_900);

  await lockouts.clear(ORG, STORE, STAFF, DEVICE);
  assert.equal(await lockouts.get(ORG, STORE, STAFF, DEVICE), null);
});
