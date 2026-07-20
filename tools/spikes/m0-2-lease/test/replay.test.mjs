import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import { createLeaseService } from "../src/lease-service.mjs";
import { replayOfflineCommand } from "../src/replay.mjs";
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
  old_device: "20000000-0000-4000-8000-000000000001",
  new_device: "20000000-0000-4000-8000-000000000002",
});

const pool = createPool();
const adminPool = createAdminPool();
const leaseKeys = generateKeyPairSync("ed25519");
const deviceKeys = generateKeyPairSync("ed25519");
const signer = createLeaseSigner(leaseKeys);

function serviceAt(iso) {
  return createLeaseService({
    pool,
    signer,
    trustedClock: clockAt(iso),
    getDevicePublicKey: (deviceId) =>
      deviceId === ids.old_device ? deviceKeys.publicKey : undefined,
  });
}

async function promote(service, deviceId) {
  return service.promote({
    org_id: ids.org_id,
    store_id: ids.store_id,
    device_id: deviceId,
    ttl_ms: 100,
    max_clock_skew_ms: 10,
  });
}

function commandFor(lease, perLeaseSeq) {
  return Object.freeze({
    org_id: ids.org_id,
    store_id: ids.store_id,
    lease_id: lease.lease_id,
    primary_epoch: lease.primary_epoch,
    per_lease_seq: perLeaseSeq,
    command_name: "order.pickup",
  });
}

async function insertDomainEffect(client, command) {
  await client.query(
    `INSERT INTO replay_domain_effects (
       org_id, store_id, lease_id, per_lease_seq, command_name
     ) VALUES ($1, $2, $3, $4, $5)`,
    [
      command.org_id,
      command.store_id,
      command.lease_id,
      command.per_lease_seq,
      command.command_name,
    ],
  );
}

test.beforeEach(async () => resetStore(adminPool, ids));
test.after(async () => Promise.all([pool.end(), adminPool.end()]));

test("old epoch command is audited and arbitrated without domain mutation", async () => {
  const oldLease = await promote(
    serviceAt("2026-07-19T00:00:00.000Z"),
    ids.old_device,
  );
  await promote(serviceAt("2026-07-19T00:00:00.110Z"), ids.new_device);

  const result = await replayOfflineCommand(
    pool,
    commandFor(oldLease.lease, 1),
    async () => {
      throw new Error("stale command reached domain mutation");
    },
  );

  assert.deepEqual(result, {
    decision: "arbitrate",
    applied: false,
    duplicate: false,
    reason: "stale-epoch",
  });
  const audit = await pool.query(
    `SELECT decision, reason, arbitration_required
     FROM offline_command_audit`,
  );
  assert.deepEqual(audit.rows, [
    {
      decision: "arbitrate",
      reason: "stale-epoch",
      arbitration_required: true,
    },
  ]);
});

test("replay is strictly ordered and exact duplicates are idempotent", async () => {
  const issued = await promote(
    serviceAt("2026-07-19T00:00:00.000Z"),
    ids.old_device,
  );
  const second = commandFor(issued.lease, 2);
  const first = commandFor(issued.lease, 1);

  const outOfOrder = await replayOfflineCommand(pool, second, async () => {
    throw new Error("out-of-order command reached domain mutation");
  });
  const applied = await replayOfflineCommand(pool, first, (client) =>
    insertDomainEffect(client, first),
  );
  const duplicate = await replayOfflineCommand(pool, first, async () => {
    throw new Error("duplicate command reached domain mutation");
  });
  const collisionCommand = Object.freeze({
    ...first,
    command_name: "order.refund",
  });
  const collision = await replayOfflineCommand(
    pool,
    collisionCommand,
    async () => {
      throw new Error("sequence collision reached domain mutation");
    },
  );
  const repeatedCollision = await replayOfflineCommand(
    pool,
    collisionCommand,
    async () => {
      throw new Error("repeated collision reached domain mutation");
    },
  );

  assert.equal(outOfOrder.reason, "out-of-order");
  assert.equal(outOfOrder.applied, false);
  assert.equal(applied.decision, "apply");
  assert.equal(applied.applied, true);
  assert.deepEqual(duplicate, {
    decision: "apply",
    applied: false,
    duplicate: true,
    reason: "current-sequence",
  });
  assert.deepEqual(collision, {
    decision: "arbitrate",
    applied: false,
    duplicate: false,
    reason: "sequence-collision",
  });
  assert.deepEqual(repeatedCollision, {
    decision: "arbitrate",
    applied: false,
    duplicate: true,
    reason: "sequence-collision",
  });
  const effects = await pool.query(
    "SELECT count(*)::int AS count FROM replay_domain_effects",
  );
  assert.equal(effects.rows[0].count, 1);
});

test("a released lease cannot apply commands before the next promotion", async () => {
  const issued = await promote(
    serviceAt("2026-07-19T00:00:00.000Z"),
    ids.old_device,
  );
  const ack = createReleaseAck({
    privateKey: deviceKeys.privateKey,
    lease_id: issued.lease.lease_id,
    device_id: ids.old_device,
    primary_epoch: issued.lease.primary_epoch,
    nonce: "released-before-replay",
  });
  await serviceAt("2026-07-19T00:00:00.010Z").release({
    org_id: ids.org_id,
    store_id: ids.store_id,
    ack,
  });

  const result = await replayOfflineCommand(
    pool,
    commandFor(issued.lease, 1),
    async () => {
      throw new Error("released lease reached domain mutation");
    },
  );

  assert.equal(result.decision, "arbitrate");
  assert.equal(result.reason, "released-lease");
  assert.equal(result.applied, false);
});

test("application role can append audit but cannot mutate or erase it", async () => {
  const issued = await promote(
    serviceAt("2026-07-19T00:00:00.000Z"),
    ids.old_device,
  );
  const command = commandFor(issued.lease, 1);
  await replayOfflineCommand(pool, command, (client) =>
    insertDomainEffect(client, command),
  );

  for (const sql of [
    "UPDATE offline_command_audit SET reason = 'rewritten'",
    "DELETE FROM offline_command_audit",
    "TRUNCATE offline_command_audit",
  ]) {
    await assert.rejects(pool.query(sql), (error) => error.code === "42501");
  }
  const audit = await pool.query(
    "SELECT count(*)::int AS count, min(reason) AS reason FROM offline_command_audit",
  );
  assert.deepEqual(audit.rows[0], { count: 1, reason: "current-sequence" });
});
