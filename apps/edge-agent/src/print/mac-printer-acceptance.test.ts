import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createMacPrinterAcceptanceRecord,
  writeMacPrinterAcceptanceRecord,
} from "./mac-printer-acceptance.js";
import type { MacPrinterPilotResult } from "./mac-printer-pilot.js";

const pilot: MacPrinterPilotResult = {
  ok: true,
  mode: "print",
  queues: ["Store_XP58"],
  selected_queue: "Store_XP58",
  cups_job_id: "Store_XP58-42",
  payload_sha256: "a".repeat(64),
  bytes_written: 128,
  message: "submitted",
};
const confirmed = {
  text_clear: true,
  feed_ok: true,
  cut_or_tear_ok: true,
  barcode_scanned: true,
};

test("physical acceptance stores fingerprints and requires every operator check", () => {
  const record = createMacPrinterAcceptanceRecord(
    pilot,
    confirmed,
    "0.1.0",
    "2026-07-30T08:00:00.000Z",
  );
  assert.match(record.queue_fingerprint, /^[0-9a-f]{64}$/u);
  assert.match(record.cups_job_fingerprint, /^[0-9a-f]{64}$/u);
  assert.equal(JSON.stringify(record).includes("Store_XP58"), false);
  assert.throws(
    () =>
      createMacPrinterAcceptanceRecord(pilot, { ...confirmed, barcode_scanned: false }, "0.1.0"),
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
    pilot,
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
