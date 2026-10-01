import { spawn } from "node:child_process";

const MAXIMUM_OUTPUT = 65_536;
const OUTER_TIMEOUT_MS = 1_050_000;

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
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
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
