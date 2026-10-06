import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import type { DesktopMaintenanceInput } from "@laundry/contracts";
import { RUNTIME_MAINTENANCE_BINDING } from "./runtime-binding.js";
import { maintenanceCommand } from "./windows-script.js";
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
  return new Promise((resolve, reject) => {
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
    let output = "",
      settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      reject(new Error("MAINTENANCE_START_FAILED"));
    };
    const timer = setTimeout(fail, 30_000);
    child.on("error", fail);
    child.stdin.on("error", fail);
    child.stdout.on("error", fail);
    child.stderr.on("error", fail);
    child.stderr.on("data", fail);
    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      output += chunk.toString("utf8");
      if (output.length > 32768) {
        fail();
        return;
      }
      if (input.operation !== "health" && output.includes("\n")) {
        try {
          const value: unknown = JSON.parse(output.trim());
          if (!authorize()) {
            fail();
            return;
          }
          settled = true;
          clearTimeout(timer);
          child.unref();
          resolve(value);
        } catch {
          fail();
        }
      }
    });
    child.once("close", (code) => {
      if (settled) return;
      if (code !== 0 || !authorize()) {
        fail();
        return;
      }
      try {
        const value: unknown = JSON.parse(output.trim());
        settled = true;
        clearTimeout(timer);
        resolve(value);
      } catch {
        fail();
      }
    });
    child.stdin.end(
      JSON.stringify({
        manifest_sha256: binding.manifest_sha256,
        entry_sha256: binding.entry_sha256,
        entry_size: binding.entry_size,
        input,
      }),
    );
  });
}
