import assert from "node:assert/strict";
import test from "node:test";
import { createElement, useState } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { ToastProvider } from "@laundry/ui";
import { createMockAuthClient } from "../auth/AuthClient.js";
import type { SessionView } from "../auth/types.js";
import { createMockQueryClient } from "../commands/query-client.js";
import { SettingsLayout, type SettingsSection } from "./SettingsLayout.js";
import { readSettingsSection, saveSettingsSection } from "./settings-navigation.js";
import { StatsPage } from "./StatsPage.js";
import {
  readScalePreferences,
  saveScalePreferences,
  SCALE_PREFERENCES_KEY,
} from "./scale-preferences.js";
import type { PreferenceStorage } from "./device-preference-storage.js";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
function storage(): PreferenceStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}
function installStorage(value: PreferenceStorage) {
  const previousWindow = Reflect.get(globalThis, "window");
  const previousRaf = Reflect.get(globalThis, "requestAnimationFrame");
  Reflect.set(globalThis, "window", { localStorage: value });
  Reflect.set(globalThis, "requestAnimationFrame", (callback: () => void) => {
    callback();
    return 1;
  });
  return () => {
    if (previousWindow === undefined) Reflect.deleteProperty(globalThis, "window");
    else Reflect.set(globalThis, "window", previousWindow);
    if (previousRaf === undefined) Reflect.deleteProperty(globalThis, "requestAnimationFrame");
    else Reflect.set(globalThis, "requestAnimationFrame", previousRaf);
  };
}
function Draft() {
  const [value, setValue] = useState("");
  return (
    <input
      aria-label="测试草稿"
      value={value}
      onChange={(event) => setValue(event.currentTarget.value)}
    />
  );
}
const SESSION: SessionView = {
  session: {
    session_id: "s",
    session_version: 1,
    org_id: "o",
    store_id: "store",
    staff_id: "staff",
    device_id: "d",
    permission_version: 1,
  },
  role: "staff",
  features: {},
  display: { store_name: "演示店", staff_name: "测试", org_code: "ORG", store_code: "S1" },
};
const sections: readonly SettingsSection[] = [
  { id: "settings-catalog", label: "价目", icon: "settings", content: <Draft /> },
  { id: "settings-appearance", label: "外观", icon: "settings", content: <span>主题设置</span> },
  { id: "settings-migration", label: "迁移", icon: "settings", content: <span>旧版数据</span> },
];
function click(renderer: ReactTestRenderer, label: string) {
  const button = renderer.root
    .findAllByType("button")
    .find((node) => node.children.join("") === label);
  assert.ok(button, label);
  (button.props.onClick as () => void)();
}
function selectSection(renderer: ReactTestRenderer, id: string) {
  (
    renderer.root.findByType("select").props.onChange as (event: {
      target: { value: string };
    }) => void
  )({ target: { value: id } });
}

test("settings remember only a currently permitted section and fall back to common settings", () => {
  const saved = storage();
  assert.equal(
    readSettingsSection(["settings-appearance", "settings-catalog"], saved).selected,
    "settings-catalog",
  );
  assert.equal(saveSettingsSection("settings-migration", saved), null);
  assert.equal(readSettingsSection(["settings-catalog"], saved).selected, "settings-catalog");
  assert.equal(
    readSettingsSection(["settings-catalog", "settings-migration"], saved).selected,
    "settings-migration",
  );
  assert.deepEqual([...saved.values.values()], ['"settings-migration"']);
});

test("settings selection, advanced search and returning preserve an edited mounted form", async () => {
  const saved = storage();
  saveSettingsSection("settings-appearance", saved);
  const restore = installStorage(saved);
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(
        <SettingsLayout
          sections={sections}
          session={SESSION}
          authClient={createMockAuthClient()}
        />,
      );
    });
    assert.equal(renderer.root.findByProps({ id: "settings-catalog" }).props.hidden, true);
    assert.equal(renderer.root.findByProps({ id: "settings-appearance" }).props.hidden, false);
    await act(async () => {
      selectSection(renderer, "settings-catalog");
    });
    await act(async () => {
      (
        renderer.root.findByProps({ "aria-label": "测试草稿" }).props.onChange as (event: {
          currentTarget: { value: string };
        }) => void
      )({ currentTarget: { value: "未保存价格" } });
      selectSection(renderer, "settings-appearance");
    });
    await act(async () => {
      (
        renderer.root.findByProps({ name: "settings-search" }).props.onChange as (event: {
          target: { value: string };
        }) => void
      )({ target: { value: "旧版" } });
    });
    assert.equal(renderer.root.findByProps({ id: "settings-migration" }).props.hidden, false);
    await act(async () => {
      selectSection(renderer, "settings-catalog");
    });
    assert.equal(renderer.root.findByProps({ "aria-label": "测试草稿" }).props.value, "未保存价格");
    assert.equal(
      readSettingsSection(
        sections.map((section) => section.id),
        saved,
      ).selected,
      "settings-catalog",
    );
  } finally {
    if (renderer) await act(async () => renderer.unmount());
    restore();
  }
});

test("settings storage failure remains visible without blocking selection", async () => {
  const restore = installStorage({
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("quota");
    },
  });
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(
        <SettingsLayout
          sections={sections}
          session={SESSION}
          authClient={createMockAuthClient()}
        />,
      );
    });
    assert.match(JSON.stringify(renderer.toJSON()), /偏好设置读取失败/u);
    await act(async () => selectSection(renderer, "settings-appearance"));
    assert.match(JSON.stringify(renderer.toJSON()), /偏好设置保存失败/u);
    assert.equal(renderer.root.findByProps({ id: "settings-appearance" }).props.hidden, false);
  } finally {
    if (renderer) await act(async () => renderer.unmount());
    restore();
  }
});

test("scale persistence accepts only connection configuration and exposes invalid or failed storage", () => {
  const saved = storage();
  const config = { operation: "read", port: "COM7", baud: 9600, framing: "8N1" };
  assert.equal(saveScalePreferences(config, saved), null);
  assert.deepEqual(readScalePreferences(saved).value, { port: "COM7", baud: 9600, framing: "8N1" });
  assert.match(saveScalePreferences({ ...config, grams: 1250 }, saved) ?? "", /请选择串口/u);
  assert.doesNotMatch(
    saved.values.get(SCALE_PREFERENCES_KEY) ?? "",
    /grams|captured_at|staff|session/u,
  );
  saved.values.set(SCALE_PREFERENCES_KEY, JSON.stringify({ ...config, reading: 99 }));
  assert.equal(readScalePreferences(saved).value, null);
  assert.match(readScalePreferences(saved).error ?? "", /设置无效/u);
  assert.match(saveScalePreferences(config, null) ?? "", /无法保存/u);
});

test("stats separates daily overview from history while retaining filters across tabs", async () => {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      createElement(
        ToastProvider,
        null,
        createElement(StatsPage, {
          queryClient: createMockQueryClient(),
          autoLoad: false,
          defaultDate: "2026-10-06",
        }),
      ),
    );
  });
  try {
    const panels = renderer.root.findAllByProps({ role: "tabpanel" });
    assert.equal(panels.length, 3);
    assert.equal(panels[0]?.props.hidden, false);
    const modes = renderer.root.findAllByProps({ "data-testid": "accounting-mode" });
    assert.deepEqual(
      modes[0]?.findAllByType("option").map((node) => node.props.value),
      ["today"],
    );
    assert.deepEqual(
      modes[1]?.findAllByType("option").map((node) => node.props.value),
      ["history", "month", "staff"],
    );
    await act(async () => click(renderer, "历史报表与对账"));
    const historicalMode = modes[1];
    assert.ok(historicalMode);
    await act(async () =>
      (historicalMode.props.onChange as (event: { target: { value: string } }) => void)({
        target: { value: "month" },
      }),
    );
    await act(async () => {
      const month = renderer.root.findByProps({ "data-testid": "accounting-month" });
      (month.props.onChange as (event: { target: { value: string } }) => void)({
        target: { value: "2026-09" },
      });
      click(renderer, "交班");
    });
    await act(async () => click(renderer, "历史报表与对账"));
    assert.equal(
      renderer.root.findByProps({ "data-testid": "accounting-month" }).props.value,
      "2026-09",
    );
    assert.equal(renderer.root.findAllByProps({ role: "tabpanel" })[2]?.props.hidden, false);
    let focused = false;
    const tab = renderer.root.findAllByProps({ role: "tab" })[2];
    assert.ok(tab);
    await act(async () => {
      (
        tab.props.onKeyDown as (event: {
          key: string;
          preventDefault: () => void;
          currentTarget: { parentElement: { querySelector: () => { focus: () => void } } };
        }) => void
      )({
        key: "Home",
        preventDefault() {},
        currentTarget: {
          parentElement: {
            querySelector: () => ({
              focus: () => {
                focused = true;
              },
            }),
          },
        },
      });
    });
    assert.equal(renderer.root.findAllByProps({ role: "tabpanel" })[0]?.props.hidden, false);
    assert.equal(
      renderer.root.findAllByProps({ role: "tab" }).filter((node) => node.props.tabIndex === 0)
        .length,
      1,
    );
    assert.equal(focused, true);
  } finally {
    await act(async () => renderer.unmount());
  }
});
