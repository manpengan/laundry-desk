import assert from "node:assert/strict";
import test from "node:test";

import { AcceptanceFailure, failureCode } from "./adr36-web-core.mjs";
import { createStaffCredentialJourney } from "./adr36-web-staff-journey.mjs";

const ADMIN_ID = "11111111-1111-4111-8111-111111111101";
const APPROVER_ID = "11111111-1111-4111-8111-111111111102";
const STAFF_ID = "22222222-2222-4222-8222-222222222201";
const APPROVER_PIN = "740193";
const SECRETS = Object.freeze({
  initial: Object.freeze({ password: "Initial-Password-Never-Print", pin: "684193" }),
  replacement: Object.freeze({ password: "Replacement-Password-Never-Print", pin: "725804" }),
  recovery: Object.freeze({ password: "Recovery-Password-Never-Print", pin: "936150" }),
});
const RUN = Object.freeze({
  runId: "ADR36-20260809T123456Z-1234abcd",
  label: "ADR36 UAT 20260809T123456 1234abcd",
  note: "ADR36-UAT-20260809T123456Z-1234abcd",
});

function createStaffApi(options = {}) {
  let row = options.existingRow ?? null;
  let setupSequence = 0;
  let sessionSequence = 0;
  let pending = null;
  let installedPassword = null;
  let postCommitFailure = options.postCommitFailure ?? null;
  const sessions = [];
  const calls = [];

  const setup = (purpose) => {
    setupSequence += 1;
    pending = Object.freeze({
      ref: `33333333-3333-4333-8333-${String(setupSequence).padStart(12, "0")}`,
      creatorStaffId: ADMIN_ID,
      purpose,
    });
    return Object.freeze({
      credential_setup_ref: pending.ref,
      target_staff_id: STAFF_ID,
      expires_at: 2_000_000_000,
      status: "pending",
    });
  };

  const revokeSessions = () => {
    for (const session of sessions) session.active = false;
  };

  const afterCommit = (name, result) => {
    if (postCommitFailure !== name) return result;
    postCommitFailure = null;
    throw new Error(`${SECRETS.initial.password} private remote detail`);
  };

  const api = Object.freeze({
    query: async (_session, name, args) => {
      calls.push(Object.freeze({ method: "query", name, args }));
      assert.equal(name, "staff.access.list");
      return Object.freeze({ staff: row === null ? [] : [Object.freeze({ ...row })] });
    },
    stepUp: async (session, name, args, approverStaffId, approverPin) => {
      calls.push(Object.freeze({ method: "stepUp", name }));
      assert.equal(session.staffId, ADMIN_ID);
      assert.equal(approverStaffId, APPROVER_ID);
      assert.equal(approverPin, APPROVER_PIN);
      if (name === "staff.create") {
        assert.equal(row, null);
        row = Object.freeze({
          staff_id: STAFF_ID,
          username: args.username,
          display_name: args.display_name,
          role: "staff",
          privacy_admin: false,
          is_active: false,
          permission_version: 1,
        });
        installedPassword = null;
        const result = setup("create");
        return afterCommit(name, result);
      }
      assert.equal(args.target_staff_id, STAFF_ID);
      assert.equal(args.expected_permission_version, row.permission_version);
      if (name === "staff.credentials.reset") {
        row = Object.freeze({
          ...row,
          privacy_admin: false,
          is_active: false,
          permission_version: row.is_active ? row.permission_version + 1 : row.permission_version,
        });
        installedPassword = null;
        revokeSessions();
        const result = setup("reset");
        return afterCommit(name, result);
      }
      assert.equal(name, "staff.access.set");
      assert.equal(args.role, "staff");
      assert.equal(args.privacy_admin, false);
      assert.equal(args.is_active, false);
      assert.equal(pending, null);
      row = Object.freeze({
        ...row,
        role: args.role,
        privacy_admin: args.privacy_admin,
        is_active: args.is_active,
        permission_version: row.permission_version + 1,
      });
      if (options.ignoreDeactivationRevocation !== true) revokeSessions();
      return afterCommit(name, Object.freeze({ staff: row }));
    },
    completeStaffCredentials: async (session, input) => {
      calls.push(Object.freeze({ method: "completeStaffCredentials" }));
      assert.equal(input.credential_setup_ref, pending?.ref);
      if (session.staffId !== ADMIN_ID) throw new AcceptanceFailure("REMOTE_RESOURCE_UNAVAILABLE");
      row = Object.freeze({
        ...row,
        is_active: true,
        permission_version: row.permission_version + 1,
      });
      installedPassword = input.password;
      pending = null;
      return afterCommit(
        "completeStaffCredentials",
        Object.freeze({
          target_staff_id: STAFF_ID,
          permission_version: row.permission_version,
          status: "active",
        }),
      );
    },
    login: async (principal, expectedRole) => {
      calls.push(Object.freeze({ method: "login" }));
      assert.equal(expectedRole, "staff");
      assert.equal(principal.username, row.username);
      assert.equal(principal.displayName, row.display_name);
      assert.equal(row.is_active, true);
      assert.equal(principal.password, installedPassword);
      sessionSequence += 1;
      const session = {
        staffId: STAFF_ID,
        accessToken: `private-token-${sessionSequence}`,
        cookies: Object.freeze({ refresh: `private-refresh-${sessionSequence}` }),
        active: true,
      };
      sessions.push(session);
      return session;
    },
    expectStaffFailure: async (session) => {
      calls.push(Object.freeze({ method: "expectStaffFailure" }));
      assert.equal(session.active, false);
    },
    expectRefreshFailure: async (session) => {
      calls.push(Object.freeze({ method: "expectRefreshFailure" }));
      assert.equal(session.active, false);
    },
    expectLoginFailure: async (principal) => {
      calls.push(Object.freeze({ method: "expectLoginFailure" }));
      assert.equal(principal.username, row.username);
      assert.equal(row.is_active && principal.password === installedPassword, false);
    },
  });

  return Object.freeze({
    api,
    calls,
    row: () => row,
    pending: () => pending,
    installedPassword: () => installedPassword,
  });
}

function controller(cloud) {
  return createStaffCredentialJourney({
    api: cloud.api,
    adminSession: Object.freeze({ staffId: ADMIN_ID }),
    approverSession: Object.freeze({ staffId: APPROVER_ID }),
    approverPin: APPROVER_PIN,
    run: RUN,
    secretFactory: (kind) => SECRETS[kind],
  });
}

function secretValues() {
  return Object.freeze([
    APPROVER_PIN,
    ...Object.values(SECRETS).flatMap((secret) => [secret.password, secret.pin]),
  ]);
}

test("employee journey enforces creator binding, reset revocation, and final soft deactivation", async () => {
  const cloud = createStaffApi();
  const journey = controller(cloud);
  const result = await journey.execute();

  assert.deepEqual(result, {
    username: "uat_staff_adr36_20260809t123456z_1234abcd",
    staffId: STAFF_ID,
    status: "deactivated",
  });
  assert.equal(cloud.row()?.is_active, false);
  assert.equal(cloud.row()?.role, "staff");
  assert.equal(cloud.row()?.privacy_admin, false);
  assert.equal(cloud.row()?.permission_version, 5);
  assert.equal(cloud.pending(), null);
  assert.equal(await journey.cleanup(), true);

  const methods = cloud.calls.map((call) => `${call.method}:${call.name ?? ""}`);
  assert.equal(methods.filter((value) => value === "stepUp:staff.credentials.reset").length, 1);
  assert.equal(methods.filter((value) => value === "completeStaffCredentials:").length, 4);
  assert.ok(methods.includes("stepUp:staff.access.set"));

  const output = JSON.stringify({ result, controller: journey, methods });
  for (const secret of secretValues()) assert.doesNotMatch(output, new RegExp(secret, "u"));
  assert.doesNotMatch(output, /private-token|private-refresh/u);
});

test("an unproven create outcome never takes over a username match during cleanup", async () => {
  const cloud = createStaffApi({ postCommitFailure: "staff.create" });
  const journey = controller(cloud);
  let code = null;
  try {
    await journey.execute();
    assert.fail("journey should fail after the simulated post-commit interruption");
  } catch (error) {
    code = failureCode(error);
  }

  assert.equal(code, "INTERNAL_ERROR");
  assert.equal(cloud.row()?.is_active, false);
  assert.notEqual(cloud.pending(), null);
  assert.equal(await journey.cleanup(), false);
  assert.equal(cloud.row()?.is_active, false);
  assert.equal(cloud.row()?.permission_version, 1);
  assert.notEqual(cloud.pending(), null);
  assert.equal(cloud.installedPassword(), null);

  const methods = cloud.calls.map((call) => `${call.method}:${call.name ?? ""}`);
  assert.equal(methods.includes("stepUp:staff.credentials.reset"), false);
  assert.equal(methods.includes("completeStaffCredentials:"), false);
  assert.equal(methods.includes("stepUp:staff.access.set"), false);
  const output = JSON.stringify({ code, methods, cleanup: false });
  for (const secret of secretValues()) assert.doesNotMatch(output, new RegExp(secret, "u"));
  assert.doesNotMatch(output, /private remote detail|private-token|private-refresh/u);
});

test("a post-commit completion interruption recovers only the proven target id", async () => {
  const cloud = createStaffApi({ postCommitFailure: "completeStaffCredentials" });
  const journey = controller(cloud);
  await assert.rejects(journey.execute());
  assert.equal(cloud.row()?.is_active, true);
  assert.equal(cloud.row()?.permission_version, 2);
  assert.equal(cloud.pending(), null);

  assert.equal(await journey.cleanup(), true);
  assert.equal(cloud.row()?.is_active, false);
  assert.equal(cloud.row()?.permission_version, 5);
  assert.equal(cloud.pending(), null);
  assert.equal(cloud.installedPassword(), SECRETS.recovery.password);
  const methods = cloud.calls.map((call) => `${call.method}:${call.name ?? ""}`);
  assert.ok(methods.includes("stepUp:staff.credentials.reset"));
  assert.ok(methods.includes("stepUp:staff.access.set"));
});

test("cleanup fails when deactivation does not revoke old employee sessions", async () => {
  const cloud = createStaffApi({ ignoreDeactivationRevocation: true });
  const journey = controller(cloud);
  await assert.rejects(journey.execute());
  assert.equal(cloud.row()?.is_active, false);
  assert.equal(await journey.cleanup(), false);
});

test("pre-existing synthetic username collision is never changed by cleanup", async () => {
  const existingRow = Object.freeze({
    staff_id: STAFF_ID,
    username: "uat_staff_adr36_20260809t123456z_1234abcd",
    display_name: RUN.label,
    role: "staff",
    privacy_admin: false,
    is_active: true,
    permission_version: 7,
  });
  const cloud = createStaffApi({ existingRow });
  const journey = controller(cloud);
  await assert.rejects(journey.execute(), { code: "STAFF_USERNAME_COLLISION" });
  assert.equal(await journey.cleanup(), true);
  assert.deepEqual(cloud.row(), existingRow);
  assert.equal(
    cloud.calls.some((call) => call.method === "stepUp"),
    false,
  );
});
