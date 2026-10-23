// Electron 42 no longer downloads its binary in postinstall; it fetches it on first use.
// Packaging reads node_modules/electron/dist directly (electronDist in electron-builder.yml),
// so fetch the binary explicitly before electron-builder runs, and fail with a fixed code
// instead of electron-builder's missing-directory error when it cannot be obtained.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** The same directory electron-builder.yml's electronDist points at, minus "/dist". */
export const ELECTRON_PACKAGE_DIR = resolve(packageRoot, "..", "..", "node_modules", "electron");

/** The installed Electron executable, or null when the binary has not been fetched yet. */
export function electronExecutable(packageDir = ELECTRON_PACKAGE_DIR) {
  const pathFile = join(packageDir, "path.txt");
  if (!existsSync(pathFile)) return null;
  const relativePath = readFileSync(pathFile, "utf8").trim();
  if (relativePath.length === 0) return null;
  const executable = join(packageDir, "dist", relativePath);
  return existsSync(executable) ? executable : null;
}

/** Fetches the Electron binary with the package's own installer when it is missing. */
export function ensureElectronDist({ packageDir = ELECTRON_PACKAGE_DIR, run = spawnSync } = {}) {
  const present = electronExecutable(packageDir);
  if (present !== null) return present;
  const installer = join(packageDir, "install.js");
  if (!existsSync(installer)) throw new Error("ELECTRON_INSTALLER_MISSING");
  const result = run(process.execPath, [installer], { cwd: packageDir, stdio: "inherit" });
  const fetched = electronExecutable(packageDir);
  if (result.status !== 0 || fetched === null) throw new Error("ELECTRON_DIST_UNAVAILABLE");
  return fetched;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(`ELECTRON_DIST_READY ${ensureElectronDist()}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "ELECTRON_DIST_UNAVAILABLE");
    process.exitCode = 1;
  }
}
