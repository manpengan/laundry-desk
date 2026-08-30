import assert from "node:assert/strict";
import test from "node:test";

import { WindowsHelperSubmissionError } from "./helper-client.js";
import {
  isWindowsPrinterQueueName,
  listWindowsPrinters,
  submitWindowsRaw,
  WindowsRawSubmissionError,
} from "./windows-print.js";

test("Windows printer discovery accepts installed display names and returns a stable set", async () => {
  const printers = await listWindowsPrinters({
    platform: "win32",
    run: async (arguments_) => {
      assert.deepEqual(arguments_, ["list-printers"]);
      return { ok: true, printers: ["XP-58", "宏发 前台", "XP-58"] };
    },
  });

  assert.deepEqual(printers, ["XP-58", "宏发 前台"]);
  assert.equal(isWindowsPrinterQueueName("宏发 前台"), true);
  assert.equal(isWindowsPrinterQueueName(" trailing "), false);
  assert.equal(isWindowsPrinterQueueName("bad\nqueue"), false);
});

test("Windows RAW submission binds exact queue, bytes, job id, and byte count", async () => {
  const payload = Uint8Array.of(0x1b, 0x40, 0x0a);
  const result = await submitWindowsRaw("XP-58 Receipt", payload, {
    platform: "win32",
    runWithInput: async (arguments_, input) => {
      assert.deepEqual(arguments_, ["print-raw", "XP-58 Receipt"]);
      assert.deepEqual(input, payload);
      assert.notEqual(input, payload);
      return { ok: true, job_id: 41, bytes_written: payload.byteLength };
    },
  });

  assert.deepEqual(result, { jobId: "41", bytesWritten: payload.byteLength });
});

test("Windows RAW submission preserves definite and uncertain helper outcomes", async () => {
  for (const outcome of ["failed", "uncertain"] as const) {
    await assert.rejects(
      () =>
        submitWindowsRaw("XP-58", Uint8Array.of(1), {
          platform: "win32",
          runWithInput: async () => {
            throw new WindowsHelperSubmissionError(outcome);
          },
        }),
      (error: unknown) => error instanceof WindowsRawSubmissionError && error.outcome === outcome,
    );
  }
});

test("invalid post-submission helper output is uncertain, never safely retryable", async () => {
  await assert.rejects(
    () =>
      submitWindowsRaw("XP-58", Uint8Array.of(1, 2), {
        platform: "win32",
        runWithInput: async () => ({ ok: true, job_id: 9, bytes_written: 1 }),
      }),
    (error: unknown) => error instanceof WindowsRawSubmissionError && error.outcome === "uncertain",
  );
});

test(
  "the native Windows helper enumerates queues and rejects a missing queue before submission",
  { skip: process.platform !== "win32" },
  async () => {
    assert.ok(Array.isArray(await listWindowsPrinters()));
    await assert.rejects(
      () => submitWindowsRaw("Laundry Missing Queue 6F5C5CF1", Uint8Array.of(0x1b, 0x40)),
      (error: unknown) => error instanceof WindowsRawSubmissionError && error.outcome === "failed",
    );
  },
);
