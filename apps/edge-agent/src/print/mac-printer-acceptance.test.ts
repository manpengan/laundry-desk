import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createMacPrinterAcceptanceRecord,
  loadSignedPrintAcceptanceEvidence,
  writeMacPrinterAcceptanceRecord,
  type SignedPrintAcceptanceEvidence,
} from "./mac-printer-acceptance.js";
import { APP_CAPABILITY_ORIGIN } from "../lib/security-prefs.js";
import { signReceipt } from "../pairing/sign-receipt.js";
import { PrintDispatchLedger } from "./dispatch-ledger.js";

const evidence: SignedPrintAcceptanceEvidence = {
  job_id: "936da01f-9abd-4d9d-80c7-02af85c822a8",
  snapshot_sha256: "a".repeat(64),
  queue: "Store_XP58",
  cups_job_id: "Store_XP58-42",
  receipt_seq: 7,
};
const confirmed = {
  chinese_clear: true,
  amounts_correct: true,
  feed_ok: true,
  cut_or_tear_ok: true,
  barcode_scanned: true,
  disconnect_no_duplicate: true,
  explicit_reprint_one_copy: true,
};

test("physical acceptance stores fingerprints and requires every operator check", () => {
  const record = createMacPrinterAcceptanceRecord(
    evidence,
    confirmed,
    "0.1.0",
    "2026-07-30T08:00:00.000Z",
  );
  assert.match(record.queue_fingerprint, /^[0-9a-f]{64}$/u);
  assert.match(record.cups_job_fingerprint, /^[0-9a-f]{64}$/u);
  assert.equal(JSON.stringify(record).includes("Store_XP58"), false);
  assert.equal(JSON.stringify(record).includes(evidence.job_id), false);
  assert.equal(record.snapshot_sha256, evidence.snapshot_sha256);
  assert.equal(record.receipt_seq, 7);
  assert.throws(
    () =>
      createMacPrinterAcceptanceRecord(evidence, { ...confirmed, barcode_scanned: false }, "0.1.0"),
    /all physical sample checks/u,
  );
});

test("acceptance record is create-only in a private canonical directory", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "laundry-printer-acceptance-"));
  t.after(async () => {
    await rm(root, { recursive: true });
  });
  const directory = join(await realpath(root), "records");
  const record = createMacPrinterAcceptanceRecord(
    evidence,
    confirmed,
    "0.1.0",
    "2026-07-30T08:00:00.000Z",
  );
  const path = await writeMacPrinterAcceptanceRecord(directory, record);
  const metadata = await lstat(path);
  assert.equal(metadata.mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), record);
  await assert.rejects(
    () => writeMacPrinterAcceptanceRecord("relative", record),
    /canonical and absolute/u,
  );
});

test("formal evidence loads only after the exact signed receipt is uploaded", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "laundry-printer-evidence-"));
  t.after(async () => rm(root, { recursive: true }));
  const ledger = await PrintDispatchLedger.open(root);
  await ledger.prepare({
    jobId: evidence.job_id,
    deviceId: "01a2eed0-a6c3-493c-a3a7-20bf94b1d678",
    staffId: "d5a92f5a-653a-4b06-b014-e4a5e0d91f0c",
    origin: APP_CAPABILITY_ORIGIN,
    ticketNonce: "9dfc4424-9b9a-4e52-baaa-c02868f8e7de",
    printerKind: "xp58",
    snapshotSha256: evidence.snapshot_sha256,
    capabilitySha256: "b".repeat(64),
    expectedReceiptSeq: 1,
    queue: evidence.queue,
  });
  await ledger.markSubmitting(evidence.job_id);
  const keys = generateKeyPairSync("ed25519");
  const pending = await ledger.persistReceipt(evidence.job_id, (sequence) =>
    signReceipt(
      {
        job_id: evidence.job_id,
        device_id: "01a2eed0-a6c3-493c-a3a7-20bf94b1d678",
        ticket_nonce: "9dfc4424-9b9a-4e52-baaa-c02868f8e7de",
        snapshot_sha256: evidence.snapshot_sha256,
        result: "succeeded",
        cups_job_id: evidence.cups_job_id,
        seq: sequence,
        at: "2026-07-30T07:59:59.000Z",
      },
      keys.privateKey,
    ),
  );
  if (pending.receipt === null) throw new Error("receipt fixture failed");
  await assert.rejects(
    () => loadSignedPrintAcceptanceEvidence(root, evidence.job_id),
    /uploaded successful/u,
  );

  await ledger.markUploaded(evidence.job_id, pending.receipt);
  assert.deepEqual(await loadSignedPrintAcceptanceEvidence(root, evidence.job_id), {
    ...evidence,
    receipt_seq: 1,
  });
});
