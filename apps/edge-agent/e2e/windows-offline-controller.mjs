import { spawn } from "node:child_process";

const MAXIMUM_OUTPUT = 65_536;
const OUTER_TIMEOUT_MS = 1_050_000;
// The script embeds the entry's trust implementation and does not fit the Windows command-line limit once
// UTF-16 base64 encoded (about 34,800 characters against 32,767), so PowerShell never started. Only this fixed
// loader goes on the command line; the script follows on stdin as base64 UTF-8.
const LOADER =
  "$ProgressPreference='SilentlyContinue'; & ([scriptblock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()))))";

/** @param {string} script @param {string} powershell @param {Readonly<Record<string, string>>} environment */
export async function boundedController(script, powershell, environment) {
  const child = spawn(
    powershell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      Buffer.from(LOADER, "utf16le").toString("base64"),
    ],
    { env: environment, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
  );
  child.stdin.on("error", () => {
    /* A wrapper that exits early is reported through close. */
  });
  child.stdin.end(Buffer.from(script, "utf8").toString("base64"));
  return await new Promise((resolveOutput, reject) => {
    /** @type {readonly Buffer[]} */
    let output = [];
    let length = 0;
    let failed = false;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let cleanupTimer;
    const stop = () => {
      failed = true;
      if (cleanupTimer !== undefined) return;
      cleanupTimer = setTimeout(
        () => reject(new Error("WINDOWS_OFFLINE_CONTROLLER_UNCONFIRMED")),
        10_000,
      );
      // Only this directly owned wrapper. Its controller descendants are deliberately not claimed stopped.
      try {
        child.kill();
      } catch {
        /* A missing close event is reported as unconfirmed by the timer. */
      }
    };
    const timer = setTimeout(stop, OUTER_TIMEOUT_MS);
    child.stdout.on("data", (/** @type {Buffer} */ chunk) => {
      length += chunk.length;
      if (length > MAXIMUM_OUTPUT) stop();
      else output = [...output, chunk];
    });
    let errorLength = 0;
    child.stderr.on("data", (/** @type {Buffer} */ chunk) => {
      errorLength += chunk.length;
      if (errorLength > MAXIMUM_OUTPUT) stop();
    });
    child.once("error", stop);
    // close confirms the exact ChildProcess exited and both redirected streams closed.
    child.once("close", (code) => {
      clearTimeout(timer);
      clearTimeout(cleanupTimer);
      if (failed || code !== 0 || errorLength !== 0)
        reject(new Error("WINDOWS_OFFLINE_CONTROLLER_UNCONFIRMED"));
      else resolveOutput(Buffer.concat(output).toString("utf8").trim());
    });
  });
}
