import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import type { MacPrinterPilotResult } from "./mac-printer-pilot.js";

const SEMVER = /^(?:0|[1-9]\d{0,12})\.(?:0|[1-9]\d{0,12})\.(?:0|[1-9]\d{0,12})$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const CUPS_JOB_ID = /^[A-Za-z0-9_.-]{1,128}-\d+$/u;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export type MacPrinterOperatorConfirmation = Readonly<{
  text_clear: boolean;
  feed_ok: boolean;
  cut_or_tear_ok: boolean;
  barcode_scanned: boolean;
}>;

export type MacPrinterAcceptanceRecord = Readonly<{
  schema_version: 1;
  platform: "darwin";
  printer_family: "xp58";
  app_version: string;
  accepted_at: string;
  queue_fingerprint: string;
  cups_job_fingerprint: string;
  payload_sha256: string;
  bytes_written: number;
  operator_confirmation: MacPrinterOperatorConfirmation;
}>;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isFullyConfirmed(confirmation: MacPrinterOperatorConfirmation): boolean {
  return (
    confirmation.text_clear === true &&
    confirmation.feed_ok === true &&
    confirmation.cut_or_tear_ok === true &&
    confirmation.barcode_scanned === true
  );
}

export function createMacPrinterAcceptanceRecord(
  pilot: MacPrinterPilotResult,
  confirmation: MacPrinterOperatorConfirmation,
  appVersion: string,
  acceptedAt = new Date().toISOString(),
): MacPrinterAcceptanceRecord {
  if (
    !pilot.ok ||
    pilot.mode !== "print" ||
    pilot.selected_queue === undefined ||
    pilot.cups_job_id === undefined ||
    pilot.payload_sha256 === undefined ||
    pilot.bytes_written === undefined
  ) {
    throw new Error("a successful trackable print submission is required");
  }
  if (
    !CUPS_JOB_ID.test(pilot.cups_job_id) ||
    !SHA256.test(pilot.payload_sha256) ||
    !Number.isSafeInteger(pilot.bytes_written) ||
    pilot.bytes_written < 1
  ) {
    throw new Error("printer submission evidence is invalid");
  }
  if (!isFullyConfirmed(confirmation)) throw new Error("all physical sample checks must pass");
  if (!SEMVER.test(appVersion)) throw new Error("app version must be exact semver");
  if (!ISO_UTC.test(acceptedAt) || Number.isNaN(Date.parse(acceptedAt))) {
    throw new Error("acceptance timestamp is invalid");
  }
  return Object.freeze({
    schema_version: 1,
    platform: "darwin",
    printer_family: "xp58",
    app_version: appVersion,
    accepted_at: acceptedAt,
    queue_fingerprint: sha256(pilot.selected_queue),
    cups_job_fingerprint: sha256(pilot.cups_job_id),
    payload_sha256: pilot.payload_sha256,
    bytes_written: pilot.bytes_written,
    operator_confirmation: Object.freeze({
      text_clear: confirmation.text_clear,
      feed_ok: confirmation.feed_ok,
      cut_or_tear_ok: confirmation.cut_or_tear_ok,
      barcode_scanned: confirmation.barcode_scanned,
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
