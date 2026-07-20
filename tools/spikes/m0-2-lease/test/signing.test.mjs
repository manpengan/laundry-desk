import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import {
  canonicalLeaseMessage,
  createLeaseSigner,
  createReleaseAck,
  verifyReleaseAck,
} from "../src/signing.mjs";

test("lease signature format has a versioned cross-runtime canonical message", () => {
  const payload = Object.freeze({
    lease_id: "10000000-0000-4000-8000-000000000001",
    store_id: "20000000-0000-4000-8000-000000000001",
    device_id: "30000000-0000-4000-8000-000000000001",
    primary_epoch: 7,
    issued_at: "2026-07-19T00:00:00.000Z",
    ttl_ms: 1_000,
    max_clock_skew_ms: 100,
    not_after: "2026-07-19T00:00:01.000Z",
  });

  assert.equal(
    canonicalLeaseMessage(payload),
    'laundry.primary-lease.v1\n{"lease_id":"10000000-0000-4000-8000-000000000001","store_id":"20000000-0000-4000-8000-000000000001","device_id":"30000000-0000-4000-8000-000000000001","primary_epoch":7,"issued_at":"2026-07-19T00:00:00.000Z","ttl_ms":1000,"max_clock_skew_ms":100,"not_after":"2026-07-19T00:00:01.000Z"}',
  );
});

test("signed lease covers not_after and all authority fields", () => {
  const keys = generateKeyPairSync("ed25519");
  const signer = createLeaseSigner(keys);
  const payload = Object.freeze({
    lease_id: "10000000-0000-4000-8000-000000000001",
    store_id: "20000000-0000-4000-8000-000000000001",
    device_id: "30000000-0000-4000-8000-000000000001",
    primary_epoch: 7,
    issued_at: "2026-07-19T00:00:00.000Z",
    ttl_ms: 1_000,
    max_clock_skew_ms: 100,
    not_after: "2026-07-19T00:00:01.000Z",
  });

  const signed = signer.sign(payload);

  assert.equal(signer.verify(signed), true);
  assert.equal(
    signer.verify({ ...signed, not_after: "2027-01-01T00:00:00.000Z" }),
    false,
  );
});

test("release ACK is device-signed and tamper evident", () => {
  const keys = generateKeyPairSync("ed25519");
  const ack = createReleaseAck({
    privateKey: keys.privateKey,
    lease_id: "10000000-0000-4000-8000-000000000001",
    device_id: "30000000-0000-4000-8000-000000000001",
    primary_epoch: 7,
    nonce: "release-once",
  });

  assert.equal(verifyReleaseAck(ack, keys.publicKey), true);
  assert.equal(
    verifyReleaseAck({ ...ack, primary_epoch: 8 }, keys.publicKey),
    false,
  );
});
