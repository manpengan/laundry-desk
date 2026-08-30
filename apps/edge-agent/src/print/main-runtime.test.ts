import assert from "node:assert/strict";
import test from "node:test";

import { createMainPrinterPilot } from "./main-runtime.js";
import type { RawPrintPort } from "./raw-print-port.js";

test("Windows runtime readiness reuses the Winspool pilot selected at startup", async () => {
  const calls: string[] = [];
  const printPort: RawPrintPort = Object.freeze({
    backend: "windows_spooler",
    isQueueName: () => true,
    discoverQueues: async () => {
      calls.push("discover");
      return Object.freeze(["宏发 前台"]);
    },
    submitRaw: async () => {
      throw new Error("validation must not submit bytes");
    },
  });
  const pilot = createMainPrinterPilot("win32", printPort);

  const result = await pilot({ mode: "validate", queue: "宏发 前台" });

  assert.equal(result.ok, true);
  assert.equal(result.selected_queue, "宏发 前台");
  assert.deepEqual(calls, ["discover"]);
});

test("main printer pilot fails closed on an unsupported desktop platform", () => {
  const printPort: RawPrintPort = Object.freeze({
    backend: "windows_spooler",
    isQueueName: () => false,
    discoverQueues: async () => Object.freeze([]),
    submitRaw: async () => "winspool-1",
  });

  assert.throws(
    () => createMainPrinterPilot("linux", printPort),
    /PRINTER_PILOT_PLATFORM_UNSUPPORTED/u,
  );
});
