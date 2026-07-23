import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import {
  canonicalizeOfflineGrantForSigning,
  canonicalizePrimaryLeaseForSigning,
  createOfflineGrantRegistrySnapshot,
  type OfflineGrantPayload,
  type PrimaryLeasePayload,
} from "@laundry/contracts";

import { bytesToBase64Url } from "../pairing/device-keys.js";
import {
  OfflineAuthorizationGuard,
  type MonotonicClock,
  type OfflineAuthorityRequest,
} from "./primary-lease.js";

const ORG_ID = "01a2eed0-a6c3-493c-a3a7-20bf94b1d678";
const STORE_ID = "11a2eed0-a6c3-493c-a3a7-20bf94b1d678";
const STAFF_ID = "21a2eed0-a6c3-493c-a3a7-20bf94b1d678";
const DEVICE_ID = "31a2eed0-a6c3-493c-a3a7-20bf94b1d678";
const GRANT_ID = "41a2eed0-a6c3-493c-a3a7-20bf94b1d678";
const LEASE_ID = "51a2eed0-a6c3-493c-a3a7-20bf94b1d678";
const ISSUED_AT = "2026-07-21T01:02:03.000Z";
const NOT_AFTER = "2026-07-21T01:02:04.000Z";
const registrySnapshot = createOfflineGrantRegistrySnapshot();
const serverKeys = generateKeyPairSync("ed25519");

class FakeClock implements MonotonicClock {
  private isTrusted = true;

  constructor(private value = 100) {}

  nowMs(): number {
    return this.value;
  }

  continuity(): "trusted" | "uncertain" {
    return this.isTrusted ? "trusted" : "uncertain";
  }

  set(value: number): void {
    this.value = value;
  }

  setContinuity(value: "trusted" | "uncertain"): void {
    this.isTrusted = value === "trusted";
  }
}

function createGuard(clock: FakeClock, safetyMarginMs = 25): OfflineAuthorizationGuard {
  return new OfflineAuthorizationGuard({
    serverPublicKey: serverKeys.publicKey,
    registrySnapshot,
    orgId: ORG_ID,
    storeId: STORE_ID,
    staffId: STAFF_ID,
    deviceId: DEVICE_ID,
    clock,
    safetyMarginMs,
  });
}

function grantPayload(overrides: Partial<OfflineGrantPayload> = {}): OfflineGrantPayload {
  return Object.freeze({
    grant_id: GRANT_ID,
    org_id: ORG_ID,
    store_id: STORE_ID,
    staff_id: STAFF_ID,
    device_id: DEVICE_ID,
    permission_version: 1,
    allowed_commands: ["order.receive", "order.pickup", "payment.collect"],
    issued_at: ISSUED_AT,
    ttl_ms: 1_000,
    not_after: NOT_AFTER,
    ...overrides,
  }) as OfflineGrantPayload;
}

function leasePayload(overrides: Partial<PrimaryLeasePayload> = {}): PrimaryLeasePayload {
  return Object.freeze({
    lease_id: LEASE_ID,
    store_id: STORE_ID,
    device_id: DEVICE_ID,
    primary_epoch: 7,
    issued_at: ISSUED_AT,
    ttl_ms: 1_000,
    max_clock_skew_ms: 40,
    not_after: NOT_AFTER,
    ...overrides,
  }) as PrimaryLeasePayload;
}

function signedGrant(payload = grantPayload()) {
  const protocol_version = "1.0.0";
  const authority = { protocol_version, payload };
  const message = canonicalizeOfflineGrantForSigning(authority, registrySnapshot);
  return Object.freeze({
    ...authority,
    sig: bytesToBase64Url(new Uint8Array(sign(null, message, serverKeys.privateKey))),
  });
}

function signedLease(payload = leasePayload()) {
  const protocol_version = "1.0.0";
  const authority = { protocol_version, payload };
  const message = canonicalizePrimaryLeaseForSigning(authority);
  return Object.freeze({
    ...authority,
    sig: bytesToBase64Url(new Uint8Array(sign(null, message, serverKeys.privateKey))),
  });
}

function startedRequest(guard: OfflineAuthorizationGuard): OfflineAuthorityRequest {
  const result = guard.startAuthorityRequest();
  assert.equal(result.ok, true);
  return result.request;
}

function queueEnvelope(
  command: string,
  authorization:
    | Readonly<{ kind: "grant"; grant_id: string }>
    | Readonly<{
        kind: "primary_lease";
        grant_id: string;
        lease_id: string;
        primary_epoch: number;
        per_lease_seq: number;
      }>,
) {
  return {
    queue_envelope_version: 2,
    contracts_major: 0,
    queue_id: "61a2eed0-a6c3-493c-a3a7-20bf94b1d678",
    enqueued_at: ISSUED_AT,
    payload: {
      command,
      version: "0.2.0",
      mode: "direct",
      args: {},
      idempotency_key: "71a2eed0-a6c3-493c-a3a7-20bf94b1d678",
      dry_run: false,
    },
    authorization,
  };
}

function acceptGrant(
  guard: OfflineAuthorizationGuard,
  clock: FakeClock,
  wire = signedGrant(),
): void {
  const startedAtMs = clock.nowMs();
  const request = startedRequest(guard);
  clock.set(clock.nowMs() + 5);
  assert.deepEqual(guard.acceptOfflineGrant(wire, request), {
    ok: true,
    localDeadlineMonoMs: startedAtMs + 975,
  });
}

function acceptLease(guard: OfflineAuthorizationGuard, clock: FakeClock): void {
  const startedAtMs = clock.nowMs();
  const request = startedRequest(guard);
  clock.set(clock.nowMs() + 5);
  assert.deepEqual(guard.acceptPrimaryLease(signedLease(), request), {
    ok: true,
    localDeadlineMonoMs: startedAtMs + 960,
  });
}

test("accepts a signed grant with a request-start monotonic deadline", () => {
  const clock = new FakeClock(100);
  const guard = createGuard(clock);
  acceptGrant(guard, clock);

  const result = guard.authorizeQueueEnvelope(
    queueEnvelope("order.receive", { kind: "grant", grant_id: GRANT_ID }),
  );
  assert.deepEqual(result, {
    ok: true,
    command: "order.receive",
    mode: "grant",
    localDeadlineMonoMs: 1_075,
  });
});

test("requires the Primary lease for pickup and validates ordered per-lease sequence", () => {
  const clock = new FakeClock(100);
  const guard = createGuard(clock);
  acceptGrant(guard, clock);
  acceptLease(guard, clock);

  const missingLease = queueEnvelope("order.pickup", { kind: "grant", grant_id: GRANT_ID });
  assert.deepEqual(guard.authorizeQueueEnvelope(missingLease), {
    ok: false,
    error: "lease_required",
  });

  const first = queueEnvelope("order.pickup", {
    kind: "primary_lease",
    grant_id: GRANT_ID,
    lease_id: LEASE_ID,
    primary_epoch: 7,
    per_lease_seq: 1,
  });
  assert.equal(guard.authorizeQueueEnvelope(first).ok, true);
  const replayedLeaseRequest = startedRequest(guard);
  assert.deepEqual(guard.acceptPrimaryLease(signedLease(), replayedLeaseRequest), {
    ok: false,
    error: "authority_replayed",
  });
  assert.deepEqual(guard.authorizeQueueEnvelope(first), { ok: false, error: "sequence_replayed" });
  assert.deepEqual(
    guard.authorizeQueueEnvelope({
      ...first,
      authorization: { ...first.authorization, per_lease_seq: 3 },
    }),
    { ok: false, error: "sequence_out_of_order" },
  );
  assert.equal(
    guard.authorizeQueueEnvelope({
      ...first,
      payload: { ...first.payload, command: "payment.collect" },
      authorization: { ...first.authorization, per_lease_seq: 2 },
    }).ok,
    true,
  );
});

test("denies refund offline from the frozen contract metadata", () => {
  const clock = new FakeClock(100);
  const guard = createGuard(clock);
  acceptGrant(guard, clock);

  assert.deepEqual(
    guard.authorizeQueueEnvelope(
      queueEnvelope("payment.refund", { kind: "grant", grant_id: GRANT_ID }),
    ),
    { ok: false, error: "command_denied" },
  );
});

test("rejects bad signatures and authority for another paired device", () => {
  const clock = new FakeClock(100);
  const guard = createGuard(clock);
  const badRequest = startedRequest(guard);
  const badSignature = { ...signedGrant(), sig: bytesToBase64Url(new Uint8Array(64).fill(2)) };
  assert.deepEqual(guard.acceptOfflineGrant(badSignature, badRequest), {
    ok: false,
    error: "bad_signature",
  });

  const audienceRequest = startedRequest(guard);
  const foreignGrant = signedGrant(
    grantPayload({ device_id: "81a2eed0-a6c3-493c-a3a7-20bf94b1d678" }),
  );
  assert.deepEqual(guard.acceptOfflineGrant(foreignGrant, audienceRequest), {
    ok: false,
    error: "wrong_audience",
  });
});

test("fails closed when the response arrives too late for its signed lifetime", () => {
  const clock = new FakeClock(0);
  const guard = createGuard(clock, 0);
  const request = startedRequest(guard);
  clock.set(1_000);

  assert.deepEqual(guard.acceptOfflineGrant(signedGrant(), request), {
    ok: false,
    error: "deadline_elapsed",
  });
});

test("clears offline authority on suspend uncertainty and a monotonic reset", () => {
  const clock = new FakeClock(100);
  const guard = createGuard(clock);
  acceptGrant(guard, clock);
  guard.invalidateContinuity();

  assert.deepEqual(
    guard.authorizeQueueEnvelope(
      queueEnvelope("order.receive", { kind: "grant", grant_id: GRANT_ID }),
    ),
    { ok: false, error: "grant_required" },
  );

  clock.setContinuity("uncertain");
  assert.deepEqual(guard.startAuthorityRequest(), { ok: false, error: "untrusted_continuity" });
  clock.setContinuity("trusted");
  acceptGrant(
    guard,
    clock,
    signedGrant(grantPayload({ grant_id: "91a2eed0-a6c3-493c-a3a7-20bf94b1d678" })),
  );
  clock.set(1);
  assert.deepEqual(
    guard.authorizeQueueEnvelope(
      queueEnvelope("order.receive", { kind: "grant", grant_id: GRANT_ID }),
    ),
    { ok: false, error: "untrusted_continuity" },
  );
});
