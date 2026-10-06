import assert from "node:assert/strict";
import test from "node:test";
import { DesktopMaintenanceInputSchema, DesktopMaintenanceResultSchema } from "@laundry/contracts";
import type { AuthState } from "./http-transport-support.js";
import { createDesktopMaintenanceOperation } from "./maintenance-operation.js";
const id = "11111111-1111-4111-8111-111111111111";
const auth: AuthState = {
  accessToken: "synthetic",
  csrfToken: "synthetic",
  expiresAtMs: 100000,
  sessionView: {
    session: {
      session_id: id,
      session_version: 1,
      org_id: id,
      store_id: id,
      staff_id: id,
      device_id: id,
      permission_version: 1,
    },
    role: "admin",
    features: {},
    display: {
      store_name: "Synthetic",
      staff_name: "Synthetic",
      org_code: "test",
      store_code: "test",
    },
  },
};
const health = {
  status: "backup_health",
  checked_at: "2026-10-06T00:00:00.000Z",
  config: { enabled: false, private_path: "secret" },
  last_backup_at: null,
  last_drill_at: null,
  last_offsite_at: null,
  next_backup_at: null,
  free_mib: 2000,
  latest: {
    at: "2026-10-06T00:00:00.000Z",
    status: "failed",
    code: "WINDOWS_COMPANION_BACKUP_RUN_FAILED",
    backup_id: "private",
    drilled: false,
  },
  alerts: ["backup_disabled"],
  private_path: "secret",
  assurance: "development_only",
};
test("maintenance permits signed-in read-only health, strips private fields and denies non-admin launches", async () => {
  let calls = 0;
  const current = { ...auth, sessionView: { ...auth.sessionView, role: "staff" as const } };
  const operation = createDesktopMaintenanceOperation(
    () => current,
    async () => {
      calls++;
      return health;
    },
    () => 1000,
  );
  const result = DesktopMaintenanceResultSchema.parse(
    await operation.execute({ operation: "health" }),
  );
  assert.equal(result.ok, true);
  assert.doesNotMatch(JSON.stringify(result), /secret|private_path|backup_id|drilled/u);
  assert.equal(
    DesktopMaintenanceResultSchema.parse(
      await operation.execute({ operation: "open", intent: "backup" }),
    ).ok,
    false,
  );
  assert.equal(calls, 1);
});
test("maintenance rejects arbitrary commands, paths, extra auth fields and invalid handoff before launch", async () => {
  let calls = 0;
  const operation = createDesktopMaintenanceOperation(
    () => auth,
    async () => {
      calls++;
      return { status: "maintenance_opened" };
    },
    () => 1000,
  );
  for (const input of [
    { operation: "open", intent: "restore" },
    { operation: "open", intent: "backup", path: "C:/evil.ps1" },
    { operation: "handoff", intent: "export-store", request_id: "bad" },
    { operation: "health", admin: true },
  ]) {
    assert.equal(DesktopMaintenanceInputSchema.safeParse(input).success, false);
    assert.equal(DesktopMaintenanceResultSchema.parse(await operation.execute(input)).ok, false);
  }
  assert.equal(calls, 0);
  assert.equal(
    DesktopMaintenanceResultSchema.parse(
      await operation.execute({ operation: "handoff", intent: "export-store", request_id: id }),
    ).ok,
    true,
  );
});
test("maintenance revalidates permission and session version immediately before native launch and after result", async () => {
  let current: AuthState | null = auth;
  let valid: boolean | null = null;
  const operation = createDesktopMaintenanceOperation(
    () => current,
    async (_input, authorized) => {
      current = {
        ...auth,
        sessionView: {
          ...auth.sessionView,
          session: { ...auth.sessionView.session, session_version: 2 },
        },
      };
      valid = authorized();
      return { status: "maintenance_opened" };
    },
    () => 1000,
  );
  assert.equal(
    DesktopMaintenanceResultSchema.parse(
      await operation.execute({ operation: "open", intent: "maintenance" }),
    ).ok,
    false,
  );
  assert.equal(valid, false);
  current = null;
  assert.equal(
    DesktopMaintenanceResultSchema.parse(await operation.execute({ operation: "health" })).ok,
    false,
  );
});
