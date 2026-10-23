import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareMacElectron } from "./prepare-macos-electron.mjs";

const VERSION = "42.11.9";
const EXECUTABLE_PATH = "Electron.app/Contents/MacOS/Electron";
const BINARY = Object.freeze({ version: VERSION, platform: "darwin", arch: "arm64" });

async function fixture(t, installer = "") {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "ld-macos-electron-prepare-"));
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  const electronRoot = join(repositoryRoot, "node_modules", "electron");
  await mkdir(electronRoot, { recursive: true });
  await writeFile(
    join(repositoryRoot, "package.json"),
    JSON.stringify({ devDependencies: { electron: VERSION } }),
  );
  // Reproduce Electron 42's npm package: installer present, no postinstall or dist.
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
  fs.mkdirSync(path.join(dist, 'Electron.app/Contents/MacOS'), { recursive: true });
  fs.writeFileSync(path.join(dist, 'version'), '${VERSION}');
  fs.writeFileSync(path.join(dist, '${EXECUTABLE_PATH}'), 'synthetic binary fixture');
  fs.writeFileSync(path.join(__dirname, 'path.txt'), '${EXECUTABLE_PATH}');
}
`,
  );
  return { repositoryRoot, electronRoot, platform: "darwin", arch: "arm64" };
}

function fixtureRunner(binary = BINARY) {
  return (executable, args, options) =>
    executable === process.execPath
      ? spawnSync(executable, args, options)
      : { status: 0, stdout: JSON.stringify(binary) };
}

test("explicit installer prepares an absent macOS binary without postinstall and can run again", async (t) => {
  const options = await fixture(t);
  await assert.rejects(readFile(join(options.electronRoot, "path.txt")), { code: "ENOENT" });
  const run = fixtureRunner();
  assert.deepEqual(await prepareMacElectron({ ...options, run }), BINARY);
  const binaryPath = join(options.electronRoot, "dist", EXECUTABLE_PATH);
  const firstBinary = await readFile(binaryPath);
  assert.deepEqual(await prepareMacElectron({ ...options, run }), BINARY);
  assert.deepEqual(await readFile(binaryPath), firstBinary);
});

test("pins host arm64 and x64, suppresses Rosetta retargeting and retains packaged checksums", async (t) => {
  const options = await fixture(t);
  const env = Object.freeze({
    ...process.env,
    ELECTRON_INSTALL_PLATFORM: "win32",
    ELECTRON_INSTALL_ARCH: "ia32",
    npm_config_arch: "ia32",
    ELECTRON_OVERRIDE_DIST_PATH: "unrelated",
    electron_use_remote_checksums: "1",
    npm_config_electron_use_remote_checksums: "1",
  });
  for (const arch of ["arm64", "x64"]) {
    const binary = { ...BINARY, arch };
    let calls = 0;
    const run = (executable, args, input) => {
      calls += 1;
      assert.equal(input.env.ELECTRON_INSTALL_PLATFORM, "darwin");
      assert.equal(input.env.ELECTRON_INSTALL_ARCH, arch);
      assert.equal(input.env.npm_config_arch, arch);
      assert.equal(input.env.ELECTRON_OVERRIDE_DIST_PATH, "");
      assert.equal(input.env.electron_use_remote_checksums, "");
      assert.equal(input.env.npm_config_electron_use_remote_checksums, "");
      if (executable !== process.execPath) assert.equal(input.env.ELECTRON_RUN_AS_NODE, "1");
      return fixtureRunner(binary)(executable, args, input);
    };
    assert.deepEqual(await prepareMacElectron({ ...options, arch, env, run }), binary);
    assert.equal(calls, 2);
  }
  assert.equal(env.ELECTRON_INSTALL_ARCH, "ia32");
});

test("installer nonzero, signal, timeout and absent exit status stop before binary probing", async (t) => {
  const options = await fixture(t);
  const failing = await fixture(t, "process.exit(9);\n");
  await assert.rejects(
    prepareMacElectron({ ...failing, run: fixtureRunner() }),
    /MACOS_ELECTRON_INSTALL_FAILED/u,
  );
  for (const failure of [
    { status: 1 },
    { status: null, signal: "SIGTERM" },
    { status: null, error: new Error("timeout") },
    { status: null },
  ]) {
    let calls = 0;
    await assert.rejects(
      prepareMacElectron({
        ...options,
        run: () => {
          calls += 1;
          return failure;
        },
      }),
      /MACOS_ELECTRON_INSTALL_FAILED/u,
    );
    assert.equal(calls, 1);
  }
});

test("wrong installed package, platform or architecture rejects before invoking executables", async (t) => {
  const options = await fixture(t);
  const run = () => assert.fail("must not execute");
  for (const platform of ["win32", "linux"])
    await assert.rejects(
      prepareMacElectron({ ...options, platform, run }),
      /MACOS_ELECTRON_REQUIRES_DARWIN/u,
    );
  await assert.rejects(
    prepareMacElectron({ ...options, arch: "ia32", run }),
    /MACOS_ELECTRON_ARCH_INVALID/u,
  );
  await writeFile(join(options.electronRoot, "package.json"), JSON.stringify({ version: "1.0.0" }));
  await assert.rejects(
    prepareMacElectron({ ...options, run }),
    /MACOS_ELECTRON_PACKAGE_VERSION_MISMATCH/u,
  );
});

test("successful installer cannot conceal absent or wrong dist metadata", async (t) => {
  const absent = await fixture(t, "process.exit(0);\n");
  await assert.rejects(prepareMacElectron({ ...absent, run: fixtureRunner() }), {
    code: "ENOENT",
  });
  const options = await fixture(t);
  await prepareMacElectron({ ...options, run: fixtureRunner() });
  await writeFile(join(options.electronRoot, "path.txt"), "../wrong");
  await assert.rejects(
    prepareMacElectron({ ...options, run: fixtureRunner() }),
    /MACOS_ELECTRON_DIST_INVALID/u,
  );
});

test("actual binary must report the locked version, macOS and selected arch and exit successfully", async (t) => {
  const options = await fixture(t);
  for (const binary of [
    { ...BINARY, version: "1.0.0" },
    { ...BINARY, platform: "linux" },
    { ...BINARY, arch: "x64" },
  ])
    await assert.rejects(
      prepareMacElectron({ ...options, run: fixtureRunner(binary) }),
      /MACOS_ELECTRON_BINARY_VERSION_MISMATCH/u,
    );
  await assert.rejects(
    prepareMacElectron({
      ...options,
      run: (exe, args, input) =>
        exe === process.execPath
          ? spawnSync(exe, args, input)
          : { status: 1, stdout: JSON.stringify(BINARY) },
    }),
    /MACOS_ELECTRON_PROBE_FAILED/u,
  );
});

test("standard macOS packaging prepares Electron before build and electron-builder", async () => {
  const { scripts } = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(scripts["electron:prepare:mac"], "node scripts/prepare-macos-electron.mjs");
  assert.ok(scripts["package:mac"].startsWith("pnpm run electron:prepare:mac && "));
});
