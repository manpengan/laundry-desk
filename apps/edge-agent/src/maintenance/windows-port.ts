import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import type { DesktopMaintenanceInput } from "@laundry/contracts";
import { RUNTIME_MAINTENANCE_BINDING } from "./runtime-binding.js";
import { maintenanceCommand } from "./windows-script.js";
import { maintenanceResponse } from "./windows-response.js";
const POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
export async function runWindowsMaintenance(
  input: DesktopMaintenanceInput,
  authorize: () => boolean,
): Promise<unknown> {
  const binding = RUNTIME_MAINTENANCE_BINDING;
  if (process.platform !== "win32" || binding === null) throw new Error("MAINTENANCE_UNAVAILABLE");
  for (const path of [
    "C:\\",
    "C:\\Windows",
    "C:\\Windows\\System32",
    "C:\\Windows\\System32\\WindowsPowerShell",
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0",
    POWERSHELL,
  ]) {
    if (
      (await lstat(path)).isSymbolicLink() ||
      (await realpath(path)).toLowerCase() !== path.toLowerCase()
    )
      throw new Error("MAINTENANCE_SYSTEM_PATH_INVALID");
  }
  if (!authorize()) throw new Error("MAINTENANCE_SESSION_CHANGED");
  const child = spawn(
    POWERSHELL,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      Buffer.from(maintenanceCommand(binding.trust_script), "utf16le").toString("base64"),
    ],
    {
      shell: false,
      windowsHide: true,
      cwd: "C:\\Windows\\System32",
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        SystemRoot: "C:\\Windows",
        WINDIR: "C:\\Windows",
        PATH: "C:\\Windows\\System32",
        PSModulePath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules",
        ...Object.fromEntries(
          [
            "LOCALAPPDATA",
            "APPDATA",
            "USERPROFILE",
            "USERNAME",
            "USERDOMAIN",
            "TEMP",
            "TMP",
          ].flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]!]])),
        ),
      },
    },
  );
  const response = maintenanceResponse(child, input.operation, authorize);
  child.stdin.end(
    JSON.stringify({
      manifest_sha256: binding.manifest_sha256,
      entry_sha256: binding.entry_sha256,
      entry_size: binding.entry_size,
      input,
    }),
  );
  return response;
}
