import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { assertLocalBootstrapReady } from "../local/bootstrap.js";
import { createPgPool, type PgPool } from "../db/pg-pool.js";
import { readSecretValue } from "../local/secret-file.js";
import {
  applyRuntimeMigrations,
  loadMigrationBundle,
  verifyRuntimeMigrationLedger,
} from "./migration-bundle.js";
import { applyRuntimeRoles, type RuntimeRoleClient } from "./role-bootstrap.js";
import { parseRuntimeRelease } from "./runtime-release.js";

const MIGRATIONS_ROOT = "/opt/laundry/migrations";
const COMMANDS = Object.freeze(["server", "roles", "migrate", "bootstrap", "verify"] as const);
type RuntimeCommand = (typeof COMMANDS)[number];

const knownCode = (error: unknown): string => {
  const message = error instanceof Error ? error.message : "";
  return /^RUNTIME_[A-Z_]+$/u.test(message) ? message : "RUNTIME_ENTRYPOINT_FAILED";
};

const requiredFileSecret = (name: string): string => {
  if (process.env[name] !== undefined || process.env[`${name}_FILE`] === undefined) {
    throw new Error("RUNTIME_SECRET_FILE_REQUIRED");
  }
  const value = readSecretValue(process.env, name);
  if (value === undefined || value.length === 0) throw new Error("RUNTIME_SECRET_FILE_REQUIRED");
  return value;
};

const connect = (url: string): PgPool => createPgPool({ connectionString: url, max: 1 });

const loadVerifiedBundle = async () => {
  const release = parseRuntimeRelease(process.env);
  const bundle = await loadMigrationBundle(MIGRATIONS_ROOT);
  if (
    bundle.aggregateChecksum !== release.migrationsChecksum ||
    bundle.head !== release.migrationHead
  ) {
    throw new Error("RUNTIME_MIGRATION_BUNDLE_MISMATCH");
  }
  return Object.freeze({ release, bundle });
};

const runRoles = async (): Promise<void> => {
  parseRuntimeRelease(process.env);
  const pool = connect(requiredFileSecret("DATABASE_ADMIN_URL"));
  const client = await pool.connect();
  try {
    const adapter: RuntimeRoleClient = Object.freeze({
      query: async (text, values) => {
        const result = await client.query(text, values === undefined ? undefined : [...values]);
        return Object.freeze({ rows: result.rows as readonly Record<string, unknown>[] });
      },
    });
    await applyRuntimeRoles(adapter, requiredFileSecret("LAUNDRY_APP_PASSWORD"));
  } finally {
    client.release();
    await pool.end();
  }
};

const runMigrate = async (): Promise<void> => {
  const { bundle } = await loadVerifiedBundle();
  const pool = connect(requiredFileSecret("DATABASE_ADMIN_URL"));
  try {
    await applyRuntimeMigrations(pool, bundle);
  } finally {
    await pool.end();
  }
};

const runBootstrap = async (): Promise<void> => {
  parseRuntimeRelease(process.env);
  for (const name of [
    "DATABASE_ADMIN_URL",
    "LAUNDRY_BOOTSTRAP_ADMIN_USERNAME",
    "LAUNDRY_BOOTSTRAP_ADMIN_DISPLAY_NAME",
    "LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD",
    "LAUNDRY_BOOTSTRAP_ADMIN_PIN",
  ]) {
    requiredFileSecret(name);
  }
  const script = fileURLToPath(new URL("../local/bootstrap-cli.js", import.meta.url));
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [script, "--confirm", "laundry-desk-v2-local"], {
      shell: false,
      stdio: "inherit",
      env: process.env,
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error("RUNTIME_BOOTSTRAP_FAILED"));
    });
  });
};

const runVerify = async (): Promise<void> => {
  const { bundle } = await loadVerifiedBundle();
  const adminPool = connect(requiredFileSecret("DATABASE_ADMIN_URL"));
  const appPool = connect(requiredFileSecret("DATABASE_URL"));
  try {
    await verifyRuntimeMigrationLedger(adminPool, bundle);
    await assertLocalBootstrapReady(appPool, false);
  } finally {
    await Promise.allSettled([adminPool.end(), appPool.end()]);
  }
};

const runServer = async (): Promise<void> => {
  parseRuntimeRelease(process.env);
  requiredFileSecret("DATABASE_URL");
  requiredFileSecret("LAUNDRY_ACCESS_TOKEN_SECRET");
  requiredFileSecret("LAUNDRY_CSRF_PROOF_SECRET");
  await import("../http/main.js");
};

const parseCommand = (): RuntimeCommand => {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !COMMANDS.includes(args[0] as RuntimeCommand)) {
    throw new Error("RUNTIME_ENTRYPOINT_ARGS_INVALID");
  }
  return args[0] as RuntimeCommand;
};

async function main(): Promise<void> {
  const command = parseCommand();
  if (command === "server") return runServer();
  if (command === "roles") return runRoles();
  if (command === "migrate") return runMigrate();
  if (command === "bootstrap") return runBootstrap();
  return runVerify();
}

void main().catch((error: unknown) => {
  process.stderr.write(`${knownCode(error)}\n`);
  process.exitCode = 1;
});
