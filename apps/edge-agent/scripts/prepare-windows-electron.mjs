import { spawnSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const INSTALL_ENV = Object.freeze({
  ELECTRON_INSTALL_PLATFORM: "win32",
  ELECTRON_INSTALL_ARCH: "x64",
  ELECTRON_OVERRIDE_DIST_PATH: "",
  electron_use_remote_checksums: "",
  npm_config_electron_use_remote_checksums: "",
});

function requireSuccess(result, stage) {
  if (result.error || result.signal || result.status !== 0)
    throw new Error(`WINDOWS_ELECTRON_${stage}_FAILED`, { cause: result.error });
}

function replaceEnvironment(env, overrides) {
  const overridden = new Set(Object.keys(overrides).map((key) => key.toLowerCase()));
  return {
    ...Object.fromEntries(
      Object.entries(env).filter(([key]) => !overridden.has(key.toLowerCase())),
    ),
    ...overrides,
  };
}

async function inspectWindowsElectron(electronRoot, version, env, run) {
  const executable = join(electronRoot, "dist", "electron.exe");
  if (
    (await readFile(join(electronRoot, "dist", "version"), "utf8")).replace(/^v/u, "").trim() !==
      version ||
    (await readFile(join(electronRoot, "path.txt"), "utf8")) !== "electron.exe" ||
    !(await stat(executable)).isFile()
  )
    throw new Error("WINDOWS_ELECTRON_DIST_INVALID");
  const probe = run(
    executable,
    [
      "-p",
      "JSON.stringify({version:process.versions.electron,platform:process.platform,arch:process.arch})",
    ],
    {
      env: replaceEnvironment(env, { ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: "", NODE_PATH: "" }),
      encoding: "utf8",
      windowsHide: true,
      timeout: 30000,
    },
  );
  requireSuccess(probe, "PROBE");
  const actual = JSON.parse(probe.stdout.trim());
  if (actual.version !== version || actual.platform !== "win32" || actual.arch !== "x64")
    throw new Error("WINDOWS_ELECTRON_BINARY_VERSION_MISMATCH");
}

export async function prepareWindowsElectron({
  repositoryRoot = REPOSITORY_ROOT,
  platform = process.platform,
  env = process.env,
  run = spawnSync,
} = {}) {
  if (platform !== "win32") throw new Error("WINDOWS_ELECTRON_REQUIRES_WIN32");
  // This is the same root dependency directory as electron-builder.yml's electronDist.
  const electronRoot = join(repositoryRoot, "node_modules", "electron");
  const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
  const manifest = await readJson(join(repositoryRoot, "package.json"));
  const installed = await readJson(join(electronRoot, "package.json"));
  const version = manifest.devDependencies?.electron;
  if (!/^\d+\.\d+\.\d+$/u.test(version) || installed.version !== version)
    throw new Error("WINDOWS_ELECTRON_PACKAGE_VERSION_MISMATCH");
  // Electron 42 exposes install-electron without a postinstall lifecycle hook.
  // Use its installer explicitly, retaining its packaged checksum verification.
  const installEnv = replaceEnvironment(env, INSTALL_ENV);
  requireSuccess(
    run(process.execPath, [join(electronRoot, "install.js")], {
      env: installEnv,
      stdio: "inherit",
      windowsHide: true,
      timeout: 600000,
    }),
    "INSTALL",
  );
  await inspectWindowsElectron(electronRoot, version, installEnv, run);
  return Object.freeze({ version, platform: "win32", arch: "x64" });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw new Error("WINDOWS_ELECTRON_ARGS_INVALID");
    console.log("WINDOWS_ELECTRON_READY " + JSON.stringify(await prepareWindowsElectron()));
  } catch (error) {
    console.error(
      /^WINDOWS_ELECTRON_[A-Z_]+$/u.test(error.message)
        ? error.message
        : "WINDOWS_ELECTRON_PREPARATION_FAILED",
    );
    process.exitCode = 1;
  }
}
