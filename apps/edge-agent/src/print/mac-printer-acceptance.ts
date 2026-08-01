import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { z } from "zod";

import { Sha256HexSchema } from "@laundry/contracts";

import { isCupsJobIdForQueue, isCupsQueueName } from "./cups-queue.js";
import { PrintDispatchLedger } from "./dispatch-ledger.js";

const SEMVER = /^(?:0|[1-9]\d{0,12})\.(?:0|[1-9]\d{0,12})\.(?:0|[1-9]\d{0,12})$/u;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export type MacPrinterOperatorConfirmation = Readonly<{
  chinese_clear: boolean;
  amounts_correct: boolean;
  feed_ok: boolean;
  cut_or_tear_ok: boolean;
  barcode_scanned: boolean;
  disconnect_no_duplicate: boolean;
  explicit_reprint_one_copy: boolean;
}>;

export type SignedPrintAcceptanceEvidence = Readonly<{
  job_id: string;
  snapshot_sha256: string;
  queue: string;
  cups_job_id: string;
  receipt_seq: number;
}>;

export type MacPrinterAcceptanceRecord = Readonly<{
  schema_version: 2;
  platform: "darwin";
  printer_family: "xp58";
  app_version: string;
  accepted_at: string;
  job_fingerprint: string;
  snapshot_sha256: string;
  queue_fingerprint: string;
  cups_job_fingerprint: string;
  receipt_seq: number;
  operator_confirmation: MacPrinterOperatorConfirmation;
}>;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isFullyConfirmed(confirmation: MacPrinterOperatorConfirmation): boolean {
  return (
    confirmation.chinese_clear === true &&
    confirmation.amounts_correct === true &&
    confirmation.feed_ok === true &&
    confirmation.cut_or_tear_ok === true &&
    confirmation.barcode_scanned === true &&
    confirmation.disconnect_no_duplicate === true &&
    confirmation.explicit_reprint_one_copy === true
  );
}

export async function loadSignedPrintAcceptanceEvidence(
  ledgerRoot: string,
  jobId: string,
): Promise<SignedPrintAcceptanceEvidence> {
  const parsedJobId = z.uuid().parse(jobId);
  const ledger = await PrintDispatchLedger.open(ledgerRoot);
  const entry = await ledger.get(parsedJobId);
  const receipt = entry?.receipt;
  if (
    entry === null ||
    entry.phase !== "receipt_uploaded" ||
    receipt === null ||
    receipt === undefined ||
    receipt.payload.result !== "succeeded" ||
    receipt.payload.cups_job_id === null ||
    !isCupsJobIdForQueue(entry.binding.queue, receipt.payload.cups_job_id)
  ) {
    throw new Error("uploaded successful signed print dispatch evidence is required");
  }
  return Object.freeze({
    job_id: entry.binding.jobId,
    snapshot_sha256: entry.binding.snapshotSha256,
    queue: entry.binding.queue,
    cups_job_id: receipt.payload.cups_job_id,
    receipt_seq: receipt.payload.seq,
  });
}

export function createMacPrinterAcceptanceRecord(
  evidence: SignedPrintAcceptanceEvidence,
  confirmation: MacPrinterOperatorConfirmation,
  appVersion: string,
  acceptedAt = new Date().toISOString(),
): MacPrinterAcceptanceRecord {
  if (
    !z.uuid().safeParse(evidence.job_id).success ||
    !Sha256HexSchema.safeParse(evidence.snapshot_sha256).success ||
    !isCupsQueueName(evidence.queue) ||
    !isCupsJobIdForQueue(evidence.queue, evidence.cups_job_id) ||
    !Number.isSafeInteger(evidence.receipt_seq) ||
    evidence.receipt_seq < 1
  ) {
    throw new Error("signed print dispatch evidence is invalid");
  }
  if (!isFullyConfirmed(confirmation)) throw new Error("all physical sample checks must pass");
  if (!SEMVER.test(appVersion)) throw new Error("app version must be exact semver");
  if (!ISO_UTC.test(acceptedAt) || Number.isNaN(Date.parse(acceptedAt))) {
    throw new Error("acceptance timestamp is invalid");
  }
  return Object.freeze({
    schema_version: 2,
    platform: "darwin",
    printer_family: "xp58",
    app_version: appVersion,
    accepted_at: acceptedAt,
    job_fingerprint: sha256(evidence.job_id),
    snapshot_sha256: evidence.snapshot_sha256,
    queue_fingerprint: sha256(evidence.queue),
    cups_job_fingerprint: sha256(evidence.cups_job_id),
    receipt_seq: evidence.receipt_seq,
    operator_confirmation: Object.freeze({
      chinese_clear: confirmation.chinese_clear,
      amounts_correct: confirmation.amounts_correct,
      feed_ok: confirmation.feed_ok,
      cut_or_tear_ok: confirmation.cut_or_tear_ok,
      barcode_scanned: confirmation.barcode_scanned,
      disconnect_no_duplicate: confirmation.disconnect_no_duplicate,
      explicit_reprint_one_copy: confirmation.explicit_reprint_one_copy,
    }),
  });
}

export async function writeMacPrinterAcceptanceRecord(
  directory: string,
  record: MacPrinterAcceptanceRecord,
): Promise<string> {
  if (!isAbsolute(directory) || resolve(directory) !== directory) {
    throw new Error("acceptance directory must be canonical and absolute");
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (await realpath(directory)) !== directory
  ) {
    throw new Error("acceptance directory must be a real private directory");
  }
  await chmod(directory, 0o700);
  const timestamp = record.accepted_at.replace(/[^0-9]/gu, "").slice(0, 17);
  const path = join(directory, `xp58-${timestamp}-${randomUUID()}.json`);
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return path;
}
