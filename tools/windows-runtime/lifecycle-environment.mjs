import { join } from "node:path";
import { digest, fail } from "./companion-contract.mjs";
import { readFile } from "node:fs/promises";

export function cleanEnvironment(source = process.env) {
  const env = {};
  for (const key of [
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "LOCALAPPDATA",
    "APPDATA",
    "USERPROFILE",
    "USERNAME",
    "USERDOMAIN",
  ]) {
    if (source[key]) env[key] = source[key];
  }
  if (!env.SystemRoot) fail("SYSTEM_ROOT_REQUIRED");
  env.PATH = join(env.SystemRoot, "System32");
  env.PSModulePath = join(env.SystemRoot, "System32/WindowsPowerShell/v1.0/Modules");
  return env;
}

export const secretNames = Object.freeze({
  DATABASE_ADMIN_URL: "database-admin-url",
  DATABASE_URL: "database-url",
  LAUNDRY_APP_PASSWORD: "postgres-app-password",
  LAUNDRY_ACCESS_TOKEN_SECRET: "access-token-secret",
  LAUNDRY_CSRF_PROOF_SECRET: "csrf-proof-secret",
  ...Object.fromEntries(
    ["ADMIN", "APPROVER"].flatMap((role) =>
      ["USERNAME", "DISPLAY_NAME", "PASSWORD", "PIN"].map((field) => {
        const name = `LAUNDRY_BOOTSTRAP_${role}_${field}`;
        return [name, name.toLowerCase().replaceAll("_", "-")];
      }),
    ),
  ),
});

export async function runtimeEnvironment(root, payload, manifest, io) {
  const env = cleanEnvironment();
  Object.assign(env, {
    NODE_ENV: "production",
    LAUNDRY_RUNTIME_RELEASE: manifest.runtime_release,
    LAUNDRY_RUNTIME_SOURCE_GIT_SHA: manifest.source_git_sha,
    LAUNDRY_RUNTIME_MIGRATIONS_SHA256: manifest.migrations_sha256,
    LAUNDRY_RUNTIME_MIGRATION_HEAD: manifest.migration_head,
    LAUNDRY_RUNTIME_MIGRATIONS_DIR: join(payload, "migrations"),
    LAUNDRY_RUNTIME_CONTRACTS_SHA256: digest(
      await readFile(join(payload, "metadata/contracts.json")),
    ),
    LAUNDRY_RUNTIME_SCHEMA_SHA256: digest(await readFile(join(payload, "metadata/schema.md"))),
    LAUNDRY_NOTIFICATION_PROVIDER_MODE: "disabled",
  });
  for (const [name, file] of Object.entries(secretNames)) {
    const path = join(root, "secrets", file);
    const value = await io.read(path);
    if (!value || /[\r\n\0]/u.test(value)) fail("SECRET_INVALID");
    env[`${name}_FILE`] = path;
  }
  env.PGPASSFILE = join(root, "secrets/pgpass.conf");
  await io.read(env.PGPASSFILE);
  return env;
}
