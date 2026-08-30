import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { ToastProvider } from "@laundry/ui";
import { createMockAuthClient } from "../auth/AuthClient.js";
import { FULL_STORE_FEATURES } from "../auth/permissions.js";
import type { SessionView } from "../auth/types.js";
import { createMockCommandClient } from "../commands/command-client.js";
import { createMockQueryClient } from "../commands/query-client.js";
import { createMockConnection } from "../connection.js";
import type { AppPorts } from "../host/types.js";
import { App, shellPropsFrom } from "../App.js";
import { hasLocalPrintQueue, PageHost } from "../pages/PageHost.js";
import { CounterShell } from "./CounterShell.js";

const sampleSession: SessionView = Object.freeze({
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

test("App shell mapping preserves the exact injected auth, command, and query ports", () => {
  const ports = appPorts();
  const onSessionChange = () => undefined;
  const props = shellPropsFrom(undefined, undefined, sampleSession, ports, onSessionChange);

  assert.equal(props.authClient, ports.auth);
  assert.equal(props.commandClient, ports.command);
  assert.equal(props.queryClient, ports.query);
  assert.equal(props.photoPort, ports.photo);
  assert.equal(props.onSessionChange, onSessionChange);
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

test("PageHost enables the signed print queue only for a desktop printer capability", () => {
  const unavailable = Object.freeze({
    ok: false as const,
    error: Object.freeze({ code: "UNAVAILABLE", message: "not loaded" }),
  });
  const printerPort = Object.freeze({
    discover: async () => unavailable,
    status: async () => unavailable,
    configure: async () => unavailable,
    testFixedTicket: async () => unavailable,
  });

  assert.equal(hasLocalPrintQueue(undefined), false);
  assert.equal(hasLocalPrintQueue(printerPort), true);
});

test("PageHost settings forwards the desktop printer port to the admin panel", () => {
  const unavailable = Object.freeze({
    ok: false as const,
    error: Object.freeze({ code: "UNAVAILABLE", message: "not loaded" }),
  });
  const html = renderToStaticMarkup(
    createElement(
      ToastProvider,
      null,
      createElement(PageHost, {
        activeId: "settings",
        onNavigate: () => undefined,
        session: sampleSession,
        authClient: createMockAuthClient(),
        commandClient: createMockCommandClient(),
        printerPort: Object.freeze({
          discover: async () => unavailable,
          status: async () => unavailable,
          configure: async () => unavailable,
          testFixedTicket: async () => unavailable,
        }),
      }),
    ),
  );

  assert.match(html, /data-testid="printer-settings"/u);
  assert.match(html, /系统小票打印机/u);
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

test("PageHost delivery route mounts the authoritative order worklist", () => {
  const html = renderToStaticMarkup(
    createElement(
      ToastProvider,
      null,
      createElement(PageHost, {
        activeId: "delivery",
        onNavigate: () => undefined,
        session: sampleSession,
        authClient: createMockAuthClient(),
        commandClient: createMockCommandClient(),
        queryClient: createMockQueryClient(),
      }),
    ),
  );
  assert.match(html, /本页只推进权威配送订单状态/u);
  assert.match(html, /aria-label="取送订单列表"/u);
  assert.match(html, /aria-label="取送订单详情"/u);
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

test("PageHost workbench with session+queryClient mounts three-pane counter workbench", () => {
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
  assert.match(html, /快捷取衣/);
  assert.match(html, /今日看板/);
  assert.match(html, /顾客速查/);
  assert.match(html, /data-testid="counter-workbench-orders"/);
  assert.match(html, />刷新</);
  assert.match(html, /欠款/);
});

test("PageHost reminder route mounts the explicit manual fallback", () => {
  const html = renderToStaticMarkup(
    createElement(
      ToastProvider,
      null,
      createElement(PageHost, {
        activeId: "reminders",
        onNavigate: () => undefined,
        session: sampleSession,
        commandClient: createMockCommandClient(),
        queryClient: createMockQueryClient(),
      }),
    ),
  );
  assert.match(html, /催取工作台/);
  assert.match(html, /人工名单只生成联系材料，不会自行发送短信或微信/);
  assert.match(html, /data-testid="notification-delivery-panel"/);
});

test("App shell SSR includes skip link, sync bar, print indicator when authenticated", () => {
  const html = renderToStaticMarkup(
    createElement(App, {
      ports: appPorts(),
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
        commandClient: createMockCommandClient(),
        queryClient: createMockQueryClient(),
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
        commandClient: createMockCommandClient(),
        queryClient: createMockQueryClient(),
        onSessionChange: () => undefined,
        initialConnection: createMockConnection({ storeName: "宏发演示店" }),
      }),
    ),
  );
  assert.match(html, /打印空闲/);
  assert.match(html, /data-queued="0"/);
  assert.match(html, /data-failed="0"/);
});
