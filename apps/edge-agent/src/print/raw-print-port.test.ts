import assert from "node:assert/strict";
import test from "node:test";

import { CupsSubmissionError } from "./cups-process.js";
import {
  createCupsRawPrintPort,
  createPlatformRawPrintPort,
  createWindowsRawPrintPort,
  RawPrintSubmissionError,
} from "./raw-print-port.js";

test("CUPS and Windows adapters expose one bounded RAW print port", async () => {
  const cups = createCupsRawPrintPort({
    discoverCups: async () => Object.freeze(["XP58_CUPS"]),
    submitCups: async (queue, bytes) => {
      assert.equal(queue, "XP58_CUPS");
      assert.deepEqual(bytes, Uint8Array.of(1, 2));
      return "XP58_CUPS-7";
    },
  });
  assert.equal(cups.backend, "cups");
  assert.deepEqual(await cups.discoverQueues(), ["XP58_CUPS"]);
  assert.equal(await cups.submitRaw("XP58_CUPS", Uint8Array.of(1, 2)), "XP58_CUPS-7");

  const windows = createWindowsRawPrintPort({
    discoverWindows: async () => Object.freeze(["XP-58 前台"]),
    submitWindows: async (queue, bytes) => {
      assert.equal(queue, "XP-58 前台");
      return Object.freeze({ jobId: "19", bytesWritten: bytes.byteLength });
    },
  });
  assert.equal(windows.backend, "windows_spooler");
  assert.equal(windows.isQueueName("XP-58 前台"), true);
  assert.equal(await windows.submitRaw("XP-58 前台", Uint8Array.of(3)), "winspool-19");
});

test("RAW adapters preserve uncertain outcomes after submission starts", async () => {
  const cups = createCupsRawPrintPort({
    submitCups: async () => {
      throw new CupsSubmissionError("uncertain", "timeout");
    },
  });
  await assert.rejects(
    () => cups.submitRaw("XP58", Uint8Array.of(1)),
    (error: unknown) => error instanceof RawPrintSubmissionError && error.outcome === "uncertain",
  );

  const windows = createWindowsRawPrintPort({
    submitWindows: async () => Object.freeze({ jobId: "20", bytesWritten: 0 }),
  });
  await assert.rejects(
    () => windows.submitRaw("XP-58", Uint8Array.of(1)),
    (error: unknown) => error instanceof RawPrintSubmissionError && error.outcome === "uncertain",
  );
});

test("platform selection never falls through to an implicit print backend", () => {
  assert.equal(createPlatformRawPrintPort("darwin", {}).backend, "cups");
  assert.equal(createPlatformRawPrintPort("win32", {}).backend, "windows_spooler");
  assert.throws(() => createPlatformRawPrintPort("linux", {}), /RAW_PRINT_PLATFORM_UNSUPPORTED/u);
});
