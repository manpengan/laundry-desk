import assert from "node:assert/strict";
import test from "node:test";

import { runWindowsPrinterPilot } from "./windows-printer-pilot.js";
import type { RawPrintPort } from "./raw-print-port.js";

function port(submissions: Uint8Array[]): RawPrintPort {
  return Object.freeze({
    backend: "windows_spooler",
    isQueueName: () => true,
    discoverQueues: async () => Object.freeze(["XP-58 前台"]),
    submitRaw: async (_queue, bytes) => {
      submissions.push(Uint8Array.from(bytes));
      return "winspool-23";
    },
  });
}

test("Windows pilot discovers and validates without writing bytes", async () => {
  const submissions: Uint8Array[] = [];
  const adapter = port(submissions);

  const discovered = await runWindowsPrinterPilot({ mode: "discover" }, adapter);
  assert.equal(discovered.ok, true);
  assert.deepEqual(discovered.queues, ["XP-58 前台"]);

  const validated = await runWindowsPrinterPilot(
    { mode: "validate", queue: "XP-58 前台" },
    adapter,
  );
  assert.equal(validated.ok, true);
  assert.equal(validated.selected_queue, "XP-58 前台");
  assert.deepEqual(submissions, []);
});

test("Windows pilot submits only the fixed bounded ESC/POS payload", async () => {
  const submissions: Uint8Array[] = [];
  const result = await runWindowsPrinterPilot(
    { mode: "print", queue: "XP-58 前台" },
    port(submissions),
  );

  assert.equal(result.ok, true);
  assert.equal(result.cups_job_id, "winspool-23");
  assert.match(result.payload_sha256 ?? "", /^[0-9a-f]{64}$/u);
  assert.equal(result.bytes_written, submissions[0]?.byteLength);
  assert.ok((submissions[0]?.byteLength ?? 0) > 0);
});
