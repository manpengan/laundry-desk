import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { ToastProvider } from "@laundry/ui";
import { createMockAuthClient } from "../auth/AuthClient.js";
import { FULL_STORE_FEATURES } from "../auth/permissions.js";
import type { AccessSession } from "../auth/types.js";
import { createMockCommandClient } from "../commands/command-client.js";
import {
  parsePrinterSmokeResult,
  PRINTER_PATH_ENV_NAME,
  resolveEdgePrinterSmoke,
  SettingsPage,
} from "./SettingsPage.js";

const SESSION: AccessSession = Object.freeze({
  access_token: "eyJhbGciOiJub25lIn0.e30.mocksig",
  token_type: "Bearer" as const,
  expires_in: 900,
  storage: "memory_only" as const,
  session: Object.freeze({
    session_id: "aaaaaaaa-bbbb-4ccc-8ddd-111111111111",
    session_version: 1,
    org_id: "aaaaaaaa-bbbb-4ccc-8ddd-222222222222",
    store_id: "aaaaaaaa-bbbb-4ccc-8ddd-333333333333",
    staff_id: "11111111-1111-4111-8111-111111111101",
    device_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    permission_version: 1,
  }),
  role: "admin" as const,
  features: FULL_STORE_FEATURES,
  display: Object.freeze({
    store_name: "宏发演示店",
    staff_name: "店员",
    org_code: "ORG",
    store_code: "S1",
  }),
});

test("PRINTER_PATH_ENV_NAME is LAUNDRY_PRINTER_PATH", () => {
  assert.equal(PRINTER_PATH_ENV_NAME, "LAUNDRY_PRINTER_PATH");
});

test("parsePrinterSmokeResult accepts smoke JSON shape", () => {
  const ok = parsePrinterSmokeResult({
    ok: true,
    path: "\\\\.\\COM3",
    kind: "usb",
    message: "Wrote 42 bytes",
    bytes_written: 42,
  });
  assert.deepEqual(ok, {
    ok: true,
    path: "\\\\.\\COM3",
    kind: "usb",
    message: "Wrote 42 bytes",
    bytes_written: 42,
  });

  const mock = parsePrinterSmokeResult({
    ok: true,
    path: null,
    kind: "mock",
    message: "Mock print port active",
  });
  assert.equal(mock?.kind, "mock");
  assert.equal(mock?.bytes_written, undefined);

  assert.equal(parsePrinterSmokeResult(null), null);
  assert.equal(parsePrinterSmokeResult({ ok: true }), null);
});

test("resolveEdgePrinterSmoke prefers override and null disables", () => {
  const fn = async () => ({ ok: true });
  assert.equal(resolveEdgePrinterSmoke(fn), fn);
  assert.equal(resolveEdgePrinterSmoke(null), null);
  assert.equal(resolveEdgePrinterSmoke(undefined, {}), null);
  const bound = resolveEdgePrinterSmoke(undefined, {
    edgeBridge: { printerSmoke: fn },
  });
  assert.equal(typeof bound, "function");
});

test("SettingsPage SSR without edgeBridge shows static CLI instructions", () => {
  const html = renderToStaticMarkup(
    createElement(
      ToastProvider,
      null,
      createElement(SettingsPage, {
        session: SESSION,
        authClient: createMockAuthClient(),
        commandClient: createMockCommandClient(),
        edgePrinterSmoke: null,
      }),
    ),
  );

  assert.match(html, /打印机冒烟/);
  assert.match(html, /data-testid="printer-smoke-section"/);
  assert.match(html, /data-testid="printer-smoke-static"/);
  assert.match(html, /LAUNDRY_PRINTER_PATH/);
  assert.match(html, /printer-smoke/);
  assert.doesNotMatch(html, /data-testid="printer-smoke-run"/);
  assert.doesNotMatch(html, /#ff0000/i);
  assert.doesNotMatch(html, /rgb\(/i);
});

test("SettingsPage SSR with edgePrinterSmoke shows run button", () => {
  const html = renderToStaticMarkup(
    createElement(
      ToastProvider,
      null,
      createElement(SettingsPage, {
        session: SESSION,
        authClient: createMockAuthClient(),
        commandClient: createMockCommandClient(),
        edgePrinterSmoke: async () =>
          Object.freeze({
            ok: true,
            path: null,
            kind: "mock",
            message: "Mock print port active",
          }),
      }),
    ),
  );

  assert.match(html, /data-testid="printer-smoke-run"/);
  assert.match(html, /运行 path 冒烟/);
  assert.doesNotMatch(html, /data-testid="printer-smoke-static"/);
  assert.doesNotMatch(html, /#ff0000/i);
});
