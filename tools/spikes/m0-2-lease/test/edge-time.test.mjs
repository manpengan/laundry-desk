import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import { authorizeOffline, createLeaseSession } from "../src/edge-time.mjs";
import { createLeaseSigner } from "../src/signing.mjs";

const signer = createLeaseSigner(generateKeyPairSync("ed25519"));
const leasePayload = Object.freeze({
  lease_id: "10000000-0000-4000-8000-000000000001",
  store_id: "20000000-0000-4000-8000-000000000001",
  device_id: "30000000-0000-4000-8000-000000000001",
  primary_epoch: 1,
  issued_at: "2026-07-19T00:00:00.000Z",
  ttl_ms: 100,
  max_clock_skew_ms: 10,
  not_after: "2026-07-19T00:00:00.100Z",
});
const lease = signer.sign(leasePayload);
const continuity = Object.freeze({
  bootId: "boot-a",
  processId: "process-a",
  wakeSequence: 1,
  wallMs: 1_000,
});

function startSession(overrides = {}) {
  const requestStartMonoMs = overrides.requestStartMonoMs ?? 10;
  const responseMonoMs = overrides.responseMonoMs ?? 20;
  const responseContinuity = overrides.continuity ?? continuity;
  const requestStartContinuity =
    overrides.requestStartContinuity ??
    Object.freeze({
      ...continuity,
      wallMs: responseContinuity.wallMs - (responseMonoMs - requestStartMonoMs),
    });
  return createLeaseSession({
    lease,
    requestStartMonoMs,
    responseMonoMs,
    safetyMarginMs: 10,
    requestStartContinuity,
    continuity: responseContinuity,
    verifyLease: signer.verify,
    ...overrides,
    requestStartMonoMs,
    responseMonoMs,
    requestStartContinuity,
    continuity: responseContinuity,
  });
}

test("request-start monotonic anchor rejects RTT at least TTL", () => {
  const result = startSession({ responseMonoMs: 110, safetyMarginMs: 5 });

  assert.equal(result.enabled, false);
  assert.equal(result.reason, "rtt-at-least-ttl");
});

test("near-TTL response never extends the signed server deadline", () => {
  const result = startSession({ responseMonoMs: 85 });

  assert.equal(result.enabled, true);
  assert.equal(result.session.localDeadlineMonoMs, 100);
  assert.ok(result.session.authorizedDurationMs <= lease.ttl_ms);
});

test("invalid safety margin fails closed instead of extending authority", () => {
  const negative = startSession({ safetyMarginMs: -1 });
  const excessive = startSession({ safetyMarginMs: 100 });

  assert.equal(negative.reason, "invalid-safety-margin");
  assert.equal(excessive.reason, "invalid-safety-margin");
});

test("signed issued_at, ttl and not_after must agree", () => {
  const inconsistentLease = signer.sign({
    ...leasePayload,
    not_after: "2026-07-19T00:00:00.101Z",
  });
  const result = startSession({ lease: inconsistentLease });

  assert.equal(result.enabled, false);
  assert.equal(result.reason, "signed-time-mismatch");
});

test("missing or tampered server signature fails closed", () => {
  const missing = startSession({ lease: { ...leasePayload } });
  const tampered = startSession({ lease: { ...lease, ttl_ms: 1_000 } });

  assert.equal(missing.reason, "invalid-lease-signature");
  assert.equal(tampered.reason, "invalid-lease-signature");
});

test("a signed lease still requires every authority field", () => {
  const missingDevice = signer.sign({ ...leasePayload, device_id: undefined });
  const invalidEpoch = signer.sign({ ...leasePayload, primary_epoch: 0 });

  assert.equal(
    startSession({ lease: missingDevice }).reason,
    "invalid-signed-lease",
  );
  assert.equal(
    startSession({ lease: invalidEpoch }).reason,
    "invalid-signed-lease",
  );
});

test("unprovable creation continuity fails closed", () => {
  const missingToken = startSession({
    continuity: { ...continuity, bootId: "" },
  });
  const invalidMono = startSession({ requestStartMonoMs: Number.NaN });
  const invalidWall = startSession({
    continuity: { ...continuity, wallMs: Number.NaN },
  });
  const missingRequestToken = startSession({
    requestStartContinuity: { ...continuity, processId: "" },
  });

  assert.equal(missingToken.reason, "continuity-unprovable");
  assert.equal(invalidMono.reason, "continuity-unprovable");
  assert.equal(invalidWall.reason, "continuity-unprovable");
  assert.equal(missingRequestToken.reason, "continuity-unprovable");
});

test("request crossing sleep or reboot cannot enable a lease", () => {
  const slept = startSession({
    requestStartContinuity: { ...continuity, wakeSequence: 0, wallMs: 990 },
  });
  const rebooted = startSession({
    requestStartContinuity: {
      ...continuity,
      bootId: "boot-before-request",
      wallMs: 990,
    },
  });

  assert.equal(slept.reason, "request-continuity-lost");
  assert.equal(rebooted.reason, "request-continuity-lost");
});

test("a continuity failure permanently invalidates the session", () => {
  const created = startSession();
  const failed = authorizeOffline(created.session, {
    ...continuity,
    monoMs: 30,
    wallMs: 400,
  });
  const retried = authorizeOffline(failed.session, {
    ...continuity,
    monoMs: 40,
    wallMs: 1_020,
  });

  assert.equal(failed.allowed, false);
  assert.equal(failed.session.invalidated, true);
  assert.equal(retried.allowed, false);
  assert.equal(retried.reason, "session-invalidated");
});

test("missing or non-finite observations fail closed", () => {
  const created = startSession();
  const missing = authorizeOffline(created.session, { monoMs: 30 });
  const invalid = authorizeOffline(created.session, {
    ...continuity,
    monoMs: Number.NaN,
    wallMs: 1_010,
  });

  assert.equal(missing.reason, "continuity-unprovable");
  assert.equal(invalid.reason, "continuity-unprovable");
});

for (const scenario of [
  ["wall-clock rollback", { monoMs: 30, wallMs: 400 }, "clock-discontinuity"],
  [
    "wall-clock forward jump",
    { monoMs: 30, wallMs: 2_000 },
    "clock-discontinuity",
  ],
  [
    "process restart",
    { monoMs: 30, processId: "process-b" },
    "process-changed",
  ],
  ["OS restart", { monoMs: 30, bootId: "boot-b" }, "boot-changed"],
  ["sleep/resume", { monoMs: 30, wakeSequence: 2 }, "wake-sequence-changed"],
  ["old primary lost past deadline", { monoMs: 100 }, "lease-expired"],
]) {
  test(`${scenario[0]} fails closed`, () => {
    const created = startSession();
    const observation = Object.freeze({
      ...continuity,
      wallMs: 1_010,
      ...scenario[1],
    });

    const result = authorizeOffline(created.session, observation);

    assert.equal(result.allowed, false);
    assert.equal(result.mode, "online-only");
    assert.equal(result.reason, scenario[2]);
  });
}
