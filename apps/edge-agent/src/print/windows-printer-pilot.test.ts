import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { buildPrinterSmokePayload } from "./printer-smoke.js";
import { runWindowsPrinterPilot } from "./windows-printer-pilot.js";
import { RawPrintSubmissionError, type RawPrintPort } from "./raw-print-port.js";

function port(
  submissions: Uint8Array[],
  options: Readonly<{
    queues?: readonly string[];
    discoverQueues?: RawPrintPort["discoverQueues"];
    submitRaw?: RawPrintPort["submitRaw"];
  }> = {},
): RawPrintPort {
  return Object.freeze({
    backend: "windows_spooler",
    isQueueName: (queue) =>
      queue.length > 0 && queue.trim() === queue && !/[\u0000-\u001f\u007f/]/u.test(queue),
    discoverQueues:
      options.discoverQueues ??
      (async () => Object.freeze([...(options.queues ?? ["XP-58 前台"])])),
    submitRaw:
      options.submitRaw ??
      (async (_queue, bytes) => {
        submissions.push(Uint8Array.from(bytes));
        return "winspool-23";
      }),
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

test("Windows pilot never infers a queue when explicit selection is missing or ambiguous", async () => {
  const submissions: Uint8Array[] = [];
  const queues = Object.freeze(["XP-58 前台", "XP-58 后台"]);
  const adapter = port(submissions, { queues });

  const ambiguous = await runWindowsPrinterPilot({ mode: "validate" }, adapter);
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.error_code, "WINDOWS_PRINT_QUEUE_AMBIGUOUS");
  assert.deepEqual(ambiguous.queues, queues);

  const selected = await runWindowsPrinterPilot({ mode: "validate", queue: "XP-58 后台" }, adapter);
  assert.equal(selected.ok, true);
  assert.equal(selected.selected_queue, "XP-58 后台");

  const required = await runWindowsPrinterPilot(
    { mode: "validate" },
    port(submissions, { queues: ["XP-58 前台"] }),
  );
  assert.equal(required.ok, false);
  assert.equal(required.error_code, "WINDOWS_PRINT_QUEUE_REQUIRED");
  assert.deepEqual(submissions, []);
});

test("Windows pilot separates invalid, missing, empty, and duplicate queue discovery", async () => {
  const submissions: Uint8Array[] = [];
  const missing = await runWindowsPrinterPilot(
    { mode: "validate", queue: "XP-58 仓库" },
    port(submissions, { queues: ["XP-58 前台", "XP-58 后台"] }),
  );
  assert.equal(missing.error_code, "WINDOWS_PRINT_QUEUE_NOT_INSTALLED");
  assert.deepEqual(missing.queues, ["XP-58 前台", "XP-58 后台"]);

  const invalid = await runWindowsPrinterPilot(
    { mode: "validate", queue: "XP-58\n前台" },
    port(submissions),
  );
  assert.equal(invalid.error_code, "WINDOWS_PRINT_QUEUE_INVALID");

  const empty = await runWindowsPrinterPilot(
    { mode: "validate" },
    port(submissions, { queues: [] }),
  );
  assert.equal(empty.error_code, "WINDOWS_PRINT_QUEUE_NOT_INSTALLED");

  const duplicate = await runWindowsPrinterPilot(
    { mode: "validate", queue: "XP-58 前台" },
    port(submissions, { queues: ["XP-58 前台", "XP-58 前台"] }),
  );
  assert.equal(duplicate.error_code, "WINDOWS_PRINT_QUEUE_AMBIGUOUS");
  assert.deepEqual(submissions, []);
});

test("Windows pilot classifies discovery and backend failures without submitting bytes", async () => {
  const submissions: Uint8Array[] = [];
  const discoveryFailure = await runWindowsPrinterPilot(
    { mode: "validate", queue: "XP-58 前台" },
    port(submissions, {
      discoverQueues: async () => {
        throw new Error("spooler unavailable");
      },
    }),
  );
  assert.equal(discoveryFailure.error_code, "WINDOWS_PRINT_DISCOVERY_FAILED");
  assert.deepEqual(discoveryFailure.queues, []);

  const invalidDiscovery = await runWindowsPrinterPilot(
    { mode: "discover" },
    port(submissions, { queues: ["XP-58\n伪造队列"] }),
  );
  assert.equal(invalidDiscovery.error_code, "WINDOWS_PRINT_DISCOVERY_FAILED");
  assert.deepEqual(invalidDiscovery.queues, []);

  const cupsPort: RawPrintPort = Object.freeze({
    backend: "cups",
    isQueueName: () => true,
    discoverQueues: async () => Object.freeze(["XP58_CUPS"]),
    submitRaw: async () => "XP58_CUPS-1",
  });
  const wrongBackend = await runWindowsPrinterPilot(
    { mode: "validate", queue: "XP58_CUPS" },
    cupsPort,
  );
  assert.equal(wrongBackend.error_code, "WINDOWS_PRINT_PORT_REQUIRED");
  assert.deepEqual(submissions, []);
});

test("Windows pilot submits only the fixed bounded ESC/POS payload", async () => {
  const expected = buildPrinterSmokePayload("LAUNDRY Windows spooler pilot OK");
  let submittedQueue: string | null = null;
  let submittedBytes = new Uint8Array();
  const result = await runWindowsPrinterPilot(
    { mode: "print", queue: "XP-58 前台" },
    port([], {
      submitRaw: async (queue, bytes) => {
        submittedQueue = queue;
        submittedBytes = Uint8Array.from(bytes);
        return "winspool-23";
      },
    }),
  );

  assert.equal(result.ok, true);
  assert.equal(submittedQueue, "XP-58 前台");
  assert.deepEqual(submittedBytes, expected);
  assert.equal(result.cups_job_id, "winspool-23");
  assert.equal(result.payload_sha256, createHash("sha256").update(expected).digest("hex"));
  assert.equal(result.bytes_written, expected.byteLength);
  assert.match(result.message, /不代表实体出纸/u);
});

test("Windows pilot keeps definite failure distinct from a possibly accepted RAW job", async () => {
  for (const outcome of ["failed", "uncertain"] as const) {
    let submitCalls = 0;
    const result = await runWindowsPrinterPilot(
      { mode: "print", queue: "XP-58 前台" },
      port([], {
        submitRaw: async () => {
          submitCalls += 1;
          throw new RawPrintSubmissionError(outcome);
        },
      }),
    );

    assert.equal(result.ok, false);
    assert.equal(
      result.error_code,
      outcome === "failed" ? "WINDOWS_RAW_SUBMISSION_FAILED" : "WINDOWS_RAW_SUBMISSION_UNCERTAIN",
    );
    assert.equal(result.selected_queue, "XP-58 前台");
    assert.deepEqual(result.queues, ["XP-58 前台"]);
    assert.equal(result.cups_job_id, undefined);
    assert.equal(result.payload_sha256, undefined);
    assert.equal(result.bytes_written, undefined);
    assert.equal(submitCalls, 1);
    if (outcome === "uncertain") assert.match(result.message, /禁止自动重试/u);
  }

  const invalidReference = await runWindowsPrinterPilot(
    { mode: "print", queue: "XP-58 前台" },
    port([], { submitRaw: async () => "invalid-reference" }),
  );
  assert.equal(invalidReference.error_code, "WINDOWS_RAW_SUBMISSION_UNCERTAIN");
});
