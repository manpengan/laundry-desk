import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { ToastProvider } from "@laundry/ui";
import {
  FULL_STORE_FEATURES,
  STAFF_STORE_FEATURES,
  permissionContextFrom,
} from "../auth/permissions.js";
import { createMockAuthClient } from "../auth/AuthClient.js";
import type { SessionView } from "../auth/types.js";
import { assertNoAuthSecretsInWebStorage } from "../auth/storage-guard.js";
import { createMockCommandClient } from "../commands/command-client.js";
import { createMockQueryClient } from "../commands/query-client.js";
import { createMockConnection } from "../connection.js";
import type { AppPorts } from "../host/types.js";
import { CounterShell } from "../shell/CounterShell.js";
import { App } from "../App.js";
import { DENIED_PAGE_COPY, resolveRouteGate, visibleNavItems } from "./route-gate.js";
import { RouteGate } from "./RouteGate.js";

function sessionOf(
  role: SessionView["role"],
  features: SessionView["features"] = role === "admin" ? FULL_STORE_FEATURES : STAFF_STORE_FEATURES,
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
    features: Object.freeze({ ...features }),
    display: Object.freeze({
      store_name: "宏发演示店",
      staff_name: role === "admin" ? "店长" : "店员甲",
      org_code: "ORG",
      store_code: "S1",
    }),
  });
}

function appPorts(): AppPorts {
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

test("resolveRouteGate allows admin on settings", () => {
  const decision = resolveRouteGate(
    permissionContextFrom("admin", FULL_STORE_FEATURES),
    "settings",
  );
  assert.equal(decision.status, "allow");
});

test("resolveRouteGate denies staff on settings with fallback", () => {
  const decision = resolveRouteGate(
    permissionContextFrom("staff", STAFF_STORE_FEATURES),
    "settings",
  );
  assert.equal(decision.status, "deny");
  if (decision.status !== "deny") return;
  assert.equal(decision.navId, "settings");
  assert.equal(decision.fallbackId, "workbench");
});

test("visibleNavItems for staff omits stats and settings", () => {
  const items = visibleNavItems(permissionContextFrom("staff", STAFF_STORE_FEATURES));
  const ids = items.map((i) => i.id);
  assert.deepEqual(ids, ["workbench", "receive", "pickup", "orders", "customers"]);
});

test("RouteGate denied SSR shows 无权限 EmptyState without crash", () => {
  const html = renderToStaticMarkup(
    createElement(RouteGate, {
      permission: permissionContextFrom("staff", STAFF_STORE_FEATURES),
      activeId: "settings",
      onNavigate: () => undefined,
      children: createElement("div", { "data-secret": "should-not-render" }, "secret"),
    }),
  );
  assert.match(html, /data-route-gate="denied"/);
  assert.match(html, /无权限/);
  assert.match(html, new RegExp(DENIED_PAGE_COPY.description.slice(0, 8)));
  assert.doesNotMatch(html, /data-secret/);
  assert.doesNotMatch(html, /should-not-render/);
});

test("direct navigation to denied route in CounterShell shows empty/denied state", () => {
  const html = renderToStaticMarkup(
    createElement(
      ToastProvider,
      null,
      createElement(CounterShell, {
        session: sessionOf("staff"),
        authClient: createMockAuthClient(),
        commandClient: createMockCommandClient(),
        queryClient: createMockQueryClient(),
        onSessionChange: () => undefined,
        initialNav: "settings",
        initialConnection: createMockConnection({ storeName: "宏发演示店" }),
      }),
    ),
  );
  assert.match(html, /data-route-gate="denied"/);
  assert.match(html, /data-denied-nav="settings"/);
  assert.match(html, /无权限/);
  assert.match(html, /data-role="staff"/);
  // Sidebar must not list settings for staff
  assert.doesNotMatch(html, /data-nav-id="settings"/);
  assert.doesNotMatch(html, /data-nav-id="stats"/);
  assert.match(html, /data-nav-id="workbench"/);
  assertNoAuthSecretsInWebStorage();
});

test("admin CounterShell sidebar includes all nav ids", () => {
  const html = renderToStaticMarkup(
    createElement(
      ToastProvider,
      null,
      createElement(CounterShell, {
        session: sessionOf("admin"),
        authClient: createMockAuthClient(),
        commandClient: createMockCommandClient(),
        queryClient: createMockQueryClient(),
        onSessionChange: () => undefined,
        initialConnection: createMockConnection(),
      }),
    ),
  );
  assert.match(html, /data-role="admin"/);
  for (const id of ["workbench", "receive", "pickup", "customers", "stats", "settings"]) {
    assert.match(html, new RegExp(`data-nav-id="${id}"`));
  }
  assert.doesNotMatch(html, /data-route-gate="denied"/);
});

test("App with staff session still memory-only (no tokens in localStorage)", () => {
  const html = renderToStaticMarkup(
    createElement(App, {
      ports: appPorts(),
      enableLiquidGlass: false,
      initialSession: sessionOf("staff"),
    }),
  );
  assert.match(html, /data-shell="counter"/);
  assert.match(html, /data-role="staff"/);
  assertNoAuthSecretsInWebStorage();
  // sanity: staff shell still renders without secrets side effects
  assert.ok(html.length > 0);
});
