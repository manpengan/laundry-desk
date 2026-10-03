import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import type { DesktopScaleInput } from "@laundry/contracts";
import { WINDOWS_SCALE_SCRIPT } from "./windows-script.js";

const POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
export async function readWindowsScale(input: DesktopScaleInput): Promise<unknown> {
  if (process.platform !== "win32") throw new Error("SCALE_WINDOWS_REQUIRED");
  for (const path of ["C:\\", "C:\\Windows", "C:\\Windows\\System32", POWERSHELL]) {
    if (
      (await lstat(path)).isSymbolicLink() ||
      (await realpath(path)).toLowerCase() !== path.toLowerCase()
    )
      throw new Error("SCALE_SYSTEM_PATH_INVALID");
  }
  return new Promise((resolve, reject) => {
    const child = spawn(
      POWERSHELL,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(WINDOWS_SCALE_SCRIPT, "utf16le").toString("base64"),
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
        },
      },
    );
    let output = "";
    let failed = false;
    const fail = () => {
      failed = true;
      child.kill();
    };
    const timer = setTimeout(fail, 7000);
    child.on("error", fail);
    child.stdin.on("error", fail);
    child.stdout.on("error", fail);
    child.stderr.on("error", fail);
    child.stderr.on("data", fail);
    child.stdout.on("data", (chunk: Buffer) => {
      if (output.length + chunk.length > 16384) {
        fail();
        return;
      }
      output += chunk.toString("utf8");
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (failed || code !== 0) {
        reject(new Error("SCALE_READ_FAILED"));
        return;
      }
      try {
        resolve(JSON.parse(output) as unknown);
      } catch {
        reject(new Error("SCALE_READ_FAILED"));
      }
    });
    child.stdin.end(JSON.stringify(input));
  });
}
