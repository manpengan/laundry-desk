import { spawn as systemSpawn } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";

import { AcceptanceFailure, requireThat } from "./adr36-web-core.mjs";
import { HK_VPS_CLOUD_TEST as PROFILE } from "./cloud-environment-profile.mjs";
import {
  buildReminderFixtureApplySql,
  buildReminderFixtureArtifacts,
  buildReminderFixtureVerifySql,
  validateReminderFixtureEvidence,
} from "./adr36-web-reminder-fixture-data.mjs";
import { buildReminderFixtureCleanupSql } from "./adr36-web-reminder-fixture-cleanup.mjs";

export const REMINDER_FIXTURE_OPT_IN = "APPLY_SYNTHETIC_HISTORY_ON_HK_VPS";
const FIXED_ROOT = PROFILE.paths.liveRoot;
const PSQL_PATH = "/usr/bin/psql";
const RELEASE_SHA = /^[0-9a-f]{40}$/u;
const MAX_SQL_OUTPUT_BYTES = 16 * 1024;
const SQL_TIMEOUT_MS = 20_000;
const proofDetails = new WeakMap();
const inactiveProofs = new WeakSet();

function stableFailure(code) {
  return new AcceptanceFailure(code);
}

export function reminderFixtureRequested(env = process.env) {
  const value = env.LAUNDRY_ADR36_REMINDER_FIXTURE;
  if (value === undefined) return false;
  requireThat(value === REMINDER_FIXTURE_OPT_IN, "REMINDER_FIXTURE_OPT_IN_INVALID");
  return true;
}

async function inspectCloudTestRoot(cwd) {
  const resolved = await realpath(cwd);
  requireThat(resolved === FIXED_ROOT, "REMINDER_FIXTURE_TARGET_INVALID");
  const rootMetadata = await lstat(resolved);
  requireThat(
    rootMetadata.isDirectory() && rootMetadata.uid === 0 && (rootMetadata.mode & 0o022) === 0,
    "REMINDER_FIXTURE_TARGET_INVALID",
  );
  const markerPath = join(resolved, PROFILE.markers.releaseFile);
  const metadata = await lstat(markerPath);
  requireThat(
    metadata.isFile() &&
      !metadata.isSymbolicLink() &&
      metadata.uid === 0 &&
      (metadata.mode & 0o022) === 0,
    "REMINDER_FIXTURE_MARKER_INVALID",
  );
  let marker;
  try {
    marker = JSON.parse(await readFile(markerPath, "utf8"));
  } catch {
    throw stableFailure("REMINDER_FIXTURE_MARKER_INVALID");
  }
  requireThat(
    typeof marker === "object" &&
      marker !== null &&
      !Array.isArray(marker) &&
      marker.environment === PROFILE.environmentMarker &&
      typeof marker.git_sha === "string" &&
      RELEASE_SHA.test(marker.git_sha),
    "REMINDER_FIXTURE_MARKER_INVALID",
  );
  return Object.freeze({ root: resolved, gitSha: marker.git_sha });
}

function decoded(value, code) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw stableFailure(code);
  }
}

function databaseEnvironment(rawUrl, baseEnv) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw stableFailure("REMINDER_FIXTURE_DATABASE_INVALID");
  }
  const hostname = url.hostname.toLowerCase();
  const database = decoded(url.pathname.slice(1), "REMINDER_FIXTURE_DATABASE_INVALID");
  requireThat(
    (url.protocol === "postgres:" || url.protocol === "postgresql:") &&
      (hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]") &&
      (url.port === "" || url.port === String(PROFILE.services.postgresPort)) &&
      database === PROFILE.services.postgresDatabase &&
      decoded(url.username, "REMINDER_FIXTURE_DATABASE_INVALID") === "postgres" &&
      url.password.length > 0 &&
      url.hash === "" &&
      [...url.searchParams.keys()].length === 0,
    "REMINDER_FIXTURE_DATABASE_INVALID",
  );
  return Object.freeze({
    PATH: baseEnv.PATH ?? "/usr/bin:/bin",
    LANG: baseEnv.LANG ?? "C.UTF-8",
    PGHOST: hostname === "[::1]" ? "::1" : hostname,
    PGPORT: url.port || String(PROFILE.services.postgresPort),
    PGDATABASE: database,
    PGUSER: decoded(url.username, "REMINDER_FIXTURE_DATABASE_INVALID"),
    PGPASSWORD: decoded(url.password, "REMINDER_FIXTURE_DATABASE_INVALID"),
    PGCONNECT_TIMEOUT: "5",
    PGAPPNAME: "adr36-reminder-history-fixture",
    PGSSLMODE: "disable",
  });
}

function adminDatabaseUrl(env) {
  const direct = env.DATABASE_ADMIN_URL;
  const file = env.LAUNDRY_ADR36_DATABASE_ADMIN_URL_FILE;
  requireThat(!(direct !== undefined && file !== undefined), "REMINDER_FIXTURE_DATABASE_AMBIGUOUS");
  if (typeof direct === "string" && direct.length > 0) return direct;
  requireThat(
    typeof file === "string" && file.startsWith("/"),
    "REMINDER_FIXTURE_DATABASE_MISSING",
  );
  return Object.freeze({ file });
}

async function resolveAdminDatabaseUrl(env) {
  const source = adminDatabaseUrl(env);
  if (typeof source === "string") return source;
  try {
    const metadata = await lstat(source.file);
    requireThat(
      metadata.isFile() &&
        !metadata.isSymbolicLink() &&
        metadata.uid === 0 &&
        (metadata.mode & 0o777) === 0o600,
      "REMINDER_FIXTURE_DATABASE_FILE_INVALID",
    );
    const value = await readFile(source.file, "utf8");
    requireThat(
      value.length > 0 && !/[\r\n]/u.test(value),
      "REMINDER_FIXTURE_DATABASE_FILE_INVALID",
    );
    return value;
  } catch (error) {
    if (error instanceof AcceptanceFailure) throw error;
    throw stableFailure("REMINDER_FIXTURE_DATABASE_FILE_INVALID");
  }
}

export async function runReminderFixtureSql(
  sql,
  rawUrl,
  { env = process.env, spawnImpl = systemSpawn, timeoutMs = SQL_TIMEOUT_MS } = {},
) {
  requireThat(typeof sql === "string" && sql.length > 0, "REMINDER_FIXTURE_SQL_INVALID");
  const childEnv = databaseEnvironment(rawUrl, env);
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = "";
    let outputBytes = 0;
    const child = spawnImpl(
      PSQL_PATH,
      [
        "--no-password",
        "--no-psqlrc",
        "--quiet",
        "--tuples-only",
        "--no-align",
        "--set",
        "ON_ERROR_STOP=1",
      ],
      { env: childEnv, stdio: ["pipe", "pipe", "pipe"] },
    );
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error === null) resolve(value);
      else reject(error);
    };
    const fail = (code) => {
      child.kill("SIGKILL");
      finish(stableFailure(code));
    };
    const timer = setTimeout(() => fail("REMINDER_FIXTURE_SQL_TIMEOUT"), timeoutMs);
    child.on("error", () => finish(stableFailure("REMINDER_FIXTURE_SQL_FAILED")));
    child.stdout.on("data", (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_SQL_OUTPUT_BYTES) {
        fail("REMINDER_FIXTURE_SQL_OUTPUT_INVALID");
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_SQL_OUTPUT_BYTES) fail("REMINDER_FIXTURE_SQL_OUTPUT_INVALID");
    });
    child.on("close", (code, signal) => {
      if (code !== 0 || signal !== null) {
        finish(stableFailure("REMINDER_FIXTURE_SQL_FAILED"));
        return;
      }
      finish(null, stdout.trim());
    });
    child.stdin.on("error", () => finish(stableFailure("REMINDER_FIXTURE_SQL_FAILED")));
    child.stdin.end(sql);
  });
}

function expectSqlMarker(output, expected) {
  requireThat(
    typeof output === "string" && output.trim() === expected,
    "REMINDER_FIXTURE_SQL_PROOF_INVALID",
  );
}

export function requireReminderFixtureProof(proof, expectedRunId) {
  const details = proofDetails.get(proof);
  requireThat(
    details !== undefined && !inactiveProofs.has(proof),
    "REMINDER_FIXTURE_PROOF_REQUIRED",
  );
  requireThat(details.artifacts.runId === expectedRunId, "REMINDER_FIXTURE_PROOF_MISMATCH");
  return details.artifacts;
}

export async function createReminderHistoryFixture(options) {
  const env = options?.env ?? process.env;
  requireThat(reminderFixtureRequested(env), "REMINDER_FIXTURE_OPT_IN_REQUIRED");
  const inspectTarget = options.inspectTarget ?? inspectCloudTestRoot;
  try {
    await inspectTarget(options.cwd ?? process.cwd());
  } catch (error) {
    if (error instanceof AcceptanceFailure) throw error;
    throw stableFailure("REMINDER_FIXTURE_TARGET_INVALID");
  }
  const databaseUrl = await resolveAdminDatabaseUrl(env);
  databaseEnvironment(databaseUrl, env);
  const artifacts = buildReminderFixtureArtifacts({
    runId: options.run.runId,
    now: options.now,
    session: options.session,
  });
  const executeSql =
    options.executeSql ?? ((sql) => runReminderFixtureSql(sql, databaseUrl, { env }));
  let proof = null;
  let prepared = false;

  const execute = async (sql, marker, code) => {
    let output;
    try {
      output = await executeSql(sql);
    } catch (error) {
      if (error instanceof AcceptanceFailure) throw error;
      throw stableFailure(code);
    }
    expectSqlMarker(output, marker);
  };

  return Object.freeze({
    prepare: async () => {
      if (prepared) return proof;
      await execute(
        buildReminderFixtureApplySql(artifacts),
        `ADR36_REMINDER_FIXTURE_APPLIED|${artifacts.runId}|3`,
        "REMINDER_FIXTURE_APPLY_FAILED",
      );
      prepared = true;
      proof = Object.freeze({ runId: artifacts.runId });
      proofDetails.set(proof, Object.freeze({ artifacts }));
      return proof;
    },
    verify: async (value) => {
      requireThat(prepared && proof !== null, "REMINDER_FIXTURE_NOT_PREPARED");
      requireReminderFixtureProof(proof, artifacts.runId);
      const evidence = validateReminderFixtureEvidence(value);
      await execute(
        buildReminderFixtureVerifySql(artifacts, evidence),
        `ADR36_REMINDER_FIXTURE_VERIFIED|${artifacts.runId}|3`,
        "REMINDER_FIXTURE_VERIFY_FAILED",
      );
      return Object.freeze({ runId: artifacts.runId, batchCount: evidence.batches.length });
    },
    cleanup: async () => {
      try {
        await execute(
          buildReminderFixtureCleanupSql(artifacts),
          `ADR36_REMINDER_FIXTURE_CLEANED|${artifacts.runId}|3`,
          "REMINDER_FIXTURE_CLEANUP_FAILED",
        );
        if (proof !== null) inactiveProofs.add(proof);
        prepared = false;
        return true;
      } catch {
        return false;
      }
    },
  });
}
