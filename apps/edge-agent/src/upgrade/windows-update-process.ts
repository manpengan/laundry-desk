import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { WINDOWS_UPDATE_SCRIPT } from "./windows-update-script.js";

const POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
export type WindowsUpdateRequest = Readonly<{
  currentExe: string;
  targetExe: string;
  zipPath?: string;
  destination?: string;
  verifyOnly?: boolean;
  expectedVersion?: string;
}>;

export async function runWindowsUpdateRequest(request: WindowsUpdateRequest): Promise<void> {
  if (process.platform !== "win32") throw new Error("UPDATE_WINDOWS_REQUIRED");
  for (const path of ["C:\\", "C:\\Windows", "C:\\Windows\\System32", POWERSHELL]) {
    if (
      (await lstat(path)).isSymbolicLink() ||
      (await realpath(path)).toLowerCase() !== path.toLowerCase()
    )
      throw new Error("UPDATE_SYSTEM_PATH_INVALID");
  }
  const input = Buffer.from(JSON.stringify(request), "utf8");
  if (input.length > 8192) throw new Error("UPDATE_INPUT_TOO_LARGE");
  return new Promise((resolve, reject) => {
    const child = spawn(
      POWERSHELL,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(WINDOWS_UPDATE_SCRIPT, "utf16le").toString("base64"),
      ],
      {
        windowsHide: true,
        shell: false,
        cwd: "C:\\Windows\\System32",
        env: {
          SystemRoot: "C:\\Windows",
          WINDIR: "C:\\Windows",
          PATH: "C:\\Windows\\System32",
          PSModulePath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let output = "";
    let failed = false;
    const fail = () => {
      failed = true;
      child.kill();
    };
    const timer = setTimeout(fail, 120_000);
    child.on("error", fail);
    child.stdin.on("error", fail);
    child.stdout.on("error", fail);
    child.stderr.on("error", fail);
    child.stderr.on("data", fail);
    child.stdout.on("data", (chunk: Buffer) => {
      if (output.length + chunk.length > 1024) {
        fail();
        return;
      }
      output += chunk.toString("utf8");
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (failed || code !== 0 || output !== '{"ok":true}')
        reject(new Error("UPDATE_WINDOWS_VERIFICATION_FAILED"));
      else resolve();
    });
    child.stdin.end(input);
  });
}
