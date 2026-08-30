import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { localRuntimeCommissioningState } from "../local/bootstrap.js";
import { createPgPool, type PgPool } from "../db/pg-pool.js";
import { readSecretValue } from "../local/secret-file.js";
import {
  applyRuntimeMigrations,
  loadMigrationBundle,
  verifyRuntimeMigrationLedger,
} from "./migration-bundle.js";
import { runEmbeddedLanGateway } from "./lan-gateway-command.js";
import { applyRuntimeRoles, type RuntimeRoleClient } from "./role-bootstrap.js";
import { resolveRuntimeMigrationsRoot } from "./migration-root.js";
import { parseRuntimeRelease } from "./runtime-release.js";

const COMMANDS = Object.freeze([
  "server",
  "roles",
  "migrate",
  "bootstrap",
  "commission",
  "verify",
  "verify-commissioned",
  "commission-status",
  "migration-info",
  "lan-gateway",
] as const);
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
  const bundle = await loadMigrationBundle(resolveRuntimeMigrationsRoot(process.env));
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
    "LAUNDRY_BOOTSTRAP_APPROVER_USERNAME",
    "LAUNDRY_BOOTSTRAP_APPROVER_DISPLAY_NAME",
    "LAUNDRY_BOOTSTRAP_APPROVER_PASSWORD",
    "LAUNDRY_BOOTSTRAP_APPROVER_PIN",
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

const runCommission = async (): Promise<void> => {
  parseRuntimeRelease(process.env);
  for (const name of [
    "DATABASE_ADMIN_URL",
    "LAUNDRY_COMMISSION_APPROVER_USERNAME",
    "LAUNDRY_COMMISSION_APPROVER_DISPLAY_NAME",
    "LAUNDRY_COMMISSION_APPROVER_PASSWORD",
    "LAUNDRY_COMMISSION_APPROVER_PIN",
  ])
    requiredFileSecret(name);
  const script = fileURLToPath(new URL("../local/bootstrap-cli.js", import.meta.url));
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [script, "commission", "--confirm", "laundry-desk-v2-commission"],
      { shell: false, stdio: "inherit", env: process.env },
    );
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error("RUNTIME_COMMISSION_FAILED"));
    });
  });
};

const runVerify = async (
  requireCommissioned: boolean,
): Promise<"commissioned" | "commission_required"> => {
  const { bundle } = await loadVerifiedBundle();
  const adminPool = connect(requiredFileSecret("DATABASE_ADMIN_URL"));
  const appPool = connect(requiredFileSecret("DATABASE_URL"));
  try {
    await verifyRuntimeMigrationLedger(adminPool, bundle);
    const state = await localRuntimeCommissioningState(appPool, false);
    if (requireCommissioned && state !== "commissioned") {
      throw new Error("RUNTIME_COMMISSION_REQUIRED");
    }
    return state;
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

const runMigrationInfo = async (): Promise<void> => {
  const bundle = await loadMigrationBundle(resolveRuntimeMigrationsRoot(process.env));
  process.stdout.write(
    `${JSON.stringify({
      migrations_sha256: bundle.aggregateChecksum,
      migration_head: bundle.head,
    })}\n`,
  );
};

const runLanGateway = async (): Promise<void> => {
  parseRuntimeRelease(process.env);
  await runEmbeddedLanGateway();
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
  if (command === "commission") return runCommission();
  if (command === "migration-info") return runMigrationInfo();
  if (command === "lan-gateway") return runLanGateway();
  if (command === "verify") {
    await runVerify(false);
    return;
  }
  if (command === "verify-commissioned") {
    await runVerify(true);
    return;
  }
  const state = await runVerify(false);
  process.stdout.write(
    `${JSON.stringify({ commission_required: state === "commission_required" })}\n`,
  );
}

void main().catch((error: unknown) => {
  process.stderr.write(`${knownCode(error)}\n`);
  process.exitCode = 1;
});
