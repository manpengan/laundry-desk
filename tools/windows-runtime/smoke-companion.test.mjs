import test from "node:test";
import assert from "node:assert/strict";
import { probeNativeDependencies } from "./smoke-companion.mjs";
import { BACKUP_FILES } from "./companion-contract.mjs";

const root = "/synthetic/runtime-payload";
const systemEnvironment = Object.freeze({
  SystemRoot: "C:\\Windows",
  NODE_OPTIONS: "--require untrusted-input",
  NODE_PATH: "untrusted-input",
  PGPASSWORD: "synthetic-private-fixture",
  DATABASE_URL: "synthetic-private-fixture",
});
const probeDependencies = (manifest, execute) =>
  probeNativeDependencies(root, manifest, execute, systemEnvironment);
const manifest = Object.freeze({
  sources: Object.freeze({ postgres: Object.freeze({ version: "16.15" }) }),
  migration_head: "0069_bounded_automation.sql",
  migrations_sha256: "a".repeat(64),
  files: Object.freeze(BACKUP_FILES.map((path) => Object.freeze({ path }))),
});
function runner(options = {}) {
  const calls = [];
  return {
    calls,
    async execute(file, args, settings) {
      calls.push({ file, args, settings });
      if (file.endsWith(".exe") && !file.endsWith("node.exe")) {
        if (options.failedTool && file.endsWith(`${options.failedTool}.exe`))
          throw new Error("untrusted external stderr must remain private");
        const tool = file.replaceAll("\\", "/").split("/").at(-1).slice(0, -4);
        return { stdout: `${tool} (PostgreSQL) ${options.version ?? "16.15"}\r\n` };
      }
      if (args[0] === "dist/runtime/kit-entrypoint.js")
        return {
          stdout: JSON.stringify({
            migration_head: manifest.migration_head,
            migrations_sha256: manifest.migrations_sha256,
          }),
        };
      return { stdout: options.nativeMarker ?? "NATIVE_MODULES_OK\r\n" };
    },
  };
}

test("native preflight verifies all backup tools before loading server modules with a clean environment", async () => {
  const probe = runner();
  assert.deepEqual(await probeDependencies(manifest, probe.execute), {
    postgres_tools_verified: 7,
  });
  assert.deepEqual(
    probe.calls.slice(0, 7).map(({ file }) => file.split("/").at(-1)),
    [
      "initdb.exe",
      "postgres.exe",
      "pg_ctl.exe",
      "psql.exe",
      "createdb.exe",
      "pg_dump.exe",
      "pg_restore.exe",
    ],
  );
  for (const { args, settings } of probe.calls.slice(0, 7)) {
    assert.deepEqual(args, ["--version"]);
    assert.equal(settings.env.NODE_OPTIONS, undefined);
    assert.equal(settings.env.NODE_PATH, undefined);
    assert.equal(settings.env.PGPASSWORD, undefined);
    assert.equal(settings.env.DATABASE_URL, undefined);
    assert.equal(settings.windowsHide, true);
    assert.equal(settings.timeout, 120000);
  }
  const nativeScript = probe.calls.at(-1).args[1];
  assert.match(nativeScript, /argon\.hashSync\(/u);
  assert.match(nativeScript, /argon\.verifySync\(/u);
});

test("a missing runtime library fails before migration inspection or password computation and masks raw diagnostics", async () => {
  const probe = runner({ failedTool: "initdb" });
  await assert.rejects(probeDependencies(manifest, probe.execute), {
    message: "WINDOWS_COMPANION_POSTGRES_DEPENDENCIES_UNAVAILABLE",
  });
  assert.equal(probe.calls.length, 1);
});

test("wrong PostgreSQL version is rejected before any server module is loaded", async () => {
  const probe = runner({ version: "16.14" });
  await assert.rejects(probeDependencies(manifest, probe.execute), /POSTGRES_VERSION_INVALID/u);
  assert.equal(probe.calls.length, 1);
});

test("legacy payloads without backup support retain their five-tool dependency preflight", async () => {
  const probe = runner();
  assert.equal(
    (await probeDependencies({ ...manifest, files: [] }, probe.execute)).postgres_tools_verified,
    5,
  );
  assert.equal(probe.calls.filter(({ file }) => /pg_(?:dump|restore)\.exe$/u.test(file)).length, 0);
});

test("native module completion requires the exact finite marker", async () => {
  const probe = runner({ nativeMarker: "NATIVE_MODULES_OK\nextra output" });
  await assert.rejects(probeDependencies(manifest, probe.execute), /NATIVE_MODULES_INVALID/u);
});
