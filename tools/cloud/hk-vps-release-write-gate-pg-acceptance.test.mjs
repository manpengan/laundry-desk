import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTIVATE_WRITE_GATE_SQL,
  INSPECT_WRITE_GATE_SQL,
  RELEASE_WRITE_GATE_SQL,
  VERIFY_WRITE_GATE_SQL,
} from "./hk-vps-release-write-gate.mjs";
import { runWriteGatePgAcceptance } from "./hk-vps-release-write-gate-pg-acceptance.mjs";

function single(value) {
  return Object.freeze({ rows: Object.freeze([Object.freeze({ value })]) });
}

function activation() {
  return Object.freeze([Object.freeze({ rows: Object.freeze([]) }), single("1\t1")]);
}

function release() {
  return Object.freeze([Object.freeze({ rows: Object.freeze([]) }), single("t\tf\tf")]);
}

function createClientFactory(events, blockedConnects = false, blockedErrorCode = "28000") {
  return (configuration) => {
    const label = configuration.application_name;
    const username = new URL(configuration.connectionString).username;
    events.push(`create:${label}:${username}`);
    return {
      connect: async () => {
        events.push(`connect:${label}`);
        if (label === "laundry-write-gate-blocked" && !blockedConnects) {
          throw Object.assign(new Error("role is not permitted to log in"), {
            code: blockedErrorCode,
          });
        }
      },
      end: async () => events.push(`end:${label}`),
      on: (name) => events.push(`on:${label}:${name}`),
      query: async (sql) => {
        events.push(`query:${label}:${sql}`);
        if (sql === INSPECT_WRITE_GATE_SQL) return single("t\tf\tf");
        if (sql === ACTIVATE_WRITE_GATE_SQL) return activation();
        if (sql === VERIFY_WRITE_GATE_SQL) return single("0\tf\tf\tf");
        if (sql === RELEASE_WRITE_GATE_SQL) return release();
        if (sql.includes("pg_catalog.pg_stat_activity")) {
          return { rows: [{ sessions: 1 }] };
        }
        if (label === "laundry-write-gate-restored") {
          return { rows: [{ available: 1, username: "laundry_app" }] };
        }
        return { rows: [{ available: 1, username: "postgres" }] };
      },
    };
  };
}

test("required PG acceptance proves terminate, login denial, admin continuity, and release", async () => {
  const events = [];
  const result = await runWriteGatePgAcceptance({
    adminPassword: "admin-test-secret",
    appPassword: "app-test-secret",
    createClient: createClientFactory(events),
  });
  assert.deepEqual(result, { expectedHeldErrors: 0, status: "verified" });
  const activationIndex = events.indexOf(`query:laundry-write-gate:${ACTIVATE_WRITE_GATE_SQL}`);
  const blockedIndex = events.indexOf("connect:laundry-write-gate-blocked");
  const releaseIndex = events.indexOf(`query:laundry-write-gate:${RELEASE_WRITE_GATE_SQL}`);
  const restoredIndex = events.indexOf("connect:laundry-write-gate-restored");
  assert.ok(activationIndex >= 0 && activationIndex < blockedIndex);
  assert.ok(blockedIndex < releaseIndex && releaseIndex < restoredIndex);
  assert.ok(
    events.some((event) =>
      event.startsWith("query:laundry-write-gate:SELECT current_user AS username"),
    ),
  );
  assert.ok(events.includes("end:laundry-write-gate-held"));
  assert.ok(events.includes("end:laundry-write-gate-restored"));
  assert.ok(events.includes("end:laundry-write-gate"));
});

test("failed denial proof releases LOGIN in finally and closes connected clients", async () => {
  const events = [];
  await assert.rejects(
    () =>
      runWriteGatePgAcceptance({
        adminPassword: "admin-test-secret",
        appPassword: "app-test-secret",
        createClient: createClientFactory(events, true),
      }),
    { code: "CLOUD_RELEASE_WRITE_GATE_PG_ACCEPTANCE_FAILED" },
  );
  const blockedEnd = events.indexOf("end:laundry-write-gate-blocked");
  const releaseIndex = events.lastIndexOf(`query:laundry-write-gate:${RELEASE_WRITE_GATE_SQL}`);
  assert.ok(blockedEnd >= 0 && blockedEnd < releaseIndex);
  assert.ok(events.includes("end:laundry-write-gate-held"));
  assert.ok(events.includes("end:laundry-write-gate"));
  assert.equal(events.includes("connect:laundry-write-gate-restored"), false);
});

test("network or timeout failures cannot masquerade as the expected PostgreSQL denial", async () => {
  const events = [];
  await assert.rejects(
    () =>
      runWriteGatePgAcceptance({
        adminPassword: "admin-test-secret",
        appPassword: "app-test-secret",
        createClient: createClientFactory(events, false, "ECONNREFUSED"),
      }),
    (error) => {
      assert.equal(error.code, "CLOUD_RELEASE_WRITE_GATE_PG_ACCEPTANCE_FAILED");
      assert.equal(error.cause?.code, "CLOUD_RELEASE_WRITE_GATE_PG_DENIAL_INVALID");
      return true;
    },
  );
  assert.ok(events.includes(`query:laundry-write-gate:${RELEASE_WRITE_GATE_SQL}`));
  assert.ok(events.includes("end:laundry-write-gate-held"));
  assert.ok(events.includes("end:laundry-write-gate"));
});
