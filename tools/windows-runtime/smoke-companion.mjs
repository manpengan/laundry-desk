import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { inspectCompanion } from "./inspect-companion.mjs";
import { fail } from "./companion-contract.mjs";

export async function smokeCompanion(root, expectedDigest) {
  if (process.platform !== "win32" || process.arch !== "x64") fail("SMOKE_PLATFORM_INVALID");
  root = resolve(root);
  const manifest = await inspectCompanion(root, expectedDigest);
  const env = {};
  for (const name of [
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "LOCALAPPDATA",
    "APPDATA",
    "USERPROFILE",
  ]) {
    if (process.env[name]) env[name] = process.env[name];
  }
  env.PATH = join(process.env.SystemRoot, "System32");
  env.LAUNDRY_RUNTIME_MIGRATIONS_DIR = join(root, "migrations");
  const run = promisify(execFile);
  const options = {
    cwd: join(root, "server"),
    env,
    windowsHide: true,
    timeout: 120000,
    maxBuffer: 65536,
  };
  const node = join(root, "node/node.exe");
  const info = JSON.parse(
    (await run(node, ["dist/runtime/kit-entrypoint.js", "migration-info"], options)).stdout,
  );
  if (
    info.migration_head !== manifest.migration_head ||
    info.migrations_sha256 !== manifest.migrations_sha256
  )
    fail("MIGRATION_MISMATCH");
  const script = `const sharp = require('sharp'); const argon = require('@node-rs/argon2');
    if (!sharp.versions.vips || typeof argon.hashSync !== 'function') process.exit(1);
    console.log('NATIVE_MODULES_OK');`;
  if ((await run(node, ["-e", script], options)).stdout.trim() !== "NATIVE_MODULES_OK")
    fail("NATIVE_MODULES_INVALID");
  return {
    status: "no_repo_payload_smoke_passed",
    assurance: "development_only",
    source_git_sha: manifest.source_git_sha,
    migration_head: manifest.migration_head,
    database_initialized: false,
    installed: false,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4) fail("ARGS_INVALID");
    console.log(JSON.stringify(await smokeCompanion(process.argv[2], process.argv[3])));
  } catch (error) {
    console.error(
      /^WINDOWS_COMPANION_[A-Z_]+$/u.test(error.message)
        ? error.message
        : "WINDOWS_COMPANION_SMOKE_FAILED",
    );
    process.exitCode = 1;
  }
}
