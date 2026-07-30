import { execFile, spawn } from "node:child_process";

const QUEUE_NAME = /^[A-Za-z0-9_.-]{1,128}$/u;
const JOB_ID = /[A-Za-z0-9_.-]+-\d+/gu;

export async function discoverCupsQueues(): Promise<readonly string[]> {
  return new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/lpstat",
      ["-e"],
      { encoding: "utf8", maxBuffer: 64 * 1024 },
      (error, out) => {
        if (error !== null) {
          reject(error);
          return;
        }
        resolve(
          Object.freeze(
            [
              ...new Set(
                out
                  .split(/\r?\n/u)
                  .map((line) => line.trim())
                  .filter(Boolean),
              ),
            ]
              .filter((queue) => QUEUE_NAME.test(queue))
              .sort(),
          ),
        );
      },
    );
  });
}

export async function submitCupsBytes(
  queue: string,
  bytes: Uint8Array,
  timeoutMs = 10_000,
): Promise<string> {
  if (!QUEUE_NAME.test(queue)) throw new Error("Invalid CUPS queue");
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/lp", ["-d", queue, "-o", "raw"], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("CUPS submission timed out"));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < 2_048) stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 2_048) stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim() || "CUPS submission failed"));
        return;
      }
      const job = (stdout.match(JOB_ID) ?? []).find((candidate) =>
        candidate.startsWith(`${queue}-`),
      );
      if (job === undefined) {
        reject(new Error("CUPS returned no trackable job id"));
        return;
      }
      resolve(job);
    });
    child.stdin.end(bytes);
  });
}
