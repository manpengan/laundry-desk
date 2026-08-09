import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { ToastProvider } from "@laundry/ui";
import { createMockAuthClient } from "../auth/AuthClient.js";
import { FULL_STORE_FEATURES } from "../auth/permissions.js";
import type { SessionView } from "../auth/types.js";
import { createMockCommandClient } from "../commands/command-client.js";
import { createMockQueryClient } from "../commands/query-client.js";
import type { PrinterPort } from "../host/printer-port.js";
import { PRINTER_PATH_ENV_NAME, SettingsPage } from "./SettingsPage.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

const SESSION: SessionView = Object.freeze({
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

test("SettingsPage SSR keeps the legacy path smoke CLI-only", () => {
  const html = renderToStaticMarkup(
    createElement(
      ToastProvider,
      null,
      createElement(SettingsPage, {
        session: SESSION,
        authClient: createMockAuthClient(),
        commandClient: createMockCommandClient(),
      }),
    ),
  );

  assert.match(html, /旧版 USB/);
  assert.match(html, /data-testid="printer-smoke-section"/);
  assert.match(html, /data-testid="printer-smoke-static"/);
  assert.match(html, /LAUNDRY_PRINTER_PATH/);
  assert.match(html, /printer-smoke/);
  assert.match(html, /--validate/);
  assert.match(html, /COM3/);
  assert.match(html, /LPT1/);
  assert.match(html, /USB001/);
  assert.doesNotMatch(html, /data-testid="printer-smoke-run"/);
  assert.doesNotMatch(html, /#ff0000/i);
  assert.doesNotMatch(html, /rgb\(/i);
});

test("SettingsPage source cannot reconnect renderer printer smoke", () => {
  const source = readFileSync(join(packageRoot, "src/pages/SettingsPage.tsx"), "utf8");
  assert.doesNotMatch(source, /edgeBridge\.printerSmoke|edgePrinterSmoke|resolveEdgePrinterSmoke/u);
  assert.match(source, /--validate/u);
});

test("SettingsPage exposes admin CUPS configuration without claiming physical acceptance", () => {
  const unavailable = Object.freeze({
    ok: false as const,
    error: Object.freeze({ code: "UNAVAILABLE", message: "not loaded" }),
  });
  const printerPort: PrinterPort = Object.freeze({
    discover: async () => unavailable,
    status: async () => unavailable,
    configure: async () => unavailable,
    testFixedTicket: async () => unavailable,
  });
  const html = renderToStaticMarkup(
    createElement(
      ToastProvider,
      null,
      createElement(SettingsPage, {
        session: SESSION,
        authClient: createMockAuthClient(),
        commandClient: createMockCommandClient(),
        printerPort,
      }),
    ),
  );

  assert.match(html, /data-testid="printer-settings"/u);
  assert.match(html, /CUPS 小票打印机/u);
  assert.match(html, /启用所选队列/u);
  assert.match(html, /打印固定测试票/u);
  assert.match(html, /XP-58.*仍须现场验收/u);
});

test("member feature flag gates the complete bonus-rule settings surface", () => {
  const render = (memberEnabled: boolean) =>
    renderToStaticMarkup(
      createElement(
        ToastProvider,
        null,
        createElement(SettingsPage, {
          session: {
            ...SESSION,
            features: Object.freeze({ ...FULL_STORE_FEATURES, member_enabled: memberEnabled }),
          },
          authClient: createMockAuthClient(),
          commandClient: createMockCommandClient(),
          queryClient: createMockQueryClient(),
        }),
      ),
    );

  assert.doesNotMatch(render(false), /data-testid="member-rules"/);
  assert.match(render(true), /data-testid="member-rules"/);
});
