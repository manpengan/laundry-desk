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
import type { AccessSession } from "../auth/types.js";
import { createMockCommandClient } from "../commands/command-client.js";
import { PRINTER_PATH_ENV_NAME, SettingsPage } from "./SettingsPage.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

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

test("SettingsPage SSR shows CLI-only printer instructions", () => {
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

  assert.match(html, /打印机冒烟/);
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
