import assert from "node:assert/strict";
import test from "node:test";

import { runMacPrinterPilot } from "./mac-printer-pilot.js";

const discovery = {
  platform: "darwin" as const,
  capture: async () => "XP58_USB\nLabel_Printer\nXP58_USB\ninvalid queue\n",
};

test("macOS printer pilot discovers and validates only installed safe queue names", async () => {
  const found = await runMacPrinterPilot({ mode: "discover" }, discovery);
  assert.equal(found.ok, true);
  assert.deepEqual(found.queues, ["Label_Printer", "XP58_USB"]);

  const valid = await runMacPrinterPilot({ mode: "validate", queue: "XP58_USB" }, discovery);
  assert.equal(valid.ok, true);
  assert.equal(valid.selected_queue, "XP58_USB");

  const rejected = await runMacPrinterPilot({ mode: "validate", queue: "../XP58" }, discovery);
  assert.equal(rejected.ok, false);
});

test("macOS printer pilot submits fixed raw args only after explicit print mode", async () => {
  const calls: Array<Readonly<{ file: string; args: readonly string[]; bytes: number }>> = [];
  const result = await runMacPrinterPilot(
    { mode: "print", queue: "XP58_USB", timeoutMs: 1_000 },
    {
      ...discovery,
      print: async (file, args, bytes) => {
        calls.push(Object.freeze({ file, args, bytes: bytes.byteLength }));
        return "request id is XP58_USB-42 (1 file(s))\n";
      },
    },
  );
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.file, "/usr/bin/lp");
  assert.deepEqual(calls[0]?.args, ["-d", "XP58_USB", "-o", "raw"]);
  assert.ok((calls[0]?.bytes ?? 0) > 0);
  assert.equal(result.cups_job_id, "XP58_USB-42");
  assert.match(result.payload_sha256 ?? "", /^[0-9a-f]{64}$/u);
});

test("macOS printer pilot rejects an untrackable successful submission", async () => {
  const result = await runMacPrinterPilot(
    { mode: "print", queue: "XP58_USB" },
    { ...discovery, print: async () => "" },
  );
  assert.equal(result.ok, false);
  assert.match(result.message, /trackable job id/u);
});

test("macOS printer pilot fails closed off Darwin", async () => {
  const result = await runMacPrinterPilot(
    { mode: "discover" },
    { platform: "linux", capture: async () => "XP58_USB" },
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.queues, []);
});
