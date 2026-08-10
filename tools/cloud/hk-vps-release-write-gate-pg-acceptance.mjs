import { createRequire } from "node:module";

import {
  ACTIVATE_WRITE_GATE_SQL,
  INSPECT_WRITE_GATE_SQL,
  RELEASE_WRITE_GATE_SQL,
  VERIFY_WRITE_GATE_SQL,
  parseWriteGateActivation,
  parseWriteGateRole,
} from "./hk-vps-release-write-gate.mjs";

const DATABASE = "laundry_v2";

function fail(code, cause) {
  const error = new Error(code, cause === undefined ? undefined : { cause });
  error.code = code;
  throw error;
}

function databaseUrl(username, password) {
  const url = new URL(`postgresql://127.0.0.1:8543/${DATABASE}`);
  url.username = username;
  url.password = password;
  return url.toString();
}

function clientConfiguration(username, password, applicationName) {
  return Object.freeze({
    application_name: applicationName,
    connectionString: databaseUrl(username, password),
    connectionTimeoutMillis: 10_000,
    query_timeout: 35_000,
    statement_timeout: 30_000,
  });
}

function defaultCreateClient(configuration) {
  const require = createRequire(new URL("../../apps/server/package.json", import.meta.url));
  const { Client } = require("pg");
  return new Client(configuration);
}

function resultSource(result, expectedRows) {
  const results = Array.isArray(result) ? result : [result];
  const values = results.flatMap((item) => {
    if (item === null || typeof item !== "object" || !Array.isArray(item.rows)) {
      fail("CLOUD_RELEASE_WRITE_GATE_PG_RESULT_INVALID");
    }
    return item.rows.map((row) => {
      const entries =
        row !== null && typeof row === "object" && !Array.isArray(row) ? Object.values(row) : [];
      if (entries.length !== 1 || typeof entries[0] !== "string") {
        fail("CLOUD_RELEASE_WRITE_GATE_PG_RESULT_INVALID");
      }
      return entries[0];
    });
  });
  if (values.length !== expectedRows) fail("CLOUD_RELEASE_WRITE_GATE_PG_RESULT_INVALID");
  return `${values.join("\n")}\n`;
}

async function closeConnected(client, connected, errors) {
  if (!connected) return errors;
  try {
    await client.end();
    return errors;
  } catch (error) {
    return Object.freeze([...errors, error]);
  }
}

async function assertAdminAvailable(admin) {
  const result = await admin.query("SELECT current_user AS username, 1::integer AS available");
  if (
    !Array.isArray(result.rows) ||
    result.rows.length !== 1 ||
    result.rows[0]?.username !== "postgres" ||
    result.rows[0]?.available !== 1
  ) {
    fail("CLOUD_RELEASE_WRITE_GATE_PG_ADMIN_INVALID");
  }
}

async function assertHeldSession(admin) {
  const result = await admin.query(
    `SELECT count(*)::integer AS sessions FROM pg_catalog.pg_stat_activity
      WHERE datname = current_database() AND usename = 'laundry_app'
        AND application_name = 'laundry-write-gate-held'`,
  );
  if (!Array.isArray(result.rows) || result.rows[0]?.sessions !== 1) {
    fail("CLOUD_RELEASE_WRITE_GATE_PG_SESSION_INVALID");
  }
}

async function assertNewAppConnectionBlocked(client) {
  let connected = false;
  try {
    await client.connect();
    connected = true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "28000") return;
    fail("CLOUD_RELEASE_WRITE_GATE_PG_DENIAL_INVALID", error);
  }
  if (connected) {
    await client.end();
    fail("CLOUD_RELEASE_WRITE_GATE_PG_LOGIN_NOT_BLOCKED");
  }
}

export async function runWriteGatePgAcceptance({
  adminPassword,
  appPassword,
  createClient = defaultCreateClient,
} = {}) {
  if (
    typeof adminPassword !== "string" ||
    adminPassword.length < 1 ||
    typeof appPassword !== "string" ||
    appPassword.length < 1
  ) {
    fail("CLOUD_RELEASE_WRITE_GATE_PG_CONFIG_INVALID");
  }
  const admin = createClient(clientConfiguration("postgres", adminPassword, "laundry-write-gate"));
  const held = createClient(
    clientConfiguration("laundry_app", appPassword, "laundry-write-gate-held"),
  );
  const blocked = createClient(
    clientConfiguration("laundry_app", appPassword, "laundry-write-gate-blocked"),
  );
  const restored = createClient(
    clientConfiguration("laundry_app", appPassword, "laundry-write-gate-restored"),
  );
  let adminConnected = false;
  let heldConnected = false;
  let restoredConnected = false;
  let gateAttempted = false;
  let gateReleased = false;
  let operationError;
  let expectedHeldErrorCount = 0;
  held.on?.("error", () => {
    expectedHeldErrorCount += 1;
  });
  try {
    await admin.connect();
    adminConnected = true;
    await held.connect();
    heldConnected = true;
    await assertHeldSession(admin);
    parseWriteGateRole(resultSource(await admin.query(INSPECT_WRITE_GATE_SQL), 1), true);
    gateAttempted = true;
    const activation = parseWriteGateActivation(
      resultSource(await admin.query(ACTIVATE_WRITE_GATE_SQL), 1),
      resultSource(await admin.query(VERIFY_WRITE_GATE_SQL), 1),
    );
    if (activation.terminatedSessions < 1) {
      fail("CLOUD_RELEASE_WRITE_GATE_PG_SESSION_INVALID");
    }
    await assertAdminAvailable(admin);
    await assertNewAppConnectionBlocked(blocked);
    parseWriteGateRole(resultSource(await admin.query(RELEASE_WRITE_GATE_SQL), 1), true);
    gateReleased = true;
    await restored.connect();
    restoredConnected = true;
    const appResult = await restored.query(
      "SELECT current_user AS username, 1::integer AS available",
    );
    if (appResult.rows[0]?.username !== "laundry_app" || appResult.rows[0]?.available !== 1) {
      fail("CLOUD_RELEASE_WRITE_GATE_PG_RELEASE_INVALID");
    }
  } catch (error) {
    operationError = error;
  }

  let cleanupErrors = [];
  if (adminConnected && gateAttempted && !gateReleased) {
    try {
      parseWriteGateRole(resultSource(await admin.query(RELEASE_WRITE_GATE_SQL), 1), true);
      gateReleased = true;
    } catch (error) {
      cleanupErrors = [...cleanupErrors, error];
    }
  }
  cleanupErrors = [...cleanupErrors, ...(await closeConnected(restored, restoredConnected, []))];
  // The server deliberately severed this connection; end() is still attempted and audited.
  cleanupErrors = [...cleanupErrors, ...(await closeConnected(held, heldConnected, []))];
  cleanupErrors = [...cleanupErrors, ...(await closeConnected(admin, adminConnected, []))];
  if (cleanupErrors.length > 0) {
    fail(
      "CLOUD_RELEASE_WRITE_GATE_PG_CLEANUP_FAILED",
      new AggregateError(
        operationError === undefined ? cleanupErrors : [operationError, ...cleanupErrors],
        "write gate acceptance cleanup failed",
      ),
    );
  }
  if (operationError !== undefined || !gateReleased) {
    fail("CLOUD_RELEASE_WRITE_GATE_PG_ACCEPTANCE_FAILED", operationError);
  }
  return Object.freeze({ expectedHeldErrors: expectedHeldErrorCount, status: "verified" });
}
