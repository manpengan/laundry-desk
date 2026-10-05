import assert from "node:assert/strict";
import test from "node:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { MaintenancePort } from "../host/maintenance-port.js";
import { BackupHealthPanel } from "./BackupHealthPanel.js";
import { MaintenanceHandoff } from "./MaintenanceHandoff.js";
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const failed = async () => ({ ok: false as const, error: "native unavailable" });
function click(renderer: ReactTestRenderer, label: string) {
  const button = renderer.root
    .findAllByType("button")
    .find((node) => node.children.join("") === label);
  assert.ok(button, label);
  (button.props.onClick as () => void)();
}
test("web backup state remains unknown and staff never get maintenance launch actions", async () => {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<BackupHealthPanel canMaintain={false} sessionKey="a" />);
  });
  assert.match(JSON.stringify(renderer.toJSON()), /无法读取本机备份状态/u);
  assert.doesNotMatch(JSON.stringify(renderer.toJSON()), /符合计划/u);
  const port: MaintenancePort = { health: failed, open: failed, handoff: failed };
  await act(async () =>
    renderer.update(<BackupHealthPanel port={port} canMaintain={false} sessionKey="a" />),
  );
  await act(async () => click(renderer, "刷新备份状态"));
  assert.match(JSON.stringify(renderer.toJSON()), /native unavailable/u);
  assert.equal(renderer.root.findAllByType("button").length, 1);
  await act(async () => renderer.unmount());
});
test("late backup status from a previous staff session is discarded", async () => {
  let resolve!: (value: Awaited<ReturnType<MaintenancePort["health"]>>) => void;
  const port: MaintenancePort = {
    health: () =>
      new Promise((done) => {
        resolve = done;
      }),
    open: failed,
    handoff: failed,
  };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<BackupHealthPanel port={port} canMaintain sessionKey="old" />);
  });
  await act(async () => click(renderer, "刷新备份状态"));
  await act(async () =>
    renderer.update(<BackupHealthPanel port={port} canMaintain sessionKey="new" />),
  );
  await act(async () => resolve({ ok: false, error: "previous staff error" }));
  assert.doesNotMatch(JSON.stringify(renderer.toJSON()), /previous staff error/u);
  await act(async () => renderer.unmount());
});
test("handoff freezes the authorized request for retries, blocks double clicks and expires locally", async () => {
  const calls: string[] = [];
  let done!: (value: Awaited<ReturnType<MaintenancePort["handoff"]>>) => void;
  const port: MaintenancePort = {
    health: failed,
    open: failed,
    handoff: async (intent, id) => {
      calls.push(`${intent}:${id}`);
      return new Promise((resolve) => {
        done = resolve;
      });
    },
  };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <MaintenanceHandoff
        port={port}
        intent="export-store"
        requestId="request"
        expiresAt={Date.now() + 60000}
      />,
    );
  });
  const button = renderer.root.findByType("button");
  await act(async () => {
    button.props.onClick();
    button.props.onClick();
  });
  assert.deepEqual(calls, ["export-store:request"]);
  await act(async () => done({ ok: false, error: "busy" }));
  assert.match(JSON.stringify(renderer.toJSON()), /busy/u);
  await act(async () => click(renderer, "打开维护窗口完成导出"));
  await act(async () => done({ ok: true, data: true }));
  assert.deepEqual(calls, ["export-store:request", "export-store:request"]);
  assert.match(JSON.stringify(renderer.toJSON()), /传递此次授权/u);
  await act(async () =>
    renderer.update(
      <MaintenanceHandoff
        port={port}
        intent="export-store"
        requestId="request"
        expiresAt={Date.now() - 1}
      />,
    ),
  );
  assert.match(JSON.stringify(renderer.toJSON()), /授权已过期/u);
  assert.equal(renderer.root.findAllByType("button").length, 0);
  await act(async () => renderer.unmount());
});
