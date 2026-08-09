import assert from "node:assert/strict";
import test from "node:test";

import type { LaundryDesktopBridge } from "./desktop-bridge.js";
import { createDesktopPrinterPort } from "./desktop-printer-port.js";

type PrinterBridge = NonNullable<LaundryDesktopBridge["printer"]>;

function bridge(overrides: Partial<PrinterBridge> = {}): PrinterBridge {
  return Object.freeze({
    discover: async () => ({ ok: false, error: { code: "UNAVAILABLE", message: "offline" } }),
    status: async () => ({
      ok: true,
      data: {
        state: "ready",
        configured_queue: "XP58_USB",
        available_queues: ["XP58_USB"],
        message: "ready",
      },
    }),
    configure: async () => ({ ok: false, error: { code: "UNAVAILABLE", message: "offline" } }),
    test: async () => ({
      ok: true,
      data: {
        queue: "XP58_USB",
        cups_job_id: "XP58_USB-9",
        payload_sha256: "c".repeat(64),
        bytes_written: 48,
        message: "submitted",
      },
    }),
    ...overrides,
  });
}

test("desktop printer port maps exact status and fixed-test responses", async () => {
  const port = createDesktopPrinterPort(bridge());
  assert.deepEqual(await port.status(), {
    ok: true,
    data: {
      state: "ready",
      configuredQueue: "XP58_USB",
      availableQueues: ["XP58_USB"],
      message: "ready",
    },
  });
  assert.deepEqual(await port.testFixedTicket(), {
    ok: true,
    data: {
      queue: "XP58_USB",
      cupsJobId: "XP58_USB-9",
      payloadSha256: "c".repeat(64),
      bytesWritten: 48,
      message: "submitted",
    },
  });
});

test("desktop printer port rejects unsafe queue input and extra response fields", async () => {
  let configured = 0;
  const port = createDesktopPrinterPort(
    bridge({
      configure: async () => {
        configured += 1;
        return { ok: false };
      },
      status: async () => ({
        ok: true,
        data: {
          state: "ready",
          configured_queue: "XP58_USB",
          available_queues: ["XP58_USB"],
          message: "ready",
          path: "/tmp/raw",
        },
      }),
    }),
  );
  assert.equal((await port.configure("../XP58")).ok, false);
  assert.equal(configured, 0);
  assert.deepEqual(await port.status(), {
    ok: false,
    error: { code: "DESKTOP_BRIDGE_ERROR", message: "桌面打印机响应格式错误" },
  });
});
