import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareWindowsElectron } from "./prepare-windows-electron.mjs";

const VERSION = "42.11.9";
const BINARY = Object.freeze({ version: VERSION, platform: "win32", arch: "x64" });

async function fixture(t, installer = "") {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "ld-electron-prepare-"));
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  const electronRoot = join(repositoryRoot, "node_modules", "electron");
  await mkdir(electronRoot, { recursive: true });
  await writeFile(
    join(repositoryRoot, "package.json"),
    JSON.stringify({ devDependencies: { electron: VERSION } }),
  );
  // Reproduce the installed npm package's missing lifecycle hook and binary.
  await writeFile(
    join(electronRoot, "package.json"),
    JSON.stringify({ version: VERSION, bin: { "install-electron": "install.js" } }),
  );
  await writeFile(
    join(electronRoot, "install.js"),
    installer ||
      `const fs = require('node:fs');
const path = require('node:path');
const dist = path.join(__dirname, 'dist');
if (!fs.existsSync(dist)) {
  fs.mkdirSync(dist);
  fs.writeFileSync(path.join(dist, 'version'), '${VERSION}');
  fs.writeFileSync(path.join(dist, 'electron.exe'), 'synthetic binary fixture');
  fs.writeFileSync(path.join(__dirname, 'path.txt'), 'electron.exe');
}
`,
  );
  return { repositoryRoot, electronRoot, platform: "win32" };
}

function fixtureRunner(binary = BINARY) {
  return (executable, args, options) =>
    executable === process.execPath
      ? spawnSync(executable, args, options)
      : { status: 0, stdout: JSON.stringify(binary) };
}

test("explicit installer prepares an absent binary without postinstall and can run again", async (t) => {
  const options = await fixture(t);
  await assert.rejects(readFile(join(options.electronRoot, "path.txt")), { code: "ENOENT" });
  const run = fixtureRunner();
  assert.deepEqual(await prepareWindowsElectron({ ...options, run }), BINARY);
  const firstBinary = await readFile(join(options.electronRoot, "dist", "electron.exe"));
  assert.deepEqual(await prepareWindowsElectron({ ...options, run }), BINARY);
  assert.deepEqual(await readFile(join(options.electronRoot, "dist", "electron.exe")), firstBinary);
});

test("installation pins win32/x64 and packaged checksums despite case-insensitive environment keys", async (t) => {
  const options = await fixture(t);
  const env = Object.freeze({
    ...process.env,
    electron_install_platform: "linux",
    ELECTRON_INSTALL_ARCH: "arm64",
    ELECTRON_OVERRIDE_DIST_PATH: "unrelated",
    ELECTRON_USE_REMOTE_CHECKSUMS: "1",
    npm_config_electron_use_remote_checksums: "1",
  });
  let calls = 0;
  const run = (executable, args, input) => {
    calls += 1;
    assert.equal(input.env.ELECTRON_INSTALL_PLATFORM, "win32");
    assert.equal(input.env.ELECTRON_INSTALL_ARCH, "x64");
    assert.equal(input.env.ELECTRON_OVERRIDE_DIST_PATH, "");
    assert.equal(input.env.electron_use_remote_checksums, "");
    assert.equal(input.env.npm_config_electron_use_remote_checksums, "");
    assert.equal(input.env.electron_install_platform, undefined);
    assert.equal(input.env.ELECTRON_USE_REMOTE_CHECKSUMS, undefined);
    if (executable !== process.execPath) assert.equal(input.env.ELECTRON_RUN_AS_NODE, "1");
    return fixtureRunner()(executable, args, input);
  };
  assert.deepEqual(await prepareWindowsElectron({ ...options, env, run }), BINARY);
  assert.equal(calls, 2);
  assert.equal(env.ELECTRON_INSTALL_ARCH, "arm64");
});

test("installer nonzero, signal, timeout and absent exit status stop before binary probing", async (t) => {
  const options = await fixture(t);
  const failing = await fixture(t, "process.exit(9);\n");
  await assert.rejects(
    prepareWindowsElectron({ ...failing, run: fixtureRunner() }),
    /WINDOWS_ELECTRON_INSTALL_FAILED/u,
  );
  for (const failure of [
    { status: 1 },
    { status: null, signal: "SIGTERM" },
    { status: null, error: new Error("timeout") },
    { status: null },
  ]) {
    let calls = 0;
    await assert.rejects(
      prepareWindowsElectron({
        ...options,
        run: () => {
          calls += 1;
          return failure;
        },
      }),
      /WINDOWS_ELECTRON_INSTALL_FAILED/u,
    );
    assert.equal(calls, 1);
  }
});

test("wrong installed package is rejected before invoking any executable", async (t) => {
  const options = await fixture(t);
  await writeFile(join(options.electronRoot, "package.json"), JSON.stringify({ version: "1.0.0" }));
  await assert.rejects(
    prepareWindowsElectron({ ...options, run: () => assert.fail("must not execute") }),
    /WINDOWS_ELECTRON_PACKAGE_VERSION_MISMATCH/u,
  );
  await assert.rejects(
    prepareWindowsElectron({
      ...options,
      platform: "darwin",
      run: () => assert.fail("must not execute"),
    }),
    /WINDOWS_ELECTRON_REQUIRES_WIN32/u,
  );
});

test("successful installer cannot conceal absent or wrong dist metadata", async (t) => {
  const absent = await fixture(t, "process.exit(0);\n");
  await assert.rejects(prepareWindowsElectron({ ...absent, run: fixtureRunner() }), {
    code: "ENOENT",
  });
  const options = await fixture(t);
  await prepareWindowsElectron({ ...options, run: fixtureRunner() });
  await writeFile(join(options.electronRoot, "path.txt"), "../wrong.exe");
  await assert.rejects(
    prepareWindowsElectron({ ...options, run: fixtureRunner() }),
    /WINDOWS_ELECTRON_DIST_INVALID/u,
  );
});

test("actual binary must report the locked version and Windows x64 and exit successfully", async (t) => {
  const options = await fixture(t);
  for (const binary of [
    { ...BINARY, version: "1.0.0" },
    { ...BINARY, platform: "linux" },
    { ...BINARY, arch: "arm64" },
  ])
    await assert.rejects(
      prepareWindowsElectron({ ...options, run: fixtureRunner(binary) }),
      /WINDOWS_ELECTRON_BINARY_VERSION_MISMATCH/u,
    );
  await assert.rejects(
    prepareWindowsElectron({
      ...options,
      run: (exe, args, input) =>
        exe === process.execPath
          ? spawnSync(exe, args, input)
          : { status: 1, stdout: JSON.stringify(BINARY) },
    }),
    /WINDOWS_ELECTRON_PROBE_FAILED/u,
  );
});

test("standard Windows packaging and update entry points explicitly prepare Electron first", async () => {
  const { scripts } = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(scripts["electron:prepare:win"], "node scripts/prepare-windows-electron.mjs");
  for (const name of ["package:win", "release:update:win"])
    assert.ok(scripts[name].startsWith("pnpm run electron:prepare:win && "));
});
