import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { App } from "../App.js";
import { createMockAuthClient } from "../auth/AuthClient.js";
import type { SessionView } from "../auth/types.js";
import { createMockCommandClient } from "../commands/command-client.js";
import { createMockQueryClient } from "../commands/query-client.js";
import { appSurfaceFromPathname, shouldResumeHostSession } from "../host/app-surface.js";
import type { AppPorts } from "../host/types.js";

function session(deliveryEnabled: boolean): SessionView {
  return Object.freeze({
    session: Object.freeze({
      session_id: "11111111-1111-4111-8111-111111111111",
      session_version: 1,
      org_id: "22222222-2222-4222-8222-222222222222",
      store_id: "33333333-3333-4333-8333-333333333333",
      staff_id: "44444444-4444-4444-8444-444444444444",
      device_id: "55555555-5555-4555-8555-555555555555",
      permission_version: 1,
    }),
    role: "staff",
    features: Object.freeze({ delivery_enabled: deliveryEnabled }),
    display: Object.freeze({
      store_name: "窄屏测试门店",
      staff_name: "配送员工甲",
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

test("only the exact mobile task pathname selects the mobile surface", () => {
  assert.equal(appSurfaceFromPathname("/mobile/tasks"), "mobile_delivery_tasks");
  assert.equal(appSurfaceFromPathname("/mobile/tasks/"), "mobile_delivery_tasks");
  assert.equal(appSurfaceFromPathname("/mobile"), "counter");
  assert.equal(appSurfaceFromPathname("/mobile/tasks/1"), "counter");
  assert.equal(appSurfaceFromPathname("/MOBILE/TASKS"), "counter");
});

test("browser refresh-cookie resume is mobile-only while desktop resume stays enabled", () => {
  assert.equal(shouldResumeHostSession("browser", "mobile_delivery_tasks"), true);
  assert.equal(shouldResumeHostSession("browser", "counter"), false);
  assert.equal(shouldResumeHostSession("browser", "owner"), false);
  assert.equal(shouldResumeHostSession("desktop", "counter"), true);
});

test("mobile unauthenticated route renders dedicated safe login copy", () => {
  const html = renderToStaticMarkup(
    createElement(App, {
      ports: ports(),
      surface: "mobile_delivery_tasks",
      enableLiquidGlass: false,
      initialSession: null,
    }),
  );
  assert.match(html, /data-page="login"/u);
  assert.match(html, /配送任务登录/u);
  assert.match(html, /当前门店员工账号/u);
  assert.doesNotMatch(html, /data-shell="counter"|data-shell="owner"/u);
});

test("authenticated mobile route exposes my-task controls without admin or Item6 surfaces", () => {
  const html = renderToStaticMarkup(
    createElement(App, {
      ports: ports(),
      surface: "mobile_delivery_tasks",
      enableLiquidGlass: false,
      initialSession: session(false),
    }),
  );
  assert.match(html, /data-shell="mobile-delivery-tasks"/u);
  assert.match(html, /我的配送任务/u);
  assert.match(html, /取送新订单入口已关闭；已存在的任务仍可接拒并安全收口/u);
  assert.match(html, /href="#mobile-task-main"/u);
  assert.match(html, /aria-label="任务范围"/u);
  assert.doesNotMatch(html, /转派任务|人工接管|上传照片|采集签名|获取定位/u);
  assert.doesNotMatch(
    html,
    /11111111-1111-4111-8111-111111111111|22222222-2222-4222-8222-222222222222/u,
  );
  assert.doesNotMatch(html, /data-shell="counter"|data-shell="owner"/u);
});

test("host entry and stylesheet keep mobile resume and narrow-screen accessibility explicit", async () => {
  const hostSource = await readFile(new URL("../../host/main.tsx", import.meta.url), "utf8");
  const styles = await readFile(
    new URL("../../src/styles/mobile-delivery-tasks.css", import.meta.url),
    "utf8",
  );
  assert.match(hostSource, /shouldResumeHostSession\(host\.kind, surface\)/u);
  assert.match(hostSource, /mobile-delivery-tasks\.css/u);
  assert.match(styles, /@media \(max-width: 720px\)/u);
  assert.match(styles, /@media \(max-width: 390px\)/u);
  assert.match(styles, /min-height: 48px/u);
  assert.match(styles, /prefers-reduced-motion: reduce/u);
  assert.match(styles, /env\(safe-area-inset-bottom\)/u);
});
