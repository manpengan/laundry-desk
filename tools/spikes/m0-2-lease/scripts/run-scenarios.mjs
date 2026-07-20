import { generateKeyPairSync } from "node:crypto";

import pg from "pg";

import { authorizeOffline, createLeaseSession } from "../src/edge-time.mjs";
import { createLeaseService } from "../src/lease-service.mjs";
import { replayOfflineCommand } from "../src/replay.mjs";
import { createLeaseSigner, createReleaseAck } from "../src/signing.mjs";

const { Pool } = pg;
const ids = Object.freeze({
  org_id: "00000000-0000-4000-8000-000000000001",
  store_id: "10000000-0000-4000-8000-000000000001",
  device_a: "20000000-0000-4000-8000-000000000001",
  device_b: "20000000-0000-4000-8000-000000000002",
  device_c: "20000000-0000-4000-8000-000000000003",
});
const leaseKeys = generateKeyPairSync("ed25519");
const deviceKeys = generateKeyPairSync("ed25519");
const signer = createLeaseSigner(leaseKeys);
const pool = new Pool({
  connectionString: process.env.LEASE_DATABASE_URL,
  max: 10,
});
const adminPool = new Pool({
  connectionString: process.env.LEASE_ADMIN_DATABASE_URL,
  max: 2,
});

function result(scenario, expected, actual, pass, details = {}) {
  return Object.freeze({ scenario, expected, actual, pass, details });
}

function fakeClock(iso) {
  return Object.freeze({
    async now() {
      return new Date(iso);
    },
  });
}

function serviceAt(iso) {
  return createLeaseService({
    pool,
    signer,
    trustedClock: fakeClock(iso),
    getDevicePublicKey: (deviceId) =>
      deviceId === ids.device_a ? deviceKeys.publicKey : undefined,
  });
}

function promote(service, deviceId, ttl = 100, skew = 10) {
  return service.promote({
    org_id: ids.org_id,
    store_id: ids.store_id,
    device_id: deviceId,
    ttl_ms: ttl,
    max_clock_skew_ms: skew,
  });
}

async function resetStore() {
  await adminPool.query(
    `TRUNCATE replay_domain_effects, primary_lease_replay_state,
       offline_command_audit, primary_leases, primary_lease_heads`,
  );
  await adminPool.query(
    "INSERT INTO primary_lease_heads (org_id, store_id) VALUES ($1, $2)",
    [ids.org_id, ids.store_id],
  );
}

function edgeScenarios() {
  const lease = signer.sign({
    lease_id: "30000000-0000-4000-8000-000000000001",
    store_id: ids.store_id,
    device_id: ids.device_a,
    primary_epoch: 1,
    issued_at: "2026-07-19T00:00:00.000Z",
    ttl_ms: 100,
    max_clock_skew_ms: 10,
    not_after: "2026-07-19T00:00:00.100Z",
  });
  const continuity = Object.freeze({
    bootId: "boot-a",
    processId: "process-a",
    wakeSequence: 1,
    wallMs: 1_000,
  });
  const created = createLeaseSession({
    lease,
    requestStartMonoMs: 0,
    responseMonoMs: 10,
    safetyMarginMs: 10,
    requestStartContinuity: Object.freeze({
      ...continuity,
      wallMs: 990,
    }),
    continuity,
    verifyLease: signer.verify,
  });
  const cases = [
    ["clock-rollback", { monoMs: 20, wallMs: 400 }, "clock-discontinuity"],
    ["clock-forward", { monoMs: 20, wallMs: 2_000 }, "clock-discontinuity"],
    [
      "process-restart",
      { monoMs: 20, processId: "process-b" },
      "process-changed",
    ],
    ["os-restart", { monoMs: 20, bootId: "boot-b" }, "boot-changed"],
    ["sleep-resume", { monoMs: 20, wakeSequence: 2 }, "wake-sequence-changed"],
    ["old-primary-lost", { monoMs: 90, wallMs: 1_080 }, "lease-expired"],
  ];
  return cases.map(([name, changes, expected]) => {
    const observation = Object.freeze({
      ...continuity,
      monoMs: 20,
      wallMs: 1_010,
      ...changes,
    });
    const actual = authorizeOffline(created.session, observation);
    return result(name, expected, actual.reason, actual.reason === expected, {
      local_deadline_mono_ms: created.session.localDeadlineMonoMs,
      observation,
    });
  });
}

function rttScenarios() {
  const lease = signer.sign({
    lease_id: "30000000-0000-4000-8000-000000000002",
    store_id: ids.store_id,
    device_id: ids.device_a,
    primary_epoch: 1,
    issued_at: "2026-07-19T00:00:00.000Z",
    ttl_ms: 100,
    max_clock_skew_ms: 10,
    not_after: "2026-07-19T00:00:00.100Z",
  });
  const continuity = Object.freeze({
    bootId: "boot-a",
    processId: "process-a",
    wakeSequence: 1,
    wallMs: 1_000,
  });
  const long = createLeaseSession({
    lease,
    requestStartMonoMs: 0,
    responseMonoMs: 100,
    safetyMarginMs: 10,
    requestStartContinuity: Object.freeze({
      ...continuity,
      wallMs: 900,
    }),
    continuity,
    verifyLease: signer.verify,
  });
  const near = createLeaseSession({
    lease,
    requestStartMonoMs: 0,
    responseMonoMs: 85,
    safetyMarginMs: 10,
    requestStartContinuity: Object.freeze({
      ...continuity,
      wallMs: 915,
    }),
    continuity,
    verifyLease: signer.verify,
  });
  const requestSleep = createLeaseSession({
    lease,
    requestStartMonoMs: 0,
    responseMonoMs: 10,
    safetyMarginMs: 5,
    requestStartContinuity: Object.freeze({
      ...continuity,
      wakeSequence: 0,
      wallMs: 990,
    }),
    continuity,
    verifyLease: signer.verify,
  });
  return [
    result("rtt-at-least-ttl", "fail-closed", long.reason, !long.enabled, {
      rtt_ms: 100,
    }),
    result(
      "rtt-near-ttl",
      "deadline=90ms",
      `deadline=${near.session.localDeadlineMonoMs}ms`,
      near.enabled && near.session.localDeadlineMonoMs <= lease.ttl_ms,
      { rtt_ms: 85 },
    ),
    result(
      "request-crosses-sleep",
      "fail-closed",
      requestSleep.reason,
      !requestSleep.enabled &&
        requestSleep.reason === "request-continuity-lost",
    ),
  ];
}

async function concurrentPromotionScenario() {
  await resetStore();
  const service = serviceAt("2026-07-19T00:00:00.000Z");
  const responses = await Promise.all([
    promote(service, ids.device_a),
    promote(service, ids.device_b),
  ]);
  const issued = responses.filter((response) => response.status === "issued");
  const pids = responses.map((response) => response.diagnostics.backendPid);
  return [
    result(
      "concurrent-promotion",
      "exactly-one-issued",
      `${issued.length}-issued`,
      issued.length === 1 && new Set(pids).size === 2,
      { backend_pids: pids },
    ),
    result(
      "signed-lease-sample",
      "signed-authority-object",
      issued[0].lease,
      true,
    ),
  ];
}

async function noAckScenario() {
  await resetStore();
  const oldLease = await promote(
    serviceAt("2026-07-19T00:00:00.000Z"),
    ids.device_a,
  );
  const waiting = await promote(
    serviceAt("2026-07-19T00:00:00.109Z"),
    ids.device_b,
  );
  const issued = await promote(
    serviceAt("2026-07-19T00:00:00.110Z"),
    ids.device_b,
  );
  const threshold = Date.parse(oldLease.lease.not_after) + 10;
  const safe = Date.parse(issued.lease.issued_at) >= threshold;
  return result(
    "no-ack-wait",
    "online-only-until-not_after+skew",
    issued.status,
    waiting.status === "online-only" && safe,
    {
      old_not_after: oldLease.lease.not_after,
      max_clock_skew_ms: 10,
      waiting_at: "2026-07-19T00:00:00.109Z",
      issued_at: issued.lease.issued_at,
    },
  );
}

async function releaseScenarios() {
  await resetStore();
  const oldLease = await promote(
    serviceAt("2026-07-19T00:00:00.000Z"),
    ids.device_a,
  );
  const ack = createReleaseAck({
    privateKey: deviceKeys.privateKey,
    lease_id: oldLease.lease.lease_id,
    device_id: ids.device_a,
    primary_epoch: oldLease.lease.primary_epoch,
    nonce: "evidence-release",
  });
  await serviceAt("2026-07-19T00:00:00.010Z").release({
    org_id: ids.org_id,
    store_id: ids.store_id,
    ack,
  });
  const next = await promote(
    serviceAt("2026-07-19T00:00:00.010Z"),
    ids.device_b,
  );

  await resetStore();
  const raceOld = await promote(
    serviceAt("2026-07-19T00:00:01.000Z"),
    ids.device_a,
  );
  const raceAck = createReleaseAck({
    privateKey: deviceKeys.privateKey,
    lease_id: raceOld.lease.lease_id,
    device_id: ids.device_a,
    primary_epoch: raceOld.lease.primary_epoch,
    nonce: "evidence-race",
  });
  const raceService = serviceAt("2026-07-19T00:00:01.010Z");
  const outcomes = await Promise.allSettled([
    raceService.release({
      org_id: ids.org_id,
      store_id: ids.store_id,
      ack: raceAck,
    }),
    promote(raceService, ids.device_c),
  ]);
  const active = await pool.query(
    `SELECT count(*)::int AS count FROM primary_leases
     WHERE released_at IS NULL AND not_after > $1`,
    ["2026-07-19T00:00:01.010Z"],
  );
  return [
    result(
      "signed-release-ack",
      "immediate-epoch-increment",
      next.lease.primary_epoch,
      next.status === "issued" && next.lease.primary_epoch === 2,
    ),
    result(
      "release-promotion-race",
      "at-most-one-active",
      active.rows[0].count,
      outcomes[0].status === "fulfilled" && active.rows[0].count <= 1,
    ),
  ];
}

async function replayScenario() {
  await resetStore();
  const oldLease = await promote(
    serviceAt("2026-07-19T00:00:00.000Z"),
    ids.device_a,
  );
  await promote(serviceAt("2026-07-19T00:00:00.110Z"), ids.device_b);
  const replay = await replayOfflineCommand(
    pool,
    {
      org_id: ids.org_id,
      store_id: ids.store_id,
      lease_id: oldLease.lease.lease_id,
      primary_epoch: oldLease.lease.primary_epoch,
      per_lease_seq: 1,
      command_name: "order.pickup",
    },
    async () => {
      throw new Error("stale command reached domain mutation");
    },
  );
  const audit = await pool.query(
    `SELECT decision, reason, arbitration_required
     FROM offline_command_audit`,
  );
  return result(
    "old-epoch-replay",
    "audit+arbitrate+no-apply",
    replay.decision,
    replay.decision === "arbitrate" && audit.rows[0].arbitration_required,
    { audit: audit.rows[0] },
  );
}

async function main() {
  const results = [
    ...edgeScenarios(),
    ...rttScenarios(),
    ...(await concurrentPromotionScenario()),
    await noAckScenario(),
    ...(await releaseScenarios()),
    await replayScenario(),
  ];
  for (const item of results) console.log(JSON.stringify(item));
  if (results.some((item) => !item.pass)) process.exitCode = 1;
}

try {
  await main();
} finally {
  await Promise.all([pool.end(), adminPool.end()]);
}
