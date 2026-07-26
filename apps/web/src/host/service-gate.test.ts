import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  createServiceGateController,
  ServiceGate,
  ServiceGateView,
  type ServiceGateState,
} from "./ServiceGate.js";
import type { HealthResult } from "./types.js";

test("service gate starts pending and exposes a diagnostic after an unreachable check", async () => {
  const states: ServiceGateState[] = [];
  const results: HealthResult[] = [
    {
      ok: false,
      error: { code: "SERVICE_UNAVAILABLE", message: "无法连接本地服务" },
    },
  ];
  const controller = createServiceGateController(
    {
      get: async () =>
        results.shift() ?? {
          ok: false,
          error: { code: "SERVICE_UNAVAILABLE", message: "无测试结果" },
        },
    },
    (state) => states.push(state),
  );

  const pending = controller.check();
  assert.deepEqual(states, [{ status: "checking" }]);
  await pending;
  assert.deepEqual(states, [
    { status: "checking" },
    { status: "unreachable", message: "无法连接本地服务" },
  ]);

  const markup = renderToStaticMarkup(
    createElement(ServiceGateView, {
      state: states[1] ?? { status: "checking" },
      onRetry: () => undefined,
      children: createElement("div", null, "Login should stay hidden"),
    }),
  );
  assert.match(markup, /本地服务尚未就绪/u);
  assert.match(markup, /无法连接本地服务/u);
  assert.match(markup, /重试/u);
  assert.doesNotMatch(markup, /Login should stay hidden/u);
});

test("service gate retry calls health again and enters ready only after success", async () => {
  const states: ServiceGateState[] = [];
  let calls = 0;
  const controller = createServiceGateController(
    {
      get: async () => {
        calls += 1;
        return calls === 1
          ? {
              ok: false as const,
              error: { code: "SERVICE_UNAVAILABLE", message: "本地服务启动中" },
            }
          : { ok: true as const, data: { status: "ready" as const } };
      },
    },
    (state) => states.push(state),
  );

  await controller.check();
  await controller.check();

  assert.equal(calls, 2);
  assert.deepEqual(states.at(-1), { status: "ready" });
  const markup = renderToStaticMarkup(
    createElement(ServiceGateView, {
      state: states.at(-1) ?? { status: "checking" },
      onRetry: () => undefined,
      children: createElement("div", { "data-page": "login" }, "柜台登录"),
    }),
  );
  assert.match(markup, /data-page="login"/u);
  assert.match(markup, /柜台登录/u);
});

test("service gate loading view hides app children", () => {
  const markup = renderToStaticMarkup(
    createElement(ServiceGateView, {
      state: { status: "checking" },
      onRetry: () => undefined,
      children: createElement("div", null, "Login should stay hidden"),
    }),
  );

  assert.match(markup, /正在连接本地服务/u);
  assert.doesNotMatch(markup, /Login should stay hidden/u);
});

test("ServiceGate component renders a closed loading gate before its first effect", () => {
  const markup = renderToStaticMarkup(
    createElement(ServiceGate, {
      health: {
        get: async () => ({ ok: true as const, data: { status: "ready" as const } }),
      },
      children: createElement("div", null, "App must wait"),
    }),
  );

  assert.match(markup, /正在连接本地服务/u);
  assert.doesNotMatch(markup, /App must wait/u);
});

test("service gate turns a thrown health check into an actionable diagnostic", async () => {
  const states: ServiceGateState[] = [];
  const controller = createServiceGateController(
    {
      get: () => Promise.reject(new Error("connection refused at a private address")),
    },
    (state) => states.push(state),
  );

  await assert.doesNotReject(controller.check());
  assert.deepEqual(states, [
    { status: "checking" },
    {
      status: "unreachable",
      message: "无法连接本地服务，请确认服务已启动后重试",
    },
  ]);
  assert.doesNotMatch(JSON.stringify(states), /private address/u);
});

test("service gate ignores a late result after disposal", async () => {
  const states: ServiceGateState[] = [];
  let resolveHealth: ((result: HealthResult) => void) | undefined;
  const controller = createServiceGateController(
    {
      get: () =>
        new Promise<HealthResult>((resolve) => {
          resolveHealth = resolve;
        }),
    },
    (state) => states.push(state),
  );

  const pending = controller.check();
  controller.dispose();
  resolveHealth?.({ ok: true, data: { status: "ready" } });
  await pending;

  assert.deepEqual(states, [{ status: "checking" }]);
  await controller.check();
  assert.deepEqual(states, [{ status: "checking" }]);
});
