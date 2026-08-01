import assert from "node:assert/strict";
import { verify } from "node:crypto";
import test from "node:test";

import {
  canonicalizeForSignatureVerification,
  parseDeviceSignatureExecutionReceiptCandidate,
  type ExecutionReceiptPayload,
} from "@laundry/contracts";

import { MemoryDeviceKeyStore, base64UrlToBytes } from "./device-keys.js";
import { EDGE_SIGNED_PROTOCOL_VERSION, signReceipt } from "./sign-receipt.js";

const receiptPayload: ExecutionReceiptPayload = Object.freeze({
  job_id: "936da01f-9abd-4d9d-80c7-02af85c822a8",
  device_id: "01a2eed0-a6c3-493c-a3a7-20bf94b1d678",
  ticket_nonce: "9dfc4424-9b9a-4e52-baaa-c02868f8e7de",
  snapshot_sha256: "a".repeat(64),
  result: "succeeded",
  cups_job_id: "xp58-local-42",
  seq: 1,
  at: "2026-07-21T01:02:04.000Z",
});

test("signReceipt round-trip verifies with device public key", () => {
  const store = new MemoryDeviceKeyStore();
  const material = store.generate();
  const signed = signReceipt(receiptPayload, material.privateKey);

  assert.equal(signed.protocol_version, EDGE_SIGNED_PROTOCOL_VERSION);
  assert.equal(signed.payload.ticket_nonce, receiptPayload.ticket_nonce);
  assert.match(signed.sig, /^[A-Za-z0-9_-]+$/u);

  const candidate = parseDeviceSignatureExecutionReceiptCandidate(signed);
  const message = canonicalizeForSignatureVerification(candidate);
  const ok = verify(null, message, material.publicKey, base64UrlToBytes(signed.sig));
  assert.equal(ok, true);

  const altered = parseDeviceSignatureExecutionReceiptCandidate({
    ...signed,
    payload: { ...signed.payload, snapshot_sha256: "b".repeat(64) },
  });
  assert.equal(
    verify(
      null,
      canonicalizeForSignatureVerification(altered),
      material.publicKey,
      base64UrlToBytes(signed.sig),
    ),
    false,
  );
});

test("signReceipt fails closed for non-ed25519 keys", async () => {
  const { generateKeyPairSync } = await import("node:crypto");
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  assert.throws(() => signReceipt(receiptPayload, rsa.privateKey), /Ed25519/u);
});
