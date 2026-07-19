import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import { createLeaseService } from "../src/lease-service.mjs";
import { createLeaseSigner, createReleaseAck } from "../src/signing.mjs";
import {
  clockAt,
  createAdminPool,
  createPool,
  resetStore,
} from "./helpers.mjs";

const ids = Object.freeze({
  org_id: "00000000-0000-4000-8000-000000000001",
  store_id: "10000000-0000-4000-8000-000000000001",
  device_a: "20000000-0000-4000-8000-000000000001",
  device_b: "20000000-0000-4000-8000-000000000002",
  device_c: "20000000-0000-4000-8000-000000000003",
});

const leaseKeys = generateKeyPairSync("ed25519");
const deviceAKeys = generateKeyPairSync("ed25519");
const publicKeys = new Map([[ids.device_a, deviceAKeys.publicKey]]);
const signer = createLeaseSigner(leaseKeys);
const pool = createPool();
const adminPool = createAdminPool();

function serviceAt(iso) {
  return createLeaseService({
    pool,
    signer,
    trustedClock: clockAt(iso),
    getDevicePublicKey: (deviceId) => publicKeys.get(deviceId),
  });
}

async function promote(service, deviceId, overrides = {}) {
  return service.promote({
    org_id: ids.org_id,
    store_id: ids.store_id,
    device_id: deviceId,
    ttl_ms: 1_000,
    max_clock_skew_ms: 100,
    ...overrides,
  });
}

test.beforeEach(async () => resetStore(adminPool, ids));
test.after(async () => Promise.all([pool.end(), adminPool.end()]));

test("two owners concurrently promote through distinct locked connections", async () => {
  const service = serviceAt("2026-07-19T00:00:00.000Z");

  const results = await Promise.all([
    promote(service, ids.device_a),
    promote(service, ids.device_b),
  ]);

  const issued = results.filter((result) => result.status === "issued");
  const waiting = results.filter((result) => result.status === "online-only");
  assert.equal(issued.length, 1);
  assert.equal(waiting.length, 1);
  assert.notEqual(
    results[0].diagnostics.backendPid,
    results[1].diagnostics.backendPid,
  );
  const count = await pool.query(
    "SELECT count(*)::int AS count FROM primary_leases",
  );
  assert.equal(count.rows[0].count, 1);
});

test("without ACK promotion waits until old not_after plus skew", async () => {
  const first = await promote(
    serviceAt("2026-07-19T00:00:00.000Z"),
    ids.device_a,
  );
  const tooEarly = await promote(
    serviceAt("2026-07-19T00:00:01.099Z"),
    ids.device_b,
  );
  const eligible = await promote(
    serviceAt("2026-07-19T00:00:01.100Z"),
    ids.device_b,
  );

  assert.equal(first.status, "issued");
  assert.equal(tooEarly.status, "online-only");
  assert.equal(tooEarly.reason, "old-lease-wait");
  assert.equal(eligible.status, "issued");
  assert.equal(eligible.lease.primary_epoch, first.lease.primary_epoch + 1);
  assert.ok(
    Date.parse(eligible.lease.issued_at) >=
      Date.parse(first.lease.not_after) + 100,
  );
});

test("valid signed release ACK permits immediate strictly-incremented epoch", async () => {
  const first = await promote(
    serviceAt("2026-07-19T00:00:00.000Z"),
    ids.device_a,
  );
  const ack = createReleaseAck({
    privateKey: deviceAKeys.privateKey,
    lease_id: first.lease.lease_id,
    device_id: ids.device_a,
    primary_epoch: first.lease.primary_epoch,
    nonce: "release-once",
  });

  await serviceAt("2026-07-19T00:00:00.100Z").release({
    org_id: ids.org_id,
    store_id: ids.store_id,
    ack,
  });
  const next = await promote(
    serviceAt("2026-07-19T00:00:00.100Z"),
    ids.device_b,
  );

  assert.equal(next.status, "issued");
  assert.equal(next.lease.primary_epoch, first.lease.primary_epoch + 1);
});

test("release ACK device field must match the current lease device", async () => {
  const first = await promote(
    serviceAt("2026-07-19T00:00:00.000Z"),
    ids.device_a,
  );
  const mismatchedAck = createReleaseAck({
    privateKey: deviceAKeys.privateKey,
    lease_id: first.lease.lease_id,
    device_id: ids.device_b,
    primary_epoch: first.lease.primary_epoch,
    nonce: "mismatched-device",
  });

  await assert.rejects(
    serviceAt("2026-07-19T00:00:00.100Z").release({
      org_id: ids.org_id,
      store_id: ids.store_id,
      ack: mismatchedAck,
    }),
    /release ACK device mismatch/,
  );
  const lease = await pool.query(
    "SELECT released_at FROM primary_leases WHERE lease_id = $1",
    [first.lease.lease_id],
  );
  assert.equal(lease.rows[0].released_at, null);
});

test("device key resolution cannot await external I/O while head is locked", async () => {
  const first = await promote(
    serviceAt("2026-07-19T00:00:00.000Z"),
    ids.device_a,
  );
  const ack = createReleaseAck({
    privateKey: deviceAKeys.privateKey,
    lease_id: first.lease.lease_id,
    device_id: ids.device_a,
    primary_epoch: first.lease.primary_epoch,
    nonce: "async-key-resolver",
  });
  const unsafeService = createLeaseService({
    pool,
    signer,
    trustedClock: clockAt("2026-07-19T00:00:00.100Z"),
    getDevicePublicKey: async () => deviceAKeys.publicKey,
  });

  await assert.rejects(
    unsafeService.release({ org_id: ids.org_id, store_id: ids.store_id, ack }),
    /device public key resolver must be synchronous/,
  );
  const lease = await pool.query(
    "SELECT released_at FROM primary_leases WHERE lease_id = $1",
    [first.lease.lease_id],
  );
  assert.equal(lease.rows[0].released_at, null);
});

test("release and promotion race serializes without overlapping leases", async () => {
  const first = await promote(
    serviceAt("2026-07-19T00:00:00.000Z"),
    ids.device_a,
  );
  const ack = createReleaseAck({
    privateKey: deviceAKeys.privateKey,
    lease_id: first.lease.lease_id,
    device_id: ids.device_a,
    primary_epoch: first.lease.primary_epoch,
    nonce: "race-release",
  });
  const raceService = serviceAt("2026-07-19T00:00:00.100Z");

  const outcomes = await Promise.allSettled([
    raceService.release({ org_id: ids.org_id, store_id: ids.store_id, ack }),
    promote(raceService, ids.device_c),
  ]);

  assert.equal(outcomes[0].status, "fulfilled");
  const active = await pool.query(
    `SELECT count(*)::int AS count
     FROM primary_leases
     WHERE released_at IS NULL AND not_after > $1`,
    ["2026-07-19T00:00:00.100Z"],
  );
  assert.ok(active.rows[0].count <= 1);
});

test("unique epoch violation rolls back the entire attempted promotion", async () => {
  await promote(serviceAt("2026-07-19T00:00:00.000Z"), ids.device_a);
  await pool.query(
    `UPDATE primary_lease_heads
     SET current_epoch = 0, current_lease_id = NULL, current_not_after = NULL,
         version = 99
     WHERE org_id = $1 AND store_id = $2`,
    [ids.org_id, ids.store_id],
  );

  await assert.rejects(
    promote(serviceAt("2026-07-19T00:00:02.000Z"), ids.device_b),
    (error) => error.code === "23505",
  );
  const state = await pool.query(
    `SELECT current_epoch::int, current_lease_id, version::int
     FROM primary_lease_heads WHERE org_id = $1 AND store_id = $2`,
    [ids.org_id, ids.store_id],
  );
  const count = await pool.query(
    "SELECT count(*)::int AS count FROM primary_leases",
  );
  assert.deepEqual(state.rows[0], {
    current_epoch: 0,
    current_lease_id: null,
    version: 99,
  });
  assert.equal(count.rows[0].count, 1);
});

test("lease durations must fit PostgreSQL integer columns", async () => {
  const service = serviceAt("2026-07-19T00:00:00.000Z");

  await assert.rejects(
    promote(service, ids.device_a, { ttl_ms: 2_147_483_648 }),
    /ttl_ms must fit a positive PostgreSQL integer/,
  );
  await assert.rejects(
    promote(service, ids.device_a, {
      max_clock_skew_ms: 2_147_483_648,
    }),
    /max_clock_skew_ms must fit a non-negative PostgreSQL integer/,
  );
});
