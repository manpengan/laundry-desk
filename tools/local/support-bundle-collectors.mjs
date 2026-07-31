import { readdir } from "node:fs/promises";

import { composeCommand, resolveComposeProject } from "./compose.mjs";
import { readManagedFile } from "./support-bundle-safety.mjs";

const PACKAGE_BYTES = 64 * 1024;
const MIGRATION_BYTES = 256 * 1024;
const SEMVER = /^(?:0|[1-9]\d{0,12})\.(?:0|[1-9]\d{0,12})\.(?:0|[1-9]\d{0,12})$/u;
const MIGRATION_NAME = /^\d{4}_[a-z0-9_]+\.sql$/u;
const COMPOSE_SERVICES = Object.freeze(["postgres", "migrate", "bootstrap", "server"]);
const COMPOSE_STATES = Object.freeze([
  "created",
  "running",
  "restarting",
  "removing",
  "paused",
  "exited",
  "dead",
]);
const unavailable = (code) => Object.freeze({ status: "unavailable", code });

const isPlainObject = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

function hasExactKeys(value, expected) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

const isNonnegativeInteger = (value) => Number.isSafeInteger(value) && value >= 0;

function parsePackage(value, expectedName) {
  if (
    !isPlainObject(value) ||
    value.name !== expectedName ||
    typeof value.version !== "string" ||
    !SEMVER.test(value.version) ||
    Object.keys(value).some((key) => /(?:password|secret|token|credential|pin)/iu.test(key))
  ) {
    throw new Error("invalid package metadata");
  }
  return value.version;
}

async function readRepositoryPackage(directory, expectedName) {
  const bytes = await readManagedFile(directory, "package.json", PACKAGE_BYTES, {
    directoryMode: 0o755,
    fileMode: 0o644,
  });
  return parsePackage(JSON.parse(bytes.toString("utf8")), expectedName);
}

export async function collectProduct(context) {
  try {
    const [productVersion, desktopVersion] = await Promise.all([
      readRepositoryPackage(context.repositoryRoot, "laundry-desk"),
      readRepositoryPackage(context.edgePackageRoot, "@laundry/edge-agent"),
    ]);
    if (
      typeof context.nodeVersion !== "string" ||
      !/^v(?:0|[1-9]\d{0,3})\.(?:0|[1-9]\d{0,3})\.(?:0|[1-9]\d{0,3})$/u.test(context.nodeVersion) ||
      !["darwin", "linux", "win32"].includes(context.platform) ||
      !["arm64", "x64"].includes(context.arch)
    ) {
      return unavailable("PRODUCT_METADATA_INVALID");
    }
    return Object.freeze({
      status: "ok",
      product: "laundry-desk-v2",
      product_version: productVersion,
      desktop_runtime_version: desktopVersion,
      node_runtime_version: context.nodeVersion,
      platform: context.platform,
      arch: context.arch,
    });
  } catch {
    return unavailable("PRODUCT_METADATA_UNAVAILABLE");
  }
}

function parseDirectorySummary(value) {
  if (
    !isPlainObject(value) ||
    typeof value.exists !== "boolean" ||
    !isNonnegativeInteger(value.entries) ||
    !Object.keys(value).every((key) => ["exists", "entries", "valid"].includes(key)) ||
    ("valid" in value && typeof value.valid !== "boolean")
  ) {
    throw new Error("invalid directory summary");
  }
  return Object.freeze({
    exists: value.exists,
    valid: value.valid ?? null,
    entries: value.entries,
  });
}

function parseMaintenance(value) {
  if (
    !isPlainObject(value) ||
    typeof value.ok !== "boolean" ||
    !["missing", "state_invalid", "failed", "stale", "healthy"].includes(value.status)
  ) {
    throw new Error("invalid maintenance summary");
  }
  const allowedKeys = ["ok", "status", "age_seconds", "last_backup_at", "last_drill_at"];
  if (!Object.keys(value).every((key) => allowedKeys.includes(key))) {
    throw new Error("invalid maintenance summary");
  }
  if ("age_seconds" in value && !isNonnegativeInteger(value.age_seconds)) {
    throw new Error("invalid maintenance summary");
  }
  if (
    ("last_backup_at" in value &&
      (typeof value.last_backup_at !== "string" ||
        !Number.isFinite(Date.parse(value.last_backup_at)))) ||
    ("last_drill_at" in value &&
      value.last_drill_at !== null &&
      (typeof value.last_drill_at !== "string" ||
        !Number.isFinite(Date.parse(value.last_drill_at))))
  ) {
    throw new Error("invalid maintenance summary");
  }
  return Object.freeze({
    ok: value.ok,
    status: value.status,
    age_seconds: value.age_seconds ?? null,
  });
}

function selectDiagnoseReport(report) {
  if (
    !hasExactKeys(report, [
      "ok",
      "project",
      "config",
      "api",
      "compose",
      "storage",
      "maintenance",
    ]) ||
    typeof report.ok !== "boolean" ||
    typeof report.project !== "string" ||
    !/^laundry-[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/u.test(report.project) ||
    !hasExactKeys(report.config, ["valid", "instance_id"]) ||
    report.config.valid !== true ||
    typeof report.config.instance_id !== "string" ||
    !/^[A-Za-z0-9_-]{22,128}$/u.test(report.config.instance_id) ||
    !hasExactKeys(report.api, ["reachable", "ready"]) ||
    typeof report.api.reachable !== "boolean" ||
    typeof report.api.ready !== "boolean" ||
    !hasExactKeys(report.compose, ["reachable", "services_reported"]) ||
    typeof report.compose.reachable !== "boolean" ||
    typeof report.compose.services_reported !== "boolean" ||
    !hasExactKeys(report.storage, ["free_bytes", "photos", "backups"]) ||
    !isNonnegativeInteger(report.storage.free_bytes)
  ) {
    throw new Error("invalid diagnose report");
  }
  return Object.freeze({
    status: "ok",
    ok: report.ok,
    api: Object.freeze({ ...report.api }),
    compose: Object.freeze({ ...report.compose }),
    storage: Object.freeze({
      free_bytes: report.storage.free_bytes,
      photos: parseDirectorySummary(report.storage.photos),
      backups: parseDirectorySummary(report.storage.backups),
    }),
    maintenance: parseMaintenance(report.maintenance),
  });
}

export async function collectDiagnostics(context) {
  try {
    const report = await context.runDiagnose({
      argv: Object.freeze([]),
      env: context.env,
      cwd: context.cwd,
      stdout: () => undefined,
    });
    return selectDiagnoseReport(report);
  } catch {
    return unavailable("DIAGNOSTICS_UNAVAILABLE");
  }
}

function parseServiceNames(output) {
  if (typeof output !== "string" || Buffer.byteLength(output, "utf8") > 16_384) {
    throw new Error("invalid compose output");
  }
  const names = output
    .split(/\r?\n/u)
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  if (
    new Set(names).size !== names.length ||
    names.some((name) => !COMPOSE_SERVICES.includes(name))
  ) {
    throw new Error("invalid compose output");
  }
  return names;
}

async function collectComposeStates(context) {
  const project = resolveComposeProject(context.env);
  const states = Object.fromEntries(COMPOSE_SERVICES.map((service) => [service, "not_found"]));
  for (const state of COMPOSE_STATES) {
    const output = await context.capture(
      composeCommand(["ps", "--all", "--orphans=false", "--status", state, "--services"], {
        project,
      }),
      { cwd: context.cwd, env: context.env },
    );
    for (const service of parseServiceNames(output)) {
      if (states[service] !== "not_found") throw new Error("duplicate compose state");
      states[service] = state;
    }
  }
  return Object.freeze(states);
}

export async function collectServices(context) {
  const health = await context
    .probeHealthEndpoint("http://127.0.0.1:8787/health")
    .then((result) =>
      typeof result?.reachable === "boolean" && typeof result.ready === "boolean"
        ? Object.freeze({ status: "ok", reachable: result.reachable, ready: result.ready })
        : unavailable("SERVICE_HEALTH_INVALID"),
    )
    .catch(() => unavailable("SERVICE_HEALTH_UNAVAILABLE"));
  const compose = await collectComposeStates(context)
    .then((services) => Object.freeze({ status: "ok", services }))
    .catch(() => unavailable("COMPOSE_STATUS_UNAVAILABLE"));
  return Object.freeze({ status: "ok", health, compose });
}

export async function collectMigrations(context) {
  try {
    const names = (await readdir(context.migrationRoot)).sort();
    const sqlNames = names.filter((name) => name.endsWith(".sql"));
    if (
      sqlNames.length < 1 ||
      sqlNames.length > 128 ||
      sqlNames.some((name) => !MIGRATION_NAME.test(name))
    ) {
      return unavailable("MIGRATIONS_INVALID");
    }
    for (const name of sqlNames) {
      await readManagedFile(context.migrationRoot, name, MIGRATION_BYTES, {
        directoryMode: 0o755,
        fileMode: 0o644,
      });
    }
    return Object.freeze({
      status: "ok",
      count: sqlNames.length,
      filenames: Object.freeze(sqlNames),
    });
  } catch {
    return unavailable("MIGRATIONS_UNAVAILABLE");
  }
}

export async function collectServerLogs(context) {
  try {
    const project = resolveComposeProject(context.env);
    const output = await context.capture(
      composeCommand(["logs", "--no-color", "--tail", "200", "server"], { project }),
      { cwd: context.cwd, env: context.env },
    );
    if (typeof output !== "string" || Buffer.byteLength(output, "utf8") > 64 * 1024) {
      return unavailable("SERVER_LOGS_TOO_LARGE");
    }
    const allLines = output.split(/\r?\n/u).filter((line) => line.length > 0);
    const limited = allLines.slice(-200);
    return Object.freeze({
      status: "ok",
      line_count: limited.length,
      error_marker_count: limited.filter((line) => /\b(?:error|fatal)\b/iu.test(line)).length,
      truncated: allLines.length > limited.length,
    });
  } catch {
    return unavailable("SERVER_LOGS_UNAVAILABLE");
  }
}
