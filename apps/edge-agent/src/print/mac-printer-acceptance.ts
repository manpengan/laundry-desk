import { createHash } from "node:crypto";

import { z } from "zod";

import { Sha256HexSchema } from "@laundry/contracts";

import { isCupsJobIdForQueue, isCupsQueueName } from "./cups-queue.js";
import { PrintDispatchLedger, type DispatchLedgerEntry } from "./dispatch-ledger.js";

const SEMVER = /^(?:0|[1-9]\d{0,12})\.(?:0|[1-9]\d{0,12})\.(?:0|[1-9]\d{0,12})$/u;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const PRINTER_MODEL = /^[^\u0000-\u001f\u007f-\u009f\u2028\u2029]{1,80}$/u;
const OperatorConfirmationSchema = z.strictObject({
  chinese_clear: z.literal(true),
  amounts_correct: z.literal(true),
  feed_ok: z.literal(true),
  cut_or_tear_ok: z.literal(true),
  barcode_scanned: z.literal(true),
  disconnect_no_duplicate: z.literal(true),
  explicit_reprint_one_copy: z.literal(true),
});

export const MAC_PRINTER_CONNECTIONS = ["usb", "ethernet", "wifi"] as const;
export type MacPrinterConnection = (typeof MAC_PRINTER_CONNECTIONS)[number];

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
  printer_kind: "xp58";
  print_action: "enqueue" | "retry" | "reprint";
  source_job_id: string | null;
  cups_job_id: string | null;
  receipt_seq: number;
  result: "succeeded" | "failed" | "uncertain";
}>;

export type MacPrinterAcceptanceEvidence = Readonly<{
  original: SignedPrintAcceptanceEvidence;
  disconnect_attempt: SignedPrintAcceptanceEvidence;
  explicit_reprint: SignedPrintAcceptanceEvidence;
}>;

export type PackagedMacAppEvidence = Readonly<{
  bundle_identifier: "com.laundry-desk.v2";
  bundle_name: "laundry-desk V2";
  bundle_executable: "laundry-desk V2";
  app_version: string;
  app_asar_sha256: string;
  spa_manifest_sha256: string;
  info_plist_sha256: string;
}>;

type FingerprintedDispatchEvidence = Readonly<{
  job_fingerprint: string;
  print_action: "enqueue" | "retry" | "reprint";
  source_job_fingerprint: string | null;
  cups_job_fingerprint: string | null;
  receipt_seq: number;
  result: "succeeded" | "failed" | "uncertain";
}>;

export type MacPrinterAcceptanceRecord = Readonly<{
  schema_version: 3;
  platform: "darwin";
  printer_family: "xp58";
  printer_model: string;
  connection: MacPrinterConnection;
  app_version: string;
  accepted_at: string;
  packaged_app: PackagedMacAppEvidence;
  print_flow: Readonly<{
    snapshot_sha256: string;
    queue_fingerprint: string;
    original: FingerprintedDispatchEvidence;
    disconnect_attempt: FingerprintedDispatchEvidence;
    explicit_reprint: FingerprintedDispatchEvidence;
  }>;
  operator_confirmation: MacPrinterOperatorConfirmation;
}>;

export type CreateMacPrinterAcceptanceRecordOptions = Readonly<{
  printerModel: string;
  connection: MacPrinterConnection;
  packagedApp: PackagedMacAppEvidence;
  acceptedAt?: string;
}>;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function fingerprint(kind: "job" | "queue" | "cups-job", value: string): string {
  return sha256(`laundry-printer-acceptance:v3:${kind}\0${value}`);
}

export function isValidMacPrinterModel(value: string): boolean {
  return value.trim() === value && PRINTER_MODEL.test(value);
}

export function isMacPrinterConnection(value: string): value is MacPrinterConnection {
  return (MAC_PRINTER_CONNECTIONS as readonly string[]).includes(value);
}

function isFullyConfirmed(confirmation: MacPrinterOperatorConfirmation): boolean {
  return OperatorConfirmationSchema.safeParse(confirmation).success;
}

function requireUploadedReceipt(entry: DispatchLedgerEntry | null): SignedPrintAcceptanceEvidence {
  if (
    entry === null ||
    entry.phase !== "receipt_uploaded" ||
    entry.receipt === null ||
    entry.binding.printerKind !== "xp58" ||
    entry.binding.printAction === "unknown"
  ) {
    throw new Error("three uploaded device-signed print receipts are required");
  }
  const payload = entry.receipt.payload;
  return Object.freeze({
    job_id: entry.binding.jobId,
    snapshot_sha256: entry.binding.snapshotSha256,
    queue: entry.binding.queue,
    printer_kind: entry.binding.printerKind,
    print_action: entry.binding.printAction,
    source_job_id: entry.binding.sourceJobId,
    cups_job_id: payload.cups_job_id,
    receipt_seq: payload.seq,
    result: payload.result,
  });
}

function assertEvidenceItem(evidence: SignedPrintAcceptanceEvidence): void {
  if (
    !z.uuid().safeParse(evidence.job_id).success ||
    !Sha256HexSchema.safeParse(evidence.snapshot_sha256).success ||
    !isCupsQueueName(evidence.queue) ||
    evidence.printer_kind !== "xp58" ||
    !["enqueue", "retry", "reprint"].includes(evidence.print_action) ||
    (evidence.source_job_id !== null && !z.uuid().safeParse(evidence.source_job_id).success) ||
    !Number.isSafeInteger(evidence.receipt_seq) ||
    evidence.receipt_seq < 1
  ) {
    throw new Error("signed print dispatch evidence is invalid");
  }
}

function assertAcceptanceFlow(evidence: MacPrinterAcceptanceEvidence): void {
  const entries = [evidence.original, evidence.disconnect_attempt, evidence.explicit_reprint];
  entries.forEach(assertEvidenceItem);
  if (new Set(entries.map((entry) => entry.job_id)).size !== entries.length) {
    throw new Error("acceptance print jobs must be distinct");
  }
  if (
    evidence.original.print_action !== "enqueue" ||
    evidence.original.source_job_id !== null ||
    evidence.disconnect_attempt.print_action !== "reprint" ||
    evidence.disconnect_attempt.source_job_id !== evidence.original.job_id ||
    evidence.explicit_reprint.print_action !== "retry" ||
    evidence.explicit_reprint.source_job_id !== evidence.disconnect_attempt.job_id
  ) {
    throw new Error("acceptance print jobs do not prove the required job lineage");
  }
  if (
    entries.some(
      (entry) =>
        entry.snapshot_sha256 !== evidence.original.snapshot_sha256 ||
        entry.queue !== evidence.original.queue,
    )
  ) {
    throw new Error("acceptance print jobs must share one snapshot and queue");
  }
  if (
    evidence.original.result !== "succeeded" ||
    evidence.original.cups_job_id === null ||
    !isCupsJobIdForQueue(evidence.original.queue, evidence.original.cups_job_id) ||
    (evidence.disconnect_attempt.result !== "failed" &&
      evidence.disconnect_attempt.result !== "uncertain") ||
    evidence.disconnect_attempt.cups_job_id !== null ||
    evidence.explicit_reprint.result !== "succeeded" ||
    evidence.explicit_reprint.cups_job_id === null ||
    !isCupsJobIdForQueue(evidence.explicit_reprint.queue, evidence.explicit_reprint.cups_job_id)
  ) {
    throw new Error("acceptance print outcomes do not prove the required physical flow");
  }
  if (
    evidence.original.receipt_seq >= evidence.disconnect_attempt.receipt_seq ||
    evidence.disconnect_attempt.receipt_seq >= evidence.explicit_reprint.receipt_seq
  ) {
    throw new Error("acceptance receipt sequences must be strictly increasing");
  }
  if (evidence.original.cups_job_id === evidence.explicit_reprint.cups_job_id) {
    throw new Error("successful acceptance CUPS jobs must be distinct");
  }
}

export async function loadMacPrinterAcceptanceEvidence(
  ledgerRoot: string,
  jobIds: Readonly<{ original: string; disconnect: string; reprint: string }>,
): Promise<MacPrinterAcceptanceEvidence> {
  const ids = [jobIds.original, jobIds.disconnect, jobIds.reprint];
  if (ids.some((jobId) => !z.uuid().safeParse(jobId).success) || new Set(ids).size !== ids.length) {
    throw new Error("three distinct print job UUIDs are required");
  }
  const ledger = await PrintDispatchLedger.open(ledgerRoot);
  const [original, disconnectAttempt, explicitReprint] = await Promise.all(
    ids.map(async (jobId) => requireUploadedReceipt(await ledger.get(jobId))),
  );
  const evidence = Object.freeze({
    original: original!,
    disconnect_attempt: disconnectAttempt!,
    explicit_reprint: explicitReprint!,
  });
  assertAcceptanceFlow(evidence);
  return evidence;
}

function fingerprintEvidence(
  evidence: SignedPrintAcceptanceEvidence,
): FingerprintedDispatchEvidence {
  return Object.freeze({
    job_fingerprint: fingerprint("job", evidence.job_id),
    print_action: evidence.print_action,
    source_job_fingerprint:
      evidence.source_job_id === null ? null : fingerprint("job", evidence.source_job_id),
    cups_job_fingerprint:
      evidence.cups_job_id === null ? null : fingerprint("cups-job", evidence.cups_job_id),
    receipt_seq: evidence.receipt_seq,
    result: evidence.result,
  });
}

export function createMacPrinterAcceptanceRecord(
  evidence: MacPrinterAcceptanceEvidence,
  confirmation: MacPrinterOperatorConfirmation,
  options: CreateMacPrinterAcceptanceRecordOptions,
): MacPrinterAcceptanceRecord {
  assertAcceptanceFlow(evidence);
  if (!isFullyConfirmed(confirmation)) throw new Error("all physical sample checks must pass");
  if (!isValidMacPrinterModel(options.printerModel)) {
    throw new Error("printer model must be 1-80 trimmed characters without controls");
  }
  if (!isMacPrinterConnection(options.connection)) throw new Error("printer connection is invalid");
  if (
    options.packagedApp.bundle_identifier !== "com.laundry-desk.v2" ||
    options.packagedApp.bundle_name !== "laundry-desk V2" ||
    options.packagedApp.bundle_executable !== "laundry-desk V2" ||
    !SEMVER.test(options.packagedApp.app_version) ||
    !Sha256HexSchema.safeParse(options.packagedApp.app_asar_sha256).success ||
    !Sha256HexSchema.safeParse(options.packagedApp.spa_manifest_sha256).success ||
    !Sha256HexSchema.safeParse(options.packagedApp.info_plist_sha256).success
  ) {
    throw new Error("packaged app evidence is invalid");
  }
  const acceptedAt = options.acceptedAt ?? new Date().toISOString();
  if (!ISO_UTC.test(acceptedAt) || Number.isNaN(Date.parse(acceptedAt))) {
    throw new Error("acceptance timestamp is invalid");
  }
  return Object.freeze({
    schema_version: 3,
    platform: "darwin",
    printer_family: "xp58",
    printer_model: options.printerModel,
    connection: options.connection,
    app_version: options.packagedApp.app_version,
    accepted_at: acceptedAt,
    packaged_app: Object.freeze({ ...options.packagedApp }),
    print_flow: Object.freeze({
      snapshot_sha256: evidence.original.snapshot_sha256,
      queue_fingerprint: fingerprint("queue", evidence.original.queue),
      original: fingerprintEvidence(evidence.original),
      disconnect_attempt: fingerprintEvidence(evidence.disconnect_attempt),
      explicit_reprint: fingerprintEvidence(evidence.explicit_reprint),
    }),
    operator_confirmation: Object.freeze({ ...confirmation }),
  });
}

export { writeMacPrinterAcceptanceRecord } from "./mac-printer-acceptance-record.js";
export type { MacPrinterAcceptanceWriteHooks } from "./mac-printer-acceptance-record.js";
