import assert from "node:assert/strict";
import test from "node:test";

import type { ConfiguredPrinterRuntime } from "../print/configured-runtime.js";
import { DESKTOP_PRINTER_OPERATIONS, createDesktopPrinterService } from "./printer-operation.js";

const STATUS = Object.freeze({
  state: "ready" as const,
  configured_queue: "XP58_USB",
  available_queues: Object.freeze(["XP58_USB"]),
  message: "ready",
});

function manager() {
  return {
    discover: async () => STATUS,
    status: async () => STATUS,
    configure: async () => STATUS,
    test: async () =>
      Object.freeze({
        queue: "XP58_USB",
        cups_job_id: "XP58_USB-7",
        payload_sha256: "b".repeat(64),
        bytes_written: 32,
        message: "submitted",
      }),
  } as unknown as ConfiguredPrinterRuntime;
}

test("printer operation schemas reject extra fields and renderer-controlled test payloads", () => {
  assert.throws(() =>
    DESKTOP_PRINTER_OPERATIONS.configure.input.parse({ queue: "XP58_USB", path: "/tmp/raw" }),
  );
  assert.throws(() =>
    DESKTOP_PRINTER_OPERATIONS.test.input.parse({ confirm: "PRINT_FIXED_TEST", bytes: [1, 2] }),
  );
  assert.throws(() => DESKTOP_PRINTER_OPERATIONS.test.input.parse({ confirm: "XP58_USB" }));
});

test("printer desktop service is authenticated admin-only", async () => {
  const anonymous = createDesktopPrinterService({
    manager: manager(),
    currentSession: () => null,
    mutationsEnabled: true,
  });
  assert.deepEqual(await anonymous.status(), {
    ok: false,
    error: { code: "UNAUTHENTICATED", message: "请先登录管理员账号" },
  });

  const staff = createDesktopPrinterService({
    manager: manager(),
    currentSession: () => ({ role: "staff" }),
    mutationsEnabled: true,
  });
  assert.equal((await staff.configure({ queue: "XP58_USB" })).ok, false);

  const admin = createDesktopPrinterService({
    manager: manager(),
    currentSession: () => ({ role: "admin" }),
    mutationsEnabled: true,
  });
  assert.deepEqual(await admin.status(), { ok: true, data: STATUS });
  assert.equal((await admin.test({ confirm: "PRINT_FIXED_TEST" })).ok, true);
});
