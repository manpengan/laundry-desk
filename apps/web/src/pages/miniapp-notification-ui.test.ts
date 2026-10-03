import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type {
  CommandPort,
  QueryPort,
  CommandResult,
  CommandExecutionOptions,
} from "../commands/types.js";
import { MiniappNotificationPanel } from "./MiniappNotificationPanel.js";
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const config = {
  version: 1,
  available: true,
  enabled: true,
  template_id: "approved_template",
  ticket_field: "character_string1",
  store_field: "thing2",
  status_field: "phrase3",
  miniprogram_state: "trial",
};
function click(renderer: ReactTestRenderer, label: string) {
  const node = renderer.root
    .findAllByType("button")
    .find((item) => item.children.join("") === label);
  assert.ok(node, label);
  (node.props.onClick as () => void)();
}
const query: QueryPort = {
  async execute<T>(name: string) {
    return { ok: true, data: (name.endsWith("settings.get") ? config : { items: [] }) as T };
  },
};
test("WeChat settings confirmation resumes only the frozen reference", async () => {
  const previousDocument = Reflect.get(globalThis, "document"),
    previousElement = Reflect.get(globalThis, "HTMLElement");
  Reflect.set(globalThis, "HTMLElement", class {});
  Reflect.set(globalThis, "document", {
    activeElement: null,
    addEventListener() {},
    removeEventListener() {},
  });
  const calls: { name: string; body: unknown; options: CommandExecutionOptions | undefined }[] = [];
  const command: CommandPort = {
    async execute<T>(name: string, body?: unknown, options?: CommandExecutionOptions) {
      calls.push({ name, body, options });
      return calls.length === 1
        ? {
            ok: false,
            error: {
              code: "POLICY_CONFIRMATION_REQUIRED",
              detail: { confirm_ref: "synthetic-ref" },
            },
          }
        : { ok: true, data: {} as T };
    },
  };
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(
        createElement(MiniappNotificationPanel, {
          commandClient: command,
          queryClient: query,
          sessionKey: "first",
        }),
      );
    });
    await act(async () => {
      click(renderer, "保存通知配置");
    });
    assert.match(JSON.stringify(renderer.toJSON()), /approved_template/u);
    await act(async () => {
      click(renderer, "确认执行");
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.name, "notification.wechat.settings.set");
    assert.deepEqual(calls[1]?.body, {});
    assert.deepEqual(calls[1]?.options, { confirmRef: "synthetic-ref" });
  } finally {
    if (renderer) await act(() => renderer.unmount());
    if (previousDocument === undefined) Reflect.deleteProperty(globalThis, "document");
    else Reflect.set(globalThis, "document", previousDocument);
    if (previousElement === undefined) Reflect.deleteProperty(globalThis, "HTMLElement");
    else Reflect.set(globalThis, "HTMLElement", previousElement);
  }
});
test("late configuration responses cannot repopulate a replaced session", async () => {
  let resolveOld: ((value: CommandResult<unknown>) => void) | undefined;
  let reads = 0,
    lists = 0;
  const deferred: QueryPort = {
    async execute<T>(name: string) {
      if (name.endsWith("settings.get")) {
        reads++;
        if (reads === 1)
          return new Promise<CommandResult<T>>((resolve) => {
            resolveOld = resolve as (value: CommandResult<unknown>) => void;
          });
        return { ok: true, data: { ...config, template_id: "current_template" } as T };
      }
      lists++;
      return { ok: true, data: { items: [] } as T };
    },
  };
  const command: CommandPort = {
    async execute<T>() {
      return { ok: true, data: {} as T };
    },
  };
  let renderer!: ReactTestRenderer;
  await act(() => {
    renderer = create(
      createElement(MiniappNotificationPanel, {
        commandClient: command,
        queryClient: deferred,
        sessionKey: "first",
      }),
    );
  });
  try {
    await act(async () => {
      renderer.update(
        createElement(MiniappNotificationPanel, {
          commandClient: command,
          queryClient: deferred,
          sessionKey: "second",
        }),
      );
    });
    assert.equal(lists, 1);
    assert.ok(resolveOld);
    const settle = resolveOld;
    await act(async () => {
      settle({ ok: true, data: { ...config, template_id: "stale_template" } });
    });
    const html = JSON.stringify(renderer.toJSON());
    assert.match(html, /current_template/u);
    assert.doesNotMatch(html, /stale_template/u);
    assert.equal(lists, 1);
  } finally {
    await act(() => renderer.unmount());
  }
});
