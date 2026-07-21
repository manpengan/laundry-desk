import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import {
  canonicalizeCapabilityTicketForSigning,
  type CapabilityTicketPayload,
} from "@laundry/contracts";

import { bytesToBase64Url } from "./device-keys.js";
import { verifyCapabilityTicket } from "./verify-ticket.js";

const DEVICE_ID = "01a2eed0-a6c3-493c-a3a7-20bf94b1d678";
const OTHER_DEVICE = "11111111-1111-4111-8111-111111111111";
const ORIGIN = "https://desk.example.test";
const ISSUED = "2026-07-21T01:02:03.000Z";
const EXP = "2026-07-21T01:03:03.000Z";

function payload(overrides: Partial<CapabilityTicketPayload> = {}): CapabilityTicketPayload {
  return Object.freeze({
    action: "print_job",
    job_id: "936da01f-9abd-4d9d-80c7-02af85c822a8",
    staff_id: "d5a92f5a-653a-4b06-b014-e4a5e0d91f0c",
    device_id: DEVICE_ID,
    origin: ORIGIN,
    issued_at: ISSUED,
    exp: EXP,
    nonce: "9dfc4424-9b9a-4e52-baaa-c02868f8e7de",
    ...overrides,
  }) as CapabilityTicketPayload;
}

function signTicket(
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
  body: CapabilityTicketPayload,
  protocolVersion = "1.0.0",
): { protocol_version: string; payload: CapabilityTicketPayload; sig: string } {
  const authority = { protocol_version: protocolVersion, payload: body };
  const message = canonicalizeCapabilityTicketForSigning(authority);
  const sig = bytesToBase64Url(new Uint8Array(sign(null, message, privateKey)));
  return { protocol_version: protocolVersion, payload: body, sig };
}

const serverKeys = generateKeyPairSync("ed25519");
const nowInside = Date.parse(ISSUED) + 1_000;

test("accepts a well-formed server-signed capability ticket", () => {
  const wire = signTicket(serverKeys.privateKey, payload());
  const result = verifyCapabilityTicket(wire, {
    serverPublicKey: serverKeys.publicKey,
    deviceId: DEVICE_ID,
    allowedOrigins: [ORIGIN],
    nowMs: nowInside,
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.payload.nonce, wire.payload.nonce);
    assert.equal(result.protocolVersion, "1.0.0");
  }
});

test("rejects bad signature", () => {
  const wire = signTicket(serverKeys.privateKey, payload());
  const tampered = { ...wire, sig: bytesToBase64Url(new Uint8Array(64).fill(7)) };
  const result = verifyCapabilityTicket(tampered, {
    serverPublicKey: serverKeys.publicKey,
    deviceId: DEVICE_ID,
    allowedOrigins: [ORIGIN],
    nowMs: nowInside,
  });
  assert.deepEqual(result, { ok: false, error: "bad_signature" });
});

test("rejects expired ticket", () => {
  const wire = signTicket(serverKeys.privateKey, payload());
  const result = verifyCapabilityTicket(wire, {
    serverPublicKey: serverKeys.publicKey,
    deviceId: DEVICE_ID,
    allowedOrigins: [ORIGIN],
    nowMs: Date.parse(EXP),
  });
  assert.deepEqual(result, { ok: false, error: "expired" });
});

test("rejects wrong device audience", () => {
  const wire = signTicket(serverKeys.privateKey, payload());
  const result = verifyCapabilityTicket(wire, {
    serverPublicKey: serverKeys.publicKey,
    deviceId: OTHER_DEVICE,
    allowedOrigins: [ORIGIN],
    nowMs: nowInside,
  });
  assert.deepEqual(result, { ok: false, error: "wrong_device" });
});

test("rejects wrong origin audience", () => {
  const wire = signTicket(serverKeys.privateKey, payload());
  const result = verifyCapabilityTicket(wire, {
    serverPublicKey: serverKeys.publicKey,
    deviceId: DEVICE_ID,
    allowedOrigins: ["https://other.example.test"],
    nowMs: nowInside,
  });
  assert.deepEqual(result, { ok: false, error: "wrong_origin" });
});

test("rejects malformed envelope", () => {
  const result = verifyCapabilityTicket(
    { not: "a ticket" },
    {
      serverPublicKey: serverKeys.publicKey,
      deviceId: DEVICE_ID,
      allowedOrigins: [ORIGIN],
      nowMs: nowInside,
    },
  );
  assert.deepEqual(result, { ok: false, error: "malformed" });
});
