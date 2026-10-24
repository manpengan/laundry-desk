import { spawnSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const EXECUTABLE_PATH = "Electron.app/Contents/MacOS/Electron";

function requireSuccess(result, stage) {
  if (result.error || result.signal || result.status !== 0)
    throw new Error(`MACOS_ELECTRON_${stage}_FAILED`, { cause: result.error });
}

async function inspectMacElectron(electronRoot, version, arch, env, run) {
  const executable = join(electronRoot, "dist", EXECUTABLE_PATH);
  if (
    (await readFile(join(electronRoot, "dist", "version"), "utf8")).replace(/^v/u, "").trim() !==
      version ||
    (await readFile(join(electronRoot, "path.txt"), "utf8")) !== EXECUTABLE_PATH ||
    !(await stat(executable)).isFile()
  )
    throw new Error("MACOS_ELECTRON_DIST_INVALID");
  const probe = run(
    executable,
    [
      "-p",
      "JSON.stringify({version:process.versions.electron,platform:process.platform,arch:process.arch})",
    ],
    {
      env: { ...env, ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: "", NODE_PATH: "" },
      encoding: "utf8",
      timeout: 30000,
    },
  );
  requireSuccess(probe, "PROBE");
  const actual = JSON.parse(probe.stdout.trim());
  if (actual.version !== version || actual.platform !== "darwin" || actual.arch !== arch)
    throw new Error("MACOS_ELECTRON_BINARY_VERSION_MISMATCH");
}

export async function prepareMacElectron({
  repositoryRoot = REPOSITORY_ROOT,
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  run = spawnSync,
} = {}) {
  if (platform !== "darwin") throw new Error("MACOS_ELECTRON_REQUIRES_DARWIN");
  if (arch !== "arm64" && arch !== "x64") throw new Error("MACOS_ELECTRON_ARCH_INVALID");
  // Match electron-builder.yml's electronDist and its native-host architecture.
  const electronRoot = join(repositoryRoot, "node_modules", "electron");
  const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
  const manifest = await readJson(join(repositoryRoot, "package.json"));
  const installed = await readJson(join(electronRoot, "package.json"));
  const version = manifest.devDependencies?.electron;
  if (!/^\d+\.\d+\.\d+$/u.test(version) || installed.version !== version)
    throw new Error("MACOS_ELECTRON_PACKAGE_VERSION_MISMATCH");
  // Electron 42 has no postinstall hook. Keep the official installer's packaged
  // checksum verification, and prevent its Rosetta heuristic changing our target.
  const installEnv = {
    ...env,
    ELECTRON_INSTALL_PLATFORM: "darwin",
    ELECTRON_INSTALL_ARCH: arch,
    npm_config_arch: arch,
    ELECTRON_OVERRIDE_DIST_PATH: "",
    electron_use_remote_checksums: "",
    npm_config_electron_use_remote_checksums: "",
  };
  requireSuccess(
    run(process.execPath, [join(electronRoot, "install.js")], {
      env: installEnv,
      stdio: "inherit",
      timeout: 600000,
    }),
    "INSTALL",
  );
  await inspectMacElectron(electronRoot, version, arch, installEnv, run);
  return Object.freeze({ version, platform: "darwin", arch });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw new Error("MACOS_ELECTRON_ARGS_INVALID");
    console.log("MACOS_ELECTRON_READY " + JSON.stringify(await prepareMacElectron()));
  } catch (error) {
    console.error(
      /^MACOS_ELECTRON_[A-Z_]+$/u.test(error.message)
        ? error.message
        : "MACOS_ELECTRON_PREPARATION_FAILED",
    );
    process.exitCode = 1;
  }
}
