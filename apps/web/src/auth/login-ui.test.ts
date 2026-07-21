import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { ToastProvider } from "@laundry/ui";
import { App } from "../App.js";
import { createMockConnection } from "../connection.js";
import { LoginPage } from "../pages/LoginPage.js";
import { PinSwitchDialog } from "../shell/PinSwitchDialog.js";
import { createMockAuthClient } from "./AuthClient.js";
import { setDeviceIdForTests } from "./device-id.js";
import type { AccessSession } from "./types.js";
import { assertNoAuthSecretsInWebStorage } from "./storage-guard.js";

const DEVICE = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function sampleSession(): AccessSession {
  return Object.freeze({
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
      device_id: DEVICE,
      permission_version: 1,
    }),
    display: Object.freeze({
      store_name: "宏发演示店",
      staff_name: "店员甲",
      org_code: "ORG",
      store_code: "S1",
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

test("App unauthenticated renders login, not counter shell", () => {
  const html = renderToStaticMarkup(
    createElement(App, { enableLiquidGlass: false, initialSession: null }),
  );
  assert.match(html, /data-page="login"/);
  assert.doesNotMatch(html, /data-shell="counter"/);
});

test("App with session renders counter shell and switch affordance", () => {
  const html = renderToStaticMarkup(
    createElement(App, {
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
      enableLiquidGlass: false,
      authClient: client,
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
      enableLiquidGlass: false,
      authClient: client,
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
