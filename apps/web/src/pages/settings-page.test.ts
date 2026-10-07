import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import test from "node:test";
import { ToastProvider } from "@laundry/ui";
import { createMockAuthClient } from "../auth/AuthClient.js";
import { FULL_STORE_FEATURES } from "../auth/permissions.js";
import type { SessionView } from "../auth/types.js";
import { createMockCommandClient } from "../commands/command-client.js";
import { createMockQueryClient } from "../commands/query-client.js";
import type { PrinterPort } from "../host/printer-port.js";
import type { RemoteAssistancePort } from "../host/remote-assistance-port.js";
import { PRINTER_PATH_ENV_NAME, SettingsPage, type SettingsPageProps } from "./SettingsPage.js";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

const SESSION: SessionView = Object.freeze({
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

async function inspectSection(
  id: string | null,
  overrides: Partial<SettingsPageProps>,
  inspect: (renderer: ReactTestRenderer, output: string) => void,
) {
  const previousRaf = Reflect.get(globalThis, "requestAnimationFrame");
  Reflect.set(globalThis, "requestAnimationFrame", (callback: () => void) => {
    callback();
    return 1;
  });
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(
        createElement(
          ToastProvider,
          null,
          createElement(SettingsPage, {
            session: SESSION,
            authClient: createMockAuthClient(),
            commandClient: createMockCommandClient(),
            ...overrides,
          }),
        ),
      );
    });
    if (id !== null) {
      assert.equal(renderer.root.findByProps({ id }).props.hidden, true);
      assert.equal(renderer.root.findByProps({ id }).children.length, 0);
      await act(async () => {
        const select = renderer.root
          .findByProps({ className: "ld-settings-mobile-select ld-field" })
          .findByType("select");
        (select.props.onChange as (event: { target: { value: string } }) => void)({
          target: { value: id },
        });
      });
      assert.equal(renderer.root.findByProps({ id }).props.hidden, false);
    }
    inspect(renderer, JSON.stringify(renderer.toJSON()));
  } finally {
    if (renderer) await act(async () => renderer.unmount());
    if (previousRaf === undefined) Reflect.deleteProperty(globalThis, "requestAnimationFrame");
    else Reflect.set(globalThis, "requestAnimationFrame", previousRaf);
  }
}

test("PRINTER_PATH_ENV_NAME is LAUNDRY_PRINTER_PATH", () => {
  assert.equal(PRINTER_PATH_ENV_NAME, "LAUNDRY_PRINTER_PATH");
});

test("remote assistance settings stay hidden; when offered they require an admin and start disabled", async () => {
  const unavailable = async () => ({ ok: false as const, error: "unconfigured" });
  const remoteAssistancePort: RemoteAssistancePort = {
    status: unavailable,
    authorize: unavailable,
    revoke: unavailable,
  };
  // ADR-91 D-1/D-2: hidden from every host until the public entry is decided.
  for (const [role, publicEntryFeatures, available] of [
    ["admin", false, true],
    ["admin", true, false],
    ["staff", true, true],
  ] as const) {
    await inspectSection(
      null,
      {
        session: { ...SESSION, role },
        publicEntryFeatures,
        ...(available ? { remoteAssistancePort } : {}),
      },
      (renderer) => {
        assert.equal(renderer.root.findAllByProps({ id: "settings-remote-assistance" }).length, 0);
      },
    );
  }
  await inspectSection(
    "settings-remote-assistance",
    { publicEntryFeatures: true, remoteAssistancePort },
    (renderer, output) => {
      assert.match(output, /当前管理员密码/u);
      const enable = renderer.root
        .findAllByType("button")
        .find((node) => node.children.join("") === "开启一小时协助");
      assert.ok(enable);
      assert.equal(enable.props.disabled, true);
    },
  );
});

test("visiting technical support keeps the legacy printer path smoke CLI-only", async () => {
  await inspectSection("settings-support", {}, (renderer, output) => {
    assert.match(output, /串口 \/ USB 直连打印机诊断/u);
    assert.ok(renderer.root.findByProps({ "data-testid": "printer-smoke-section" }));
    assert.ok(renderer.root.findByProps({ "data-testid": "printer-smoke-static" }));
    for (const text of [
      "LAUNDRY_PRINTER_PATH",
      "printer-smoke",
      "--validate",
      "COM3",
      "LPT1",
      "USB001",
    ]) {
      assert.ok(output.includes(text), text);
    }
    assert.equal(renderer.root.findAllByProps({ "data-testid": "printer-smoke-run" }).length, 0);
    assert.doesNotMatch(output, /#ff0000|rgb\(/iu);
  });
});

test("SettingsPage source cannot reconnect renderer printer smoke", () => {
  const source = readFileSync(join(packageRoot, "src/pages/PrinterSupportPanel.tsx"), "utf8");
  assert.doesNotMatch(source, /edgeBridge\.printerSmoke|edgePrinterSmoke|resolveEdgePrinterSmoke/u);
  assert.match(source, /--validate/u);
});

test("visiting printer settings exposes admin configuration without claiming physical acceptance", async () => {
  const unavailable = Object.freeze({
    ok: false as const,
    error: Object.freeze({ code: "UNAVAILABLE", message: "not loaded" }),
  });
  const printerPort: PrinterPort = Object.freeze({
    discover: async () => unavailable,
    status: async () => unavailable,
    configure: async () => unavailable,
    testFixedTicket: async () => unavailable,
  });
  await inspectSection("settings-printer", { printerPort }, (renderer, output) => {
    assert.ok(renderer.root.findByProps({ "data-testid": "printer-settings" }));
    assert.match(output, /系统小票打印机/u);
    assert.match(output, /启用所选队列/u);
    assert.match(output, /打印固定测试票/u);
    assert.match(output, /XP-58.*仍须现场验收/u);
  });
});

test("member feature flag gates navigation and the complete bonus-rule settings surface", async () => {
  await inspectSection(
    null,
    {
      session: { ...SESSION, features: { ...FULL_STORE_FEATURES, member_enabled: false } },
      queryClient: createMockQueryClient(),
    },
    (renderer) => {
      assert.equal(renderer.root.findAllByProps({ id: "settings-member" }).length, 0);
    },
  );
  await inspectSection("settings-member", { queryClient: createMockQueryClient() }, (renderer) => {
    assert.ok(renderer.root.findByProps({ "data-testid": "member-rules" }));
  });
});

test("visiting pricing settings exposes store pricing authority instead of the minimum-order demo", async () => {
  await inspectSection(
    "settings-pricing",
    { queryClient: createMockQueryClient() },
    (renderer, output) => {
      assert.ok(renderer.root.findByProps({ "data-testid": "pricing-settings" }));
      assert.match(output, /柜台计价设置/u);
      assert.match(output, /加急固定费/u);
      assert.match(output, /添加附加项/u);
      assert.doesNotMatch(output, /最低消费/u);
    },
  );
});

test("visiting delivery settings exposes policy configuration and a truthful feature-off quote boundary", async () => {
  await inspectSection(
    "settings-delivery",
    {
      session: { ...SESSION, features: { ...FULL_STORE_FEATURES, delivery_enabled: false } },
      queryClient: createMockQueryClient(),
    },
    (renderer, output) => {
      assert.ok(renderer.root.findByProps({ "data-testid": "delivery-policy-settings" }));
      assert.match(output, /服务区域与运费/u);
      assert.match(output, /每周取送时段/u);
      assert.match(output, /保存取送策略/u);
      assert.ok(renderer.root.findByProps({ "data-testid": "delivery-policy-quote" }));
      assert.match(output, /不查询已占名额、不保留容量，也不创建预约/u);
      assert.match(output, /本店取送功能当前关闭/u);
      assert.doesNotMatch(output, /启用取送功能/u);
    },
  );
});
