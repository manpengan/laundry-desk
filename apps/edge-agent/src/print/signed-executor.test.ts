import assert from "node:assert/strict";
import { generateKeyPairSync, sign, verify } from "node:crypto";
import test from "node:test";

import {
  canonicalizeCapabilityTicketForSigning,
  canonicalizeForSignatureVerification,
  parseDeviceSignatureExecutionReceiptCandidate,
  type CapabilityTicketPayload,
} from "@laundry/contracts";

import { bytesToBase64Url, base64UrlToBytes } from "../pairing/device-keys.js";
import { createMockSpool } from "./mock-spool.js";
import { createPrintJobStore, enqueuePrintJob } from "./print-jobs.js";
import { createSignedPrintExecutor } from "./signed-executor.js";
import { createMockUsbPort, type UsbPrintPort } from "./usb-port.js";

const DEVICE_ID = "01a2eed0-a6c3-493c-a3a7-20bf94b1d678";
const STAFF_ID = "d5a92f5a-653a-4b06-b014-e4a5e0d91f0c";
const ORIGIN = "https://desk.example.test";
const ISSUED = "2026-07-23T01:02:03.000Z";
const EXP = "2026-07-23T01:03:03.000Z";
const NOW = Date.parse(ISSUED) + 1_000;
const server = generateKeyPairSync("ed25519");
const device = generateKeyPairSync("ed25519");

function ticket(jobId: string, nonce: string): unknown {
  const payload: CapabilityTicketPayload = Object.freeze({
    action: "print_job",
    job_id: jobId,
    staff_id: STAFF_ID,
    device_id: DEVICE_ID,
    origin: ORIGIN,
    issued_at: ISSUED,
    exp: EXP,
    nonce,
  });
  const authority = Object.freeze({ protocol_version: "1.0.0", payload });
  return Object.freeze({
    ...authority,
    sig: bytesToBase64Url(
      new Uint8Array(
        sign(null, canonicalizeCapabilityTicketForSigning(authority), server.privateKey),
      ),
    ),
  });
}

function executor() {
  return createSignedPrintExecutor({
    ticketContext: {
      serverPublicKey: server.publicKey,
      deviceId: DEVICE_ID,
      allowedOrigins: [ORIGIN],
      nowMs: NOW,
    },
    devicePrivateKey: device.privateKey,
  });
}

test("signed print verifies its ticket and signs the terminal receipt", async () => {
  const nonce = "9dfc4424-9b9a-4e52-baaa-c02868f8e7de";
  const jobId = "936da01f-9abd-4d9d-80c7-02af85c822a8";
  const { store, job } = enqueuePrintJob(createPrintJobStore(), "xp58", NOW, nonce, jobId);
  const result = await executor().execute({
    capabilityTicket: ticket(job.id, nonce),
    store,
    spool: createMockSpool(),
    jobId,
    executeOptions: { now: NOW, usbPort: createMockUsbPort() },
  });

  assert.equal(result.execution.job.status, "done");
  const candidate = parseDeviceSignatureExecutionReceiptCandidate(result.receipt);
  assert.equal(
    verify(
      null,
      canonicalizeForSignatureVerification(candidate),
      device.publicKey,
      base64UrlToBytes(result.receipt.sig),
    ),
    true,
  );
});

test("signed print rejects wrong job, altered tickets and one-time ticket replay", async () => {
  const nonce = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const jobId = "11111111-1111-4111-8111-111111111111";
  const { store } = enqueuePrintJob(createPrintJobStore(), "gp3120", NOW, nonce, jobId);
  const signedExecutor = executor();
  const valid = ticket(jobId, nonce) as Readonly<{ sig: string }>;

  await assert.rejects(
    () =>
      signedExecutor.execute({
        capabilityTicket: valid,
        store,
        spool: createMockSpool(),
        jobId: "22222222-2222-4222-8222-222222222222",
      }),
    /wrong_job/u,
  );
  await assert.rejects(
    () =>
      signedExecutor.execute({
        capabilityTicket: { ...valid, sig: "A".repeat(86) },
        store,
        spool: createMockSpool(),
        jobId,
      }),
    /bad_signature/u,
  );

  await signedExecutor.execute({ capabilityTicket: valid, store, spool: createMockSpool(), jobId });
  await assert.rejects(
    () =>
      signedExecutor.execute({ capabilityTicket: valid, store, spool: createMockSpool(), jobId }),
    /job_not_queued|replayed/u,
  );
});

test("same serial port executes in order while failures do not block the next ticket", async () => {
  const events: string[] = [];
  let writes = 0;
  const port: UsbPrintPort = {
    kind: "usb",
    serialKey: "device:dl206-1",
    write: async () => {
      writes += 1;
      events.push(`write:${writes}`);
      if (writes === 1) throw new Error("paper out");
    },
  };
  const firstNonce = "11111111-aaaa-4aaa-8aaa-111111111111";
  const secondNonce = "22222222-bbbb-4bbb-8bbb-222222222222";
  const firstId = "33333333-3333-4333-8333-333333333333";
  const secondId = "44444444-4444-4444-8444-444444444444";
  const first = enqueuePrintJob(createPrintJobStore(), "dl206", NOW, firstNonce, firstId);
  const second = enqueuePrintJob(first.store, "dl206", NOW, secondNonce, secondId);
  const signedExecutor = executor();
  const [failed, succeeded] = await Promise.all([
    signedExecutor.execute({
      capabilityTicket: ticket(firstId, firstNonce),
      store: second.store,
      spool: createMockSpool(),
      jobId: firstId,
      executeOptions: { usbPort: port },
    }),
    signedExecutor.execute({
      capabilityTicket: ticket(secondId, secondNonce),
      store: second.store,
      spool: createMockSpool(),
      jobId: secondId,
      executeOptions: { usbPort: port },
    }),
  ]);
  assert.equal(failed.execution.job.status, "failed");
  assert.equal(succeeded.execution.job.status, "done");
  assert.deepEqual(events, ["write:1", "write:2"]);
});
