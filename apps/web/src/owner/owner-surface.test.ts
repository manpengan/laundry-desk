import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

import { App, ownerShellPropsFrom } from "../App.js";
import { createMockAuthClient } from "../auth/AuthClient.js";
import { FULL_STORE_FEATURES } from "../auth/permissions.js";
import type { SessionView } from "../auth/types.js";
import { createMockCommandClient } from "../commands/command-client.js";
import { createMockQueryClient } from "../commands/query-client.js";
import type { AppPorts } from "../host/types.js";
import { appSurfaceFromPathname } from "../host/app-surface.js";

function session(
  role: "admin" | "staff",
  features: SessionView["features"] = FULL_STORE_FEATURES,
): SessionView {
  return Object.freeze({
    session: Object.freeze({
      session_id: "aaaaaaaa-bbbb-4ccc-8ddd-111111111111",
      session_version: 1,
      org_id: "aaaaaaaa-bbbb-4ccc-8ddd-222222222222",
      store_id: "aaaaaaaa-bbbb-4ccc-8ddd-333333333333",
      staff_id: "11111111-1111-4111-8111-111111111101",
      device_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      permission_version: 1,
    }),
    role,
    features,
    display: Object.freeze({
      store_name: "测试洗衣店",
      staff_name: role === "admin" ? "店主" : "店员",
      org_code: "ORG",
      store_code: "S1",
    }),
  });
}

function ports(): AppPorts {
  return Object.freeze({
    auth: createMockAuthClient(),
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

test("appSurfaceFromPathname selects only the explicit owner route", () => {
  assert.equal(appSurfaceFromPathname("/owner"), "owner");
  assert.equal(appSurfaceFromPathname("/owner/"), "owner");
  assert.equal(appSurfaceFromPathname("/"), "counter");
  assert.equal(appSurfaceFromPathname("/owner/settings"), "counter");
  assert.equal(appSurfaceFromPathname("/OWNER"), "counter");
});

test("owner login reuses authentication with owner-specific copy", () => {
  const html = renderToStaticMarkup(
    createElement(App, {
      ports: ports(),
      surface: "owner",
      enableLiquidGlass: false,
      initialSession: null,
    }),
  );
  assert.match(html, /data-page="login"/u);
  assert.match(html, /店主登录/u);
  assert.match(html, /进入经营看板/u);
});

test("admin sees the owner shell without counter mutation capabilities", () => {
  const appPorts = ports();
  const onSessionChange = () => undefined;
  const props = ownerShellPropsFrom(session("admin"), appPorts, onSessionChange);
  assert.deepEqual(Object.keys(props).sort(), [
    "authClient",
    "commandClient",
    "onLogout",
    "onSelectStore",
    "onSessionChange",
    "queryClient",
    "session",
  ]);

  const html = renderToStaticMarkup(
    createElement(App, {
      ports: appPorts,
      surface: "owner",
      enableLiquidGlass: false,
      initialSession: session("admin"),
    }),
  );
  assert.match(html, /data-shell="owner"/u);
  assert.match(html, /云端经营台/u);
  assert.match(html, /今日经营/u);
  assert.match(html, /经营报表/u);
  assert.match(html, /门店管理/u);
  assert.match(html, /营销活动/u);
  assert.match(html, /退出登录/u);
  assert.doesNotMatch(html, /data-shell="counter"/u);
  assert.doesNotMatch(html, /切换员工|打印队列|收衣开单|取衣核销|name="pin"/u);
});

test("owner marketing navigation stays hidden when the store feature is off", () => {
  const html = renderToStaticMarkup(
    createElement(App, {
      ports: ports(),
      surface: "owner",
      enableLiquidGlass: false,
      initialSession: session(
        "admin",
        Object.freeze({ ...FULL_STORE_FEATURES, marketing_enabled: false }),
      ),
    }),
  );
  assert.doesNotMatch(html, /营销活动/u);
});

test("owner logout clears the renderer session even when host revocation rejects", async () => {
  let nextSession: SessionView | null = session("admin");
  const appPorts = ports();
  const rejectingPorts: AppPorts = Object.freeze({
    ...appPorts,
    auth: Object.freeze({
      ...appPorts.auth,
      logout: async () => Promise.reject(new Error("host unavailable")),
    }),
  });
  const props = ownerShellPropsFrom(session("admin"), rejectingPorts, (next) => {
    nextSession = next;
  });

  await props.onLogout();

  assert.equal(nextSession, null);
});

test("staff receives an explicit owner denial without dashboard content", () => {
  const html = renderToStaticMarkup(
    createElement(App, {
      ports: ports(),
      surface: "owner",
      enableLiquidGlass: false,
      initialSession: session("staff"),
    }),
  );
  assert.match(html, /data-owner-access="denied"/u);
  assert.match(html, /当前员工账号没有查看经营看板的权限/u);
  assert.doesNotMatch(html, /data-testid="owner-dashboard"/u);
  assert.doesNotMatch(html, /data-shell="counter"/u);
});

test("host entry selects the pathname surface and loads the isolated owner stylesheet", async () => {
  const source = await readFile(new URL("../../host/main.tsx", import.meta.url), "utf8");
  const operationsStyles = await readFile(
    new URL("../../src/styles/owner-operations.css", import.meta.url),
    "utf8",
  );
  const managementStyles = await readFile(
    new URL("../../src/styles/owner-management.css", import.meta.url),
    "utf8",
  );

  assert.match(source, /appSurfaceFromPathname\(window\.location\.pathname\)/u);
  assert.match(source, /surface=\{surface\}/u);
  assert.match(source, /import\s+["']\.\.\/src\/styles\/owner-dashboard\.css["'];/u);
  assert.match(source, /import\s+["']\.\.\/src\/styles\/owner-operations\.css["'];/u);
  assert.match(source, /import\s+["']\.\.\/src\/styles\/owner-management\.css["'];/u);
  assert.match(operationsStyles, /\.ld-owner-operations \.ld-btn\s*\{[^}]*min-height: 44px;/su);
  assert.match(operationsStyles, /\.ld-owner-metric__action\s*\{[^}]*min-height: 44px;/su);
  assert.match(managementStyles, /\.ld-owner-management > \.ld-btn\s*\{[^}]*min-height: 44px;/su);
});
