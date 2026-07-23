import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { ToastProvider } from "@laundry/ui";
import { createMockAuthClient } from "../auth/AuthClient.js";
import { FULL_STORE_FEATURES } from "../auth/permissions.js";
import type { AccessSession } from "../auth/types.js";
import { createMockCommandClient } from "../commands/command-client.js";
import { createMockQueryClient } from "../commands/query-client.js";
import { createMockConnection } from "../connection.js";
import { App } from "../App.js";
import { PageHost } from "../pages/PageHost.js";
import { CounterShell } from "./CounterShell.js";

const sampleSession: AccessSession = Object.freeze({
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

test("PageHost empty state for receive without session uses fallback copy", () => {
  const html = renderToStaticMarkup(
    createElement(PageHost, {
      activeId: "receive",
      onNavigate: () => undefined,
    }),
  );
  assert.match(html, /开单/);
  assert.match(html, /登录后开单/);
  assert.match(html, /role="status"/);
});

test("PageHost receive with session+commandClient mounts ReceivePage form", () => {
  const html = renderToStaticMarkup(
    createElement(
      ToastProvider,
      null,
      createElement(PageHost, {
        activeId: "receive",
        onNavigate: () => undefined,
        session: sampleSession,
        authClient: createMockAuthClient(),
        commandClient: createMockCommandClient(),
      }),
    ),
  );
  assert.match(html, /确认开单/);
  assert.match(html, /衣物明细/);
  assert.doesNotMatch(html, /登录后开单/);
});

test("PageHost pickup with session+commandClient mounts PickupPage form", () => {
  const html = renderToStaticMarkup(
    createElement(
      ToastProvider,
      null,
      createElement(PageHost, {
        activeId: "pickup",
        onNavigate: () => undefined,
        session: sampleSession,
        authClient: createMockAuthClient(),
        commandClient: createMockCommandClient(),
      }),
    ),
  );
  assert.match(html, /确认取衣/);
  assert.match(html, /订单 ID/);
});

test("PageHost loading exposes aria-busy skeleton", () => {
  const html = renderToStaticMarkup(
    createElement(PageHost, {
      activeId: "workbench",
      loading: true,
      onNavigate: () => undefined,
    }),
  );
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /ld-skeleton/);
});

test("PageHost workbench with session+queryClient mounts OrdersList", () => {
  const html = renderToStaticMarkup(
    createElement(
      ToastProvider,
      null,
      createElement(PageHost, {
        activeId: "workbench",
        onNavigate: () => undefined,
        session: sampleSession,
        queryClient: createMockQueryClient(),
      }),
    ),
  );
  assert.match(html, /工作台/);
  assert.match(html, /近期订单/);
  assert.match(html, /data-testid="orders-list"/);
  assert.match(html, /刷新列表/);
  assert.match(html, /data-testid="debt-section"/);
  assert.match(html, /data-testid="debt-load-btn"/);
  assert.match(html, /欠款/);
});

test("App shell SSR includes skip link, sync bar, print indicator when authenticated", () => {
  const html = renderToStaticMarkup(
    createElement(App, {
      enableLiquidGlass: false,
      initialSession: sampleSession,
      connection: createMockConnection({
        storeName: "宏发演示店",
        mode: "offline",
        pendingSyncCount: 2,
      }),
      themePreference: "light",
    }),
  );
  assert.match(html, /跳到主内容/);
  assert.match(html, /宏发演示店/);
  assert.match(html, /离线/);
  assert.match(html, /data-shell="counter"/);
  assert.match(html, /打印/);
  assert.match(html, /切换员工/);
});

test("CounterShell wires PIN switch affordance", () => {
  const html = renderToStaticMarkup(
    createElement(
      ToastProvider,
      null,
      createElement(CounterShell, {
        session: sampleSession,
        authClient: createMockAuthClient(),
        onSessionChange: () => undefined,
        initialConnection: createMockConnection({ storeName: "宏发演示店" }),
      }),
    ),
  );
  assert.match(html, /切换员工/);
  assert.match(html, /data-shell="counter"/);
});

test("CounterShell print indicator idle by default (self-managed SSR first paint)", () => {
  const html = renderToStaticMarkup(
    createElement(
      ToastProvider,
      null,
      createElement(CounterShell, {
        session: sampleSession,
        authClient: createMockAuthClient(),
        onSessionChange: () => undefined,
        initialConnection: createMockConnection({ storeName: "宏发演示店" }),
      }),
    ),
  );
  assert.match(html, /打印空闲/);
  assert.match(html, /data-queued="0"/);
  assert.match(html, /data-failed="0"/);
});
