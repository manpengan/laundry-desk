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
import type { AccessSession } from "../auth/types.js";
import { assertNoAuthSecretsInWebStorage } from "../auth/storage-guard.js";
import { createMockConnection } from "../connection.js";
import { CounterShell } from "../shell/CounterShell.js";
import { App } from "../App.js";
import { DENIED_PAGE_COPY, resolveRouteGate, visibleNavItems } from "./route-gate.js";
import { RouteGate } from "./RouteGate.js";

function sessionOf(
  role: AccessSession["role"],
  features: AccessSession["features"] = role === "admin"
    ? FULL_STORE_FEATURES
    : STAFF_STORE_FEATURES,
): AccessSession {
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
  assert.deepEqual(ids, ["workbench", "receive", "pickup", "customers"]);
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
