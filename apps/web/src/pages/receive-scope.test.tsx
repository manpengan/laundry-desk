import assert from "node:assert/strict";
import test from "node:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { ToastProvider } from "@laundry/ui";
import type { SessionView } from "../auth/types.js";
import { createMockCommandClient } from "../commands/command-client.js";
import type { ScalePort } from "../host/scale-port.js";
import type { NavItemId } from "../nav.js";
import { PageHostCore, type PageComponentRegistry } from "./PageHostCore.js";
import { ReceivePage } from "./ReceivePage.js";
import { ReceiveWorkspaceProvider, useReceiveWorkspaceAccess } from "./ReceiveWorkspace.js";
import { createReceiveWorkspace } from "./receive-workspace.js";

const id = "11111111-1111-4111-8111-111111111111";
const sessionA: SessionView = {
  session: {
    org_id: id,
    store_id: id,
    session_id: id,
    staff_id: id,
    session_version: 1,
    permission_version: 1,
    device_id: id,
  },
  role: "admin",
  features: {},
  display: { store_name: "合成店", staff_name: "员工 A", org_code: "TEST", store_code: "TEST" },
};
const sessionB: SessionView = {
  ...sessionA,
  role: "staff",
  session: {
    ...sessionA.session,
    staff_id: "22222222-2222-4222-8222-222222222222",
    session_version: 2,
  },
  display: { ...sessionA.display, staff_name: "员工 B" },
};
const Empty = () => <div />;
const pages: PageComponentRegistry = {
  CounterWorkbench: Empty,
  CustomersPage: Empty,
  DebtPage: Empty,
  DeliveryOperationsPage: Empty,
  FulfillmentHubPage: Empty,
  PickupPage: Empty,
  PickupRemindersPage: Empty,
  ReceivePage,
  SettingsPage: Empty,
  StatsPage: Empty,
};
const scalePort: ScalePort = {
  ports: async () => ({ ok: true, data: ["COM7"] }),
  read: async () => ({
    ok: true,
    data: {
      grams: 1234,
      basis: "net",
      port: "COM7",
      captured_at: Date.now(),
      protocol: "and-standard-ascii-v1",
    },
  }),
};

test("staff scope clears unadopted scale readings while same-staff navigation retains the draft", async () => {
  const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const commandClient = createMockCommandClient();
  let store = createReceiveWorkspace();
  let renderer: ReactTestRenderer | undefined;
  function Probe() {
    store = useReceiveWorkspaceAccess().store;
    return null;
  }
  function app(session: SessionView, activeId: NavItemId = "receive") {
    const s = session.session;
    return (
      <ToastProvider>
        <ReceiveWorkspaceProvider
          scope={`${s.org_id}:${s.store_id}:${s.session_id}:${s.staff_id}:${s.session_version}`}
        >
          <Probe />
          <PageHostCore
            pages={pages}
            activeId={activeId}
            session={session}
            commandClient={commandClient}
            scalePort={scalePort}
            onNavigate={() => undefined}
          />
        </ReceiveWorkspaceProvider>
      </ToastProvider>
    );
  }
  const buttons = (label: string) => {
    assert.ok(renderer);
    return renderer.root.findAllByType("button").filter((item) => item.children.join("") === label);
  };
  const input = (name: string) => {
    assert.ok(renderer);
    return renderer.root.findByProps({ name }).props as {
      value: string;
      onChange: (event: { target: { value: string } }) => void;
    };
  };
  try {
    await act(async () => {
      renderer = create(app(sessionA));
    });
    const storeA = store;
    await act(async () => {
      input("customer-name").onChange({ target: { value: "员工 A 草稿" } });
    });
    await act(async () => {
      buttons("刷新串口")[0]!.props.onClick();
    });
    await act(async () => {
      buttons("读取稳定重量")[0]!.props.onClick();
    });
    assert.equal(buttons("记录到订单").length, 1);
    await act(async () => {
      renderer!.update(app(sessionB));
    });
    assert.notEqual(store, storeA);
    assert.equal(
      buttons("记录到订单").length,
      0,
      "old reading must not be adoptable by another staff",
    );
    assert.equal(input("customer-name").value, "");
    assert.equal(input("note").value, "");
    const storeB = store;
    const operationB = store.getSnapshot().operationId;
    await act(async () => {
      input("customer-name").onChange({ target: { value: "员工 B 草稿" } });
      input("note").onChange({ target: { value: "保留订单备注" } });
    });
    await act(async () => {
      renderer!.update(app(sessionB, "workbench"));
    });
    await act(async () => {
      renderer!.update(app(sessionB));
    });
    assert.equal(store, storeB);
    assert.equal(store.getSnapshot().operationId, operationB);
    assert.equal(input("customer-name").value, "员工 B 草稿");
    assert.equal(input("note").value, "保留订单备注");
    await act(async () => {
      renderer!.update(app({ ...sessionB, display: { ...sessionB.display } }));
    });
    assert.equal(store, storeB);
    assert.equal(input("customer-name").value, "员工 B 草稿");
  } finally {
    if (renderer)
      await act(async () => {
        renderer!.unmount();
      });
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  }
});
