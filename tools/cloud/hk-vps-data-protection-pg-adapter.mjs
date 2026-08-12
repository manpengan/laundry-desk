import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, lstat } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename } from "node:path";
import { promisify } from "node:util";

import { parseDataProtectionPhotoInventory } from "./hk-vps-data-protection-db.mjs";
import { sha256DataProtectionFile } from "./hk-vps-data-protection-hash.mjs";
import { fail, requireSha } from "./hk-vps-release-core.mjs";
import {
  CATALOG_SQL,
  migrationLedgerDigest,
  parseCatalogEvidence,
} from "./hk-vps-release-remote-db-evidence.mjs";
import { parseMigrationLedger } from "./hk-vps-release-remote-support.mjs";

const executeFile = promisify(execFile);
const DOCKER = "/usr/local/bin/docker";
const COMPOSE_FILE = "tools/compose/docker-compose.yml";
const CONTAINER = /^[0-9a-f]{12,64}$/u;
const DATABASE = /^[a-z][a-z0-9_]{0,62}$/u;

function databaseUrl(password, database) {
  if (typeof password !== "string" || password.length < 1 || !DATABASE.test(database)) {
    fail("CLOUD_DATA_PG_CONFIG_INVALID");
  }
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

async function runDocker(arguments_, options = {}) {
  try {
    return await executeFile(DOCKER, arguments_, {
      cwd: options.cwd,
      encoding: "utf8",
      env: options.environment,
      maxBuffer: 2 * 1024 * 1024,
      timeout: options.timeoutMs ?? 10 * 60_000,
    });
  } catch (error) {
    fail(options.code ?? "CLOUD_DATA_PG_DOCKER_FAILED", error);
  }
}

export async function discoverDataProtectionPostgresContainer(options) {
  const result = await (options.runDocker ?? runDocker)(
    ["compose", "-p", options.project, "-f", COMPOSE_FILE, "ps", "-q", "postgres"],
    {
      cwd: options.cwd,
      environment: options.environment,
      code: "CLOUD_DATA_PG_CONTAINER_INVALID",
    },
  );
  const container = result.stdout.trim();
  if (!CONTAINER.test(container)) fail("CLOUD_DATA_PG_CONTAINER_INVALID");
  return container;
}

function catalogSource(result) {
  if (
    !Array.isArray(result.rows) ||
    result.rows.length < 1 ||
    result.rows.some(
      (row) =>
        row === null ||
        typeof row !== "object" ||
        Object.keys(row).join(",") !== "value" ||
        typeof row.value !== "string",
    )
  ) {
    fail("CLOUD_DATA_PG_QUERY_INVALID");
  }
  return `${result.rows.map((row) => row.value).join("\n")}\n`;
}

function clientConfiguration(password, database, applicationName) {
  return Object.freeze({
    application_name: applicationName,
    connectionString: databaseUrl(password, database),
    connectionTimeoutMillis: 10_000,
    query_timeout: 60_000,
    statement_timeout: 55_000,
  });
}

export function createDataProtectionPgAdapter(options) {
  if (!CONTAINER.test(options.container)) fail("CLOUD_DATA_PG_CONTAINER_INVALID");
  const createClient = options.createClient ?? defaultCreateClient;
  const docker = options.runDocker ?? runDocker;
  const withClient = async (database, operation) => {
    const client = createClient(
      clientConfiguration(options.password, database, "laundry-data-protection-acceptance"),
    );
    let operationError;
    try {
      await client.connect();
      return await operation(client);
    } catch (error) {
      operationError = error;
      throw error;
    } finally {
      await client.end().catch((error) => {
        fail(
          "CLOUD_DATA_PG_CLIENT_CLEANUP_FAILED",
          operationError === undefined
            ? error
            : new AggregateError([operationError, error], "query and cleanup failed"),
        );
      });
    }
  };
  const query = async (database, sql, parameters = []) =>
    await withClient(database, async (client) => await client.query(sql, parameters));
  const readLedger = async (database) => {
    const result = await query(
      database,
      "SELECT filename, checksum FROM public.laundry_schema_migrations ORDER BY filename",
    );
    const source = result.rows.map((row) => `${row.filename}\t${row.checksum}`).join("\n");
    return parseMigrationLedger(source === "" ? "" : `${source}\n`);
  };
  const readCatalog = async (database, _signal, clusterState = "write_frozen") => {
    const result = await query(database, CATALOG_SQL);
    return parseCatalogEvidence(
      catalogSource(result),
      undefined,
      clusterState,
      database === "laundry_v2",
    );
  };
  const readPhotos = async (database) => {
    const result = await query(
      database,
      `SELECT storage_key, byte_size, content_sha256
         FROM public.garment_photos
        WHERE content_sha256 IS NOT NULL
        ORDER BY storage_key`,
    );
    const source = result.rows
      .map((row) => `${row.storage_key}\t${row.byte_size}\t${row.content_sha256}`)
      .join("\n");
    return parseDataProtectionPhotoInventory(source === "" ? "" : `${source}\n`);
  };
  const containerFile = () => `/tmp/laundry-data-${randomBytes(12).toString("hex")}.dump`;
  const copyIntoContainer = async (source, target) => {
    await docker(["cp", source, `${options.container}:${target}`], {
      cwd: options.cwd,
      environment: options.environment,
      code: "CLOUD_DATA_PG_COPY_FAILED",
    });
  };
  const removeContainerFile = async (path) => {
    await docker(["exec", options.container, "rm", "-f", "--", path], {
      cwd: options.cwd,
      environment: options.environment,
      code: "CLOUD_DATA_PG_CLEANUP_FAILED",
    });
  };
  const createDump = async (path, database = "laundry_v2") => {
    const temporary = containerFile();
    try {
      await docker(
        [
          "exec",
          options.container,
          "pg_dump",
          "-U",
          "postgres",
          "--format=custom",
          `--dbname=${database}`,
          `--file=${temporary}`,
        ],
        { cwd: options.cwd, environment: options.environment, code: "CLOUD_DATA_PG_DUMP_FAILED" },
      );
      await docker(["cp", `${options.container}:${temporary}`, path], {
        cwd: options.cwd,
        environment: options.environment,
        code: "CLOUD_DATA_PG_COPY_FAILED",
      });
      await chmod(path, 0o600);
      const metadata = await lstat(path);
      return Object.freeze({
        file: basename(path),
        bytes: metadata.size,
        sha256: await sha256DataProtectionFile(path),
      });
    } finally {
      await removeContainerFile(temporary);
    }
  };
  const restore = async (path, database, clean = false) => {
    if (!DATABASE.test(database)) fail("CLOUD_DATA_DATABASE_NAME_INVALID");
    const temporary = containerFile();
    try {
      await copyIntoContainer(path, temporary);
      await docker(
        [
          "exec",
          options.container,
          "pg_restore",
          "-U",
          "postgres",
          ...(clean ? ["--clean", "--if-exists"] : []),
          "--exit-on-error",
          "--single-transaction",
          `--dbname=${database}`,
          temporary,
        ],
        {
          cwd: options.cwd,
          environment: options.environment,
          timeoutMs: 10 * 60_000,
          code: "CLOUD_DATA_PG_RESTORE_FAILED",
        },
      );
    } finally {
      await removeContainerFile(temporary);
    }
  };
  const postgresCommand = async (file, arguments_) => {
    const command = basename(file);
    if (!new Set(["psql", "createdb", "dropdb"]).has(command)) {
      fail("CLOUD_DATA_PG_COMMAND_INVALID");
    }
    return await docker(["exec", options.container, command, "-U", "postgres", ...arguments_], {
      cwd: options.cwd,
      environment: options.environment,
      code: "CLOUD_DATA_PG_COMMAND_FAILED",
    });
  };
  const setWriteGate = async (canLogin) => {
    await query("postgres", `ALTER ROLE laundry_app ${canLogin ? "LOGIN" : "NOLOGIN"}`);
    const result = await query(
      "postgres",
      "SELECT rolcanlogin FROM pg_catalog.pg_roles WHERE rolname = 'laundry_app'",
    );
    if (result.rows.length !== 1 || result.rows[0].rolcanlogin !== canLogin) {
      fail("CLOUD_DATA_PG_WRITE_GATE_INVALID");
    }
  };
  return Object.freeze({
    query,
    readLedger,
    readCatalog,
    readPhotos,
    createDump,
    restore,
    postgresCommand,
    setWriteGate,
    sourceEvidence: async (codeSha) => {
      const ledger = await readLedger("laundry_v2");
      const catalog = await readCatalog("laundry_v2", undefined, "write_frozen");
      return Object.freeze({
        codeSha: requireSha(codeSha),
        migration: Object.freeze({
          head: ledger.at(-1)?.filename,
          count: ledger.length,
          ledger_sha256: migrationLedgerDigest(ledger),
          catalog_sha256: catalog.sha256,
        }),
        photos: await readPhotos("laundry_v2"),
      });
    },
    drillDependencies: Object.freeze({
      postgresCommand,
      restoreBackup: async (path, database) => await restore(path, database, false),
      readMigrationLedger: readLedger,
      readCatalogEvidence: readCatalog,
      readPhotoInventory: readPhotos,
    }),
    verificationDependencies: Object.freeze({
      readMigrationLedger: readLedger,
      readCatalogEvidence: readCatalog,
      readPhotoInventory: readPhotos,
    }),
  });
}
