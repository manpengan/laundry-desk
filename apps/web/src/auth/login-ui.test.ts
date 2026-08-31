import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { ToastProvider } from "@laundry/ui";
import { App } from "../App.js";
import { createMockConnection } from "../connection.js";
import { createMockCommandClient } from "../commands/command-client.js";
import { createMockQueryClient } from "../commands/query-client.js";
import type { AppPorts } from "../host/types.js";
import { LoginPage } from "../pages/LoginPage.js";
import { PinSwitchDialog } from "../shell/PinSwitchDialog.js";
import { createMockAuthClient } from "./AuthClient.js";
import { setDeviceIdForTests } from "./device-id.js";
import { FULL_STORE_FEATURES } from "./permissions.js";
import type { SessionView } from "./types.js";
import { assertNoAuthSecretsInWebStorage } from "./storage-guard.js";

const DEVICE = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function cssRule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const body = new RegExp(`${escaped}\\s*\\{(?<body>[^}]*)\\}`, "u").exec(css)?.groups?.body;
  assert.ok(body, `missing CSS rule for ${selector}`);
  return body;
}

function sampleSession(): SessionView {
  return Object.freeze({
    session: Object.freeze({
      session_id: "aaaaaaaa-bbbb-4ccc-8ddd-111111111111",
      session_version: 1,
      org_id: "aaaaaaaa-bbbb-4ccc-8ddd-222222222222",
      store_id: "aaaaaaaa-bbbb-4ccc-8ddd-333333333333",
      staff_id: "11111111-1111-4111-8111-111111111101",
      device_id: DEVICE,
      permission_version: 1,
    }),
    role: "admin" as const,
    features: FULL_STORE_FEATURES,
    display: Object.freeze({
      store_name: "宏发演示店",
      staff_name: "店员甲",
      org_code: "ORG",
      store_code: "S1",
    }),
  });
}

function appPorts(auth = createMockAuthClient()): AppPorts {
  return Object.freeze({
    auth,
    command: createMockCommandClient(),
    query: createMockQueryClient(),
    photo: Object.freeze({
      upload: async () => ({ ok: false as const, error: { code: "NOT_CONFIGURED" } }),
      read: async () => ({ ok: false as const, error: { code: "NOT_CONFIGURED" } }),
      remove: async () => ({ ok: false as const, error: { code: "NOT_CONFIGURED" } }),
    }),
    health: Object.freeze({
      get: async () => ({ ok: true as const, data: { status: "ready" as const } }),
    }),
  });
}

test("LoginPage SSR renders required fields", () => {
  const html = renderToStaticMarkup(
    createElement(
      ToastProvider,
      null,
      createElement(LoginPage, {
        authClient: createMockAuthClient(),
        onSuccess: () => undefined,
      }),
    ),
  );
  assert.match(html, /data-page="login"/);
  assert.match(html, /机构代码/);
  assert.match(html, /门店代码/);
  assert.match(html, /用户名/);
  assert.match(html, /密码/);
  assert.match(html, /type="password"/);
  assert.match(html, /登录/);
});

test("login column fields do not inherit the shared horizontal flex basis", async () => {
  const css = await readFile(new URL("../../src/styles/shell.css", import.meta.url), "utf8");
  const fieldRule = cssRule(css, ".ld-login__form > .ld-field");

  assert.match(fieldRule, /\bflex:\s*0\s+0\s+auto\s*;/u);
});

test("App unauthenticated renders login, not counter shell", () => {
  const html = renderToStaticMarkup(
    createElement(App, {
      ports: appPorts(),
      enableLiquidGlass: false,
      initialSession: null,
    }),
  );
  assert.match(html, /data-page="login"/);
  assert.doesNotMatch(html, /data-shell="counter"/);
});

test("App with session renders counter shell and switch affordance", () => {
  const html = renderToStaticMarkup(
    createElement(App, {
      ports: appPorts(),
      enableLiquidGlass: false,
      initialSession: sampleSession(),
      connection: createMockConnection({ mode: "online", pendingSyncCount: 0 }),
      themePreference: "light",
    }),
  );
  assert.match(html, /data-shell="counter"/);
  assert.match(html, /宏发演示店/);
  assert.match(html, /店员甲/);
  assert.match(html, /切换员工/);
  assert.match(html, /跳到主内容/);
  assert.doesNotMatch(html, /data-page="login"/);
});

test("desktop cold-start session renders an explicit offline read-only workbench", () => {
  const html = renderToStaticMarkup(
    createElement(App, {
      ports: appPorts(),
      enableLiquidGlass: false,
      initialSession: sampleSession(),
      connection: createMockConnection({ mode: "offline", pendingSyncCount: 0 }),
      readOnly: true,
    }),
  );
  assert.match(html, /data-shell="counter"/);
  assert.match(html, /data-read-only="true"/);
  assert.match(html, /离线只读/);
  assert.match(html, /本机加密缓存/);
  assert.doesNotMatch(html, /切换员工/);
  assert.doesNotMatch(html, /type="password"|name="pin"/);
});

test("successful mock login yields session usable as App initialSession", async () => {
  setDeviceIdForTests(DEVICE);
  const client = createMockAuthClient({ validPassword: "demo" });
  const result = await client.login({
    org_code: "ORG",
    store_code: "S1",
    username: "clerk",
    password: "demo",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const html = renderToStaticMarkup(
    createElement(App, {
      ports: appPorts(client),
      enableLiquidGlass: false,
      initialSession: result.data,
    }),
  );
  assert.match(html, /data-shell="counter"/);
  assert.match(html, /切换员工/);
  assertNoAuthSecretsInWebStorage();
});

test("failed mock login leaves App on login route shape", async () => {
  setDeviceIdForTests(DEVICE);
  const client = createMockAuthClient({ validPassword: "demo" });
  const result = await client.login({
    org_code: "ORG",
    store_code: "S1",
    username: "clerk",
    password: "bad",
  });
  assert.equal(result.ok, false);
  const html = renderToStaticMarkup(
    createElement(App, {
      ports: appPorts(client),
      enableLiquidGlass: false,
      initialSession: null,
    }),
  );
  assert.match(html, /data-page="login"/);
  assertNoAuthSecretsInWebStorage();
});

test("PinSwitchDialog open SSR shows staff select and PIN field", () => {
  const client = createMockAuthClient();
  const html = renderToStaticMarkup(
    createElement(
      ToastProvider,
      null,
      createElement(PinSwitchDialog, {
        open: true,
        onClose: () => undefined,
        authClient: client,
        currentStaffId: "11111111-1111-4111-8111-111111111101",
        onSwitched: () => undefined,
      }),
    ),
  );
  assert.match(html, /切换员工/);
  assert.match(html, /目标员工/);
  assert.match(html, /name="pin"/);
  assert.match(html, /确认切换/);
});

test("PinSwitchDialog closed renders nothing", () => {
  const html = renderToStaticMarkup(
    createElement(
      ToastProvider,
      null,
      createElement(PinSwitchDialog, {
        open: false,
        onClose: () => undefined,
        authClient: createMockAuthClient(),
        currentStaffId: "11111111-1111-4111-8111-111111111101",
        onSwitched: () => undefined,
      }),
    ),
  );
  assert.doesNotMatch(html, /确认切换/);
});
