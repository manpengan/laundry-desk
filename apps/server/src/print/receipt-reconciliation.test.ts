import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import { canonicalizeExecutionReceiptForSigning } from "@laundry/contracts";

import type { PrintJobRecord } from "./types.js";
import {
  reconcilePrintReceipt,
  type PrintReceiptStore,
  PrintReceiptReconciliationError,
} from "./receipt-reconciliation.js";

const DEVICE_ID = "01a2eed0-a6c3-493c-a3a7-20bf94b1d678";
const JOB_ID = "936da01f-9abd-4d9d-80c7-02af85c822a8";
const NONCE = "9dfc4424-9b9a-4e52-baaa-c02868f8e7de";
const keys = generateKeyPairSync("ed25519");

function job(status: "done" | "failed"): PrintJobRecord {
  return Object.freeze({
    job_id: JOB_ID,
    kind: "xp58",
    status,
    order_id: "11111111-1111-4111-8111-111111111111",
    ticket_no: "T20260723",
    created_at: 1,
    updated_at: 2,
  });
}

function store(): PrintReceiptStore {
  let committed = false;
  return Object.freeze({
    getReceiptBoundJob: async () =>
      Object.freeze({
        job_id: JOB_ID,
        status: committed ? ("done" as const) : ("printing" as const),
        ticket_nonce: NONCE,
        device_id: DEVICE_ID,
      }),
    commitReceipt: async (input) => {
      if (committed || input.ticket_nonce !== NONCE || input.device_id !== DEVICE_ID) return null;
      committed = true;
      return job(input.status);
    },
  });
}

function ingress(result: "succeeded" | "failed" = "succeeded") {
  return Object.freeze({
    job_id: JOB_ID,
    device_id: DEVICE_ID,
    receipt: signedReceipt({ ticket_nonce: NONCE, result, seq: 1, at: "2026-07-23T01:02:04.000Z" }),
  });
}

function signedReceipt(
  payload: Readonly<{
    ticket_nonce: string;
    result: "succeeded" | "failed";
    seq: number;
    at: string;
  }>,
) {
  const authority = Object.freeze({ protocol_version: "1.0.0", payload });
  return Object.freeze({
    ...authority,
    sig: sign(null, canonicalizeExecutionReceiptForSigning(authority), keys.privateKey).toString(
      "base64url",
    ),
  });
}

function deps(receipts: PrintReceiptStore) {
  return Object.freeze({
    store: receipts,
    deviceKeys: Object.freeze({ getDevicePublicKey: async () => keys.publicKey }),
  });
}

test("server only terminalizes print_jobs from a verified, bound Edge receipt", async () => {
  const result = await reconcilePrintReceipt(ingress(), deps(store()));
  assert.equal(result.job.status, "done");
  assert.equal(result.receipt.result, "succeeded");
});

test("server rejects altered signature, wrong nonce and a replayed receipt", async () => {
  const receipts = store();
  const altered = ingress();
  await assert.rejects(
    () =>
      reconcilePrintReceipt(
        { ...altered, receipt: { ...altered.receipt, sig: "A".repeat(86) } },
        deps(receipts),
      ),
    (error: unknown) =>
      error instanceof PrintReceiptReconciliationError && error.code === "signature",
  );
  const wrongNonce = signedReceipt({
    ticket_nonce: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    result: "succeeded",
    seq: 1,
    at: "2026-07-23T01:02:04.000Z",
  });
  await assert.rejects(
    () =>
      reconcilePrintReceipt(
        { job_id: JOB_ID, device_id: DEVICE_ID, receipt: wrongNonce },
        deps(receipts),
      ),
    (error: unknown) =>
      error instanceof PrintReceiptReconciliationError && error.code === "binding",
  );
  await reconcilePrintReceipt(ingress("failed"), deps(receipts));
  await assert.rejects(
    () => reconcilePrintReceipt(ingress("failed"), deps(receipts)),
    (error: unknown) =>
      error instanceof PrintReceiptReconciliationError && error.code === "binding",
  );
});
