import { createHash, randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ensureLocalConfig } from "../local/config.mjs";
import { CATALOG_SQL, parseCatalogEvidence } from "./hk-vps-release-remote-db-evidence.mjs";
import { runWriteGatePgAcceptance } from "./hk-vps-release-write-gate-pg-acceptance.mjs";

const REQUIRED_ENVIRONMENT = Object.freeze({
  LAUNDRY_CLOUD_RELEASE_PG_TEST: "1",
  LAUNDRY_USE_LOCAL_PG: "1",
});
const MIGRATION = /^\d{4}_[a-z0-9_]+\.sql$/u;
const FROM_HEAD = "0055_delivery_appointments.sql";
const TO_HEAD = "0056_delivery_orders.sql";
const MIGRATIONS_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../packages/db/src/migrations",
);

function fail(code, cause) {
  const error = new Error(code, cause === undefined ? undefined : { cause });
  error.code = code;
  throw error;
}

function assertOptIn(environment) {
  if (
    environment === null ||
    typeof environment !== "object" ||
    Array.isArray(environment) ||
    Object.entries(REQUIRED_ENVIRONMENT).some(([name, value]) => environment[name] !== value)
  ) {
    fail("CLOUD_RELEASE_CATALOG_PG_OPT_IN_REQUIRED");
  }
}

function databaseUrl(password, database = "laundry_v2") {
  const url = new URL("postgresql://127.0.0.1:8543");
  url.username = "postgres";
  url.password = password;
  url.pathname = `/${database}`;
  return url.toString();
}

function defaultCreateClient(configuration) {
  const require = createRequire(new URL("../../apps/server/package.json", import.meta.url));
  const { Client } = require("pg");
  return new Client(configuration);
}

function clientConfiguration(password, database, applicationName) {
  return Object.freeze({
    application_name: applicationName,
    connectionString: databaseUrl(password, database),
    connectionTimeoutMillis: 10_000,
    query_timeout: 35_000,
    statement_timeout: 30_000,
  });
}

function catalogSource(result) {
  if (
    result === null ||
    typeof result !== "object" ||
    !Array.isArray(result.rows) ||
    result.rows.length === 0 ||
    result.rows.some(
      (row) =>
        row === null ||
        typeof row !== "object" ||
        Array.isArray(row) ||
        Object.keys(row).length !== 1 ||
        typeof row.value !== "string",
    )
  ) {
    fail("CLOUD_RELEASE_CATALOG_PG_RESULT_INVALID");
  }
  return `${result.rows.map((row) => row.value).join("\n")}\n`;
}

async function closeClient(client, operationError) {
  try {
    await client.end();
  } catch (error) {
    fail(
      "CLOUD_RELEASE_CATALOG_PG_CLEANUP_FAILED",
      operationError === undefined
        ? error
        : new AggregateError([operationError, error], "catalog probe and cleanup failed"),
    );
  }
}

async function queryCatalog(client, parseEvidence, requireCluster = false) {
  const result = await client.query(CATALOG_SQL);
  return parseEvidence(catalogSource(result), undefined, "stable", requireCluster);
}

function migrationDigest(source) {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

async function applyMigration(client, filename, source) {
  let transactionOpen = false;
  try {
    await client.query("BEGIN");
    transactionOpen = true;
    if (filename !== "0001_roles.sql") await client.query("SET ROLE laundry_owner");
    await client.query(source);
    if (filename !== "0001_roles.sql") await client.query("RESET ROLE");
    await client.query(
      "INSERT INTO public.laundry_schema_migrations(filename, checksum) VALUES ($1, $2)",
      [filename, migrationDigest(source)],
    );
    await client.query("COMMIT");
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

function assertMigrationFiles(files) {
  if (
    files.length < 2 ||
    files.some((name) => !MIGRATION.test(name)) ||
    files.at(-2) !== FROM_HEAD ||
    files.at(-1) !== TO_HEAD
  ) {
    fail("CLOUD_RELEASE_CATALOG_PG_MIGRATIONS_INVALID");
  }
}

export async function runCatalogMigrationChainAcceptance({
  password,
  createClient = defaultCreateClient,
  listMigrationFiles = async () =>
    (await readdir(MIGRATIONS_ROOT)).filter((name) => MIGRATION.test(name)).sort(),
  loadMigration = async (filename) => await readFile(join(MIGRATIONS_ROOT, filename), "utf8"),
  parseEvidence = parseCatalogEvidence,
  randomToken = () => randomBytes(8).toString("hex"),
} = {}) {
  const token = randomToken();
  if (!/^[0-9a-f]{16}$/u.test(token)) fail("CLOUD_RELEASE_CATALOG_PG_DATABASE_INVALID");
  const database = `laundry_catalog_accept_${token}`;
  const identifier = `"${database}"`;
  const admin = createClient(clientConfiguration(password, "postgres", "laundry-catalog-admin"));
  const migration = createClient(
    clientConfiguration(password, database, "laundry-catalog-migrations"),
  );
  let created = false;
  let result;
  let operationError;
  let cleanupError;
  const recordCleanupError = (error) => {
    cleanupError =
      cleanupError === undefined
        ? error
        : new AggregateError([cleanupError, error], "multiple catalog cleanup failures");
  };
  try {
    const files = await listMigrationFiles();
    assertMigrationFiles(files);
    await admin.connect();
    await admin.query(`CREATE DATABASE ${identifier} OWNER laundry_owner`);
    created = true;
    await admin.query(`GRANT CONNECT ON DATABASE ${identifier} TO laundry_app`);
    await migration.connect();
    await migration.query(`CREATE TABLE public.laundry_schema_migrations (
      filename text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    await migration.query("REVOKE ALL ON TABLE public.laundry_schema_migrations FROM PUBLIC");
    await migration.query("REVOKE ALL ON TABLE public.laundry_schema_migrations FROM laundry_app");
    for (const filename of files.slice(0, -1)) {
      await applyMigration(migration, filename, await loadMigration(filename));
    }
    const from = await queryCatalog(migration, parseEvidence, true);
    if (from.migrationHead !== FROM_HEAD) fail("CLOUD_RELEASE_CATALOG_PG_HEAD_INVALID");
    await applyMigration(migration, TO_HEAD, await loadMigration(TO_HEAD));
    const to = await queryCatalog(migration, parseEvidence, true);
    if (to.migrationHead !== TO_HEAD) fail("CLOUD_RELEASE_CATALOG_PG_HEAD_INVALID");
    result = Object.freeze({ from, to });
  } catch (error) {
    operationError = error;
  } finally {
    try {
      await migration.end();
    } catch (error) {
      recordCleanupError(error);
    }
    if (created) {
      try {
        await admin.query(`DROP DATABASE ${identifier} WITH (FORCE)`);
      } catch (error) {
        recordCleanupError(error);
      }
    }
    try {
      await admin.end();
    } catch (error) {
      recordCleanupError(error);
    }
  }
  if (cleanupError !== undefined) {
    fail(
      "CLOUD_RELEASE_CATALOG_PG_CLEANUP_FAILED",
      operationError === undefined
        ? cleanupError
        : new AggregateError([operationError, cleanupError], "catalog chain and cleanup failed"),
    );
  }
  if (result !== undefined) return result;
  fail("CLOUD_RELEASE_CATALOG_PG_CHAIN_FAILED", operationError);
}

export async function runReleaseCatalogPgAcceptance({
  environment = process.env,
  ensureConfig = ensureLocalConfig,
  createClient = defaultCreateClient,
  parseEvidence = parseCatalogEvidence,
  verifyMigrationChain = runCatalogMigrationChainAcceptance,
  verifyWriteGate = runWriteGatePgAcceptance,
} = {}) {
  assertOptIn(environment);
  const config = await ensureConfig({ env: environment });
  const client = createClient(
    clientConfiguration(
      config.postgresSuperuserPassword,
      "laundry_v2",
      "laundry-release-catalog-acceptance",
    ),
  );

  let evidence;
  let operationError;
  try {
    await client.connect();
    evidence = await queryCatalog(client, parseEvidence, true);
    await verifyMigrationChain({
      createClient,
      parseEvidence,
      password: config.postgresSuperuserPassword,
    });
    await verifyWriteGate({
      adminPassword: config.postgresSuperuserPassword,
      appPassword: config.postgresAppPassword,
      createClient,
    });
  } catch (error) {
    operationError = error;
  }
  await closeClient(client, operationError);
  if (operationError !== undefined || evidence === undefined) {
    fail("CLOUD_RELEASE_CATALOG_PG_ACCEPTANCE_FAILED", operationError);
  }
  return evidence;
}

async function main() {
  const evidence = await runReleaseCatalogPgAcceptance();
  process.stdout.write(
    `CLOUD_RELEASE_CATALOG_PG_ACCEPTANCE_OK entries=${evidence.entries} sha256=${evidence.sha256} heads=${FROM_HEAD},${TO_HEAD} write_gate=verified\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write("CLOUD_RELEASE_CATALOG_PG_ACCEPTANCE_FAILED\n");
    process.exitCode = 1;
  });
}
