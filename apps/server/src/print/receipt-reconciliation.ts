/**
 * Server-side verification for Edge device receipts. The transport boundary must
 * pass this `unknown` ingress verbatim; device identity comes from the mTLS/
 * paired Edge session, never from a browser supplied tenant context.
 */
import {
  canonicalizeForSignatureVerification,
  parseDeviceSignatureExecutionReceiptCandidate,
  type ExecutionReceiptPayload,
} from "@laundry/contracts";
import { verify, type KeyObject } from "node:crypto";
import { z } from "zod";

import type { PrintJobRecord, PrintJobStatus } from "./types.js";

const BASE64URL = /^[A-Za-z0-9_-]+$/u;

const PrintReceiptIngressSchema = z.strictObject({
  job_id: z.uuid(),
  device_id: z.uuid(),
  receipt: z.unknown(),
});

export type PrintReceiptIngress = Readonly<z.output<typeof PrintReceiptIngressSchema>>;

export type ReceiptBoundPrintJob = Readonly<{
  job_id: string;
  status: PrintJobStatus;
  ticket_nonce: string;
  device_id: string;
}>;

export type PrintReceiptStore = Readonly<{
  getReceiptBoundJob(jobId: string): Promise<ReceiptBoundPrintJob | null>;
  /** Must use an atomic `WHERE status='printing' AND ticket_nonce/device_id` update. */
  commitReceipt(
    input: Readonly<{
      job_id: string;
      device_id: string;
      ticket_nonce: string;
      status: "done" | "failed";
      receipt_at: string;
    }>,
  ): Promise<PrintJobRecord | null>;
}>;

export type DevicePublicKeyRegistry = Readonly<{
  getDevicePublicKey(deviceId: string): Promise<KeyObject | null>;
}>;

export type PrintReceiptReconciliationDeps = Readonly<{
  store: PrintReceiptStore;
  deviceKeys: DevicePublicKeyRegistry;
}>;

export type PrintReceiptReconciliationResult = Readonly<{
  job: PrintJobRecord;
  receipt: ExecutionReceiptPayload;
}>;

export class PrintReceiptReconciliationError extends Error {
  constructor(readonly code: "malformed" | "signature" | "binding" | "replayed") {
    super(`print receipt rejected: ${code}`);
  }
}

function decodeSignature(value: string): Uint8Array {
  if (!BASE64URL.test(value)) throw new PrintReceiptReconciliationError("malformed");
  return new Uint8Array(Buffer.from(value, "base64url"));
}

function parseIngress(value: unknown): PrintReceiptIngress {
  try {
    return PrintReceiptIngressSchema.parse(value);
  } catch {
    throw new PrintReceiptReconciliationError("malformed");
  }
}

function parseReceipt(value: unknown) {
  try {
    return parseDeviceSignatureExecutionReceiptCandidate(value);
  } catch {
    throw new PrintReceiptReconciliationError("malformed");
  }
}

function verifyReceiptSignature(receipt: unknown, key: KeyObject): ExecutionReceiptPayload {
  if (key.asymmetricKeyType !== "ed25519") {
    throw new PrintReceiptReconciliationError("signature");
  }
  const candidate = parseReceipt(receipt);
  const valid = verify(
    null,
    canonicalizeForSignatureVerification(candidate),
    key,
    decodeSignature(candidate.sig),
  );
  if (!valid) throw new PrintReceiptReconciliationError("signature");
  return candidate.payload;
}

function receiptStatus(result: ExecutionReceiptPayload["result"]): "done" | "failed" {
  return result === "succeeded" ? "done" : "failed";
}

function assertReceiptBinding(
  job: ReceiptBoundPrintJob,
  ingress: PrintReceiptIngress,
  receipt: ExecutionReceiptPayload,
): void {
  if (
    job.status !== "printing" ||
    job.device_id !== ingress.device_id ||
    job.ticket_nonce !== receipt.ticket_nonce
  ) {
    throw new PrintReceiptReconciliationError("binding");
  }
}

/**
 * Verify first, then atomically move exactly one `print_jobs` row to terminal.
 * A second delivery cannot update a completed job and is rejected as replayed.
 */
export async function reconcilePrintReceipt(
  rawIngress: unknown,
  deps: PrintReceiptReconciliationDeps,
): Promise<PrintReceiptReconciliationResult> {
  const ingress = parseIngress(rawIngress);
  const key = await deps.deviceKeys.getDevicePublicKey(ingress.device_id);
  if (key === null) throw new PrintReceiptReconciliationError("signature");
  const receipt = verifyReceiptSignature(ingress.receipt, key);
  const bound = await deps.store.getReceiptBoundJob(ingress.job_id);
  if (bound === null) throw new PrintReceiptReconciliationError("binding");
  assertReceiptBinding(bound, ingress, receipt);

  const job = await deps.store.commitReceipt({
    job_id: ingress.job_id,
    device_id: ingress.device_id,
    ticket_nonce: receipt.ticket_nonce,
    status: receiptStatus(receipt.result),
    receipt_at: receipt.at,
  });
  if (job === null) throw new PrintReceiptReconciliationError("replayed");
  return Object.freeze({ job, receipt });
}
