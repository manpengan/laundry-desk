import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { ToastProvider } from "@laundry/ui";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { createMockQueryClient } from "../commands/query-client.js";
import type { QueryPort } from "../commands/types.js";
import { policyRetryDelay, useReceiveResources } from "./use-receive-resources.js";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const settle = () => act(async () => new Promise((resolve) => setImmediate(resolve)));

function flakyPolicy(failFirst: number) {
  const real = createMockQueryClient();
  const calls = { policy: 0 };
  const query: QueryPort = Object.freeze({
    async execute<T = unknown>(name: string, body: unknown = {}) {
      if (name === "pricing.policy.get") {
        calls.policy += 1;
        if (calls.policy <= failFirst) {
          return Object.freeze({
            ok: false as const,
            error: Object.freeze({ code: "UNAVAILABLE", message: "本机服务未就绪" }),
          });
        }
      }
      return real.execute<T>(name, body);
    },
  });
  return { query, calls };
}

function mount(query: QueryPort) {
  const state = { ready: false, retry: () => undefined as void };
  function Probe() {
    const { policyReady, reloadPolicy } = useReceiveResources(query);
    state.ready = policyReady;
    state.retry = reloadPolicy;
    return null;
  }
  let renderer!: ReactTestRenderer;
  const mounted = act(async () => {
    renderer = create(
      <ToastProvider>
        <Probe />
      </ToastProvider>,
    );
  });
  return { state, mounted, renderer: () => renderer };
}

const toasts = (renderer: ReactTestRenderer) =>
  (JSON.stringify(renderer.toJSON()).match(/本机服务未就绪/gu) ?? []).length;

test("pricing reads back off 1s, 2s, 4s, 8s and then every 15s", () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 12].map(policyRetryDelay),
    [1000, 1000, 2000, 4000, 8000, 15_000, 15_000],
  );
});

test("a failed pricing read retries by itself and re-enables 开单", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { query, calls } = flakyPolicy(1);
    const view = mount(query);
    await view.mounted;
    await settle();
    assert.equal(calls.policy, 1);
    assert.equal(view.state.ready, false);
    await act(async () => mock.timers.tick(999));
    await settle();
    assert.equal(calls.policy, 1, "waits for the back-off");
    await act(async () => mock.timers.tick(1));
    await settle();
    assert.equal(calls.policy, 2);
    assert.equal(view.state.ready, true);
    await act(async () => view.renderer().unmount());
  } finally {
    mock.timers.reset();
  }
});

test("an outage toasts once, and 重新读取 reads at once", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { query, calls } = flakyPolicy(3);
    const view = mount(query);
    await view.mounted;
    await settle();
    await act(async () => mock.timers.tick(1000));
    await settle();
    assert.equal(calls.policy, 2);
    assert.equal(toasts(view.renderer()), 1, "the hint carries on; no toast storm");
    await act(async () => view.state.retry());
    await settle();
    assert.equal(calls.policy, 3, "manual retry does not wait for the timer");
    assert.equal(view.state.ready, false);
    await act(async () => view.state.retry());
    await settle();
    assert.equal(calls.policy, 4);
    assert.equal(view.state.ready, true);
    await act(async () => view.renderer().unmount());
  } finally {
    mock.timers.reset();
  }
});
