import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import test from "node:test";

import { canonicalizeCapabilityTicketForSigning } from "@laundry/contracts";

import { signPrintCapabilityTicket } from "./capability-ticket.js";

const keys = generateKeyPairSync("ed25519");
const payload = Object.freeze({
  action: "print_job",
  job_id: "936da01f-9abd-4d9d-80c7-02af85c822a8",
  staff_id: "d5a92f5a-653a-4b06-b014-e4a5e0d91f0c",
  device_id: "01a2eed0-a6c3-493c-a3a7-20bf94b1d678",
  origin: "https://desk.example.test",
  issued_at: "2026-07-23T01:02:03.000Z",
  exp: "2026-07-23T01:03:03.000Z",
  nonce: "9dfc4424-9b9a-4e52-baaa-c02868f8e7de",
});

test("server signs the exact print capability authority", () => {
  const ticket = signPrintCapabilityTicket(payload, keys.privateKey);
  assert.equal(ticket.protocol_version, "1.0.0");
  assert.equal(ticket.payload.job_id, payload.job_id);
  assert.equal(
    verify(
      null,
      canonicalizeCapabilityTicketForSigning({
        protocol_version: ticket.protocol_version,
        payload: ticket.payload,
      }),
      keys.publicKey,
      Buffer.from(ticket.sig, "base64url"),
    ),
    true,
  );
});

test("server refuses non-Ed25519 signing keys and malformed payloads", () => {
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  assert.throws(() => signPrintCapabilityTicket(payload, rsa.privateKey), /Ed25519/u);
  assert.throws(() =>
    signPrintCapabilityTicket({ ...payload, nonce: "not-a-uuid" }, keys.privateKey),
  );
});
