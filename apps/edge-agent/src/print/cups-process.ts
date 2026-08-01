import { execFile, spawn } from "node:child_process";
import { isAbsolute } from "node:path";

import { isCupsQueueName } from "./cups-queue.js";

const MAX_OUTPUT_BYTES = 2_048;

export type CupsSubmissionOutcome = "failed" | "uncertain";

export class CupsSubmissionError extends Error {
  constructor(
    readonly outcome: CupsSubmissionOutcome,
    message: string,
  ) {
    super(message);
    this.name = "CupsSubmissionError";
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** Parse the stable CUPS queue-number reference and reject ambiguous output. */
export function parseCupsJobReference(queue: string, stdout: string): string {
  if (!isCupsQueueName(queue)) throw new Error("Invalid CUPS queue");
  const pattern = new RegExp(`(?:^|\\s)(${escapeRegex(queue)}-[1-9][0-9]{0,9})(?=\\s|\\(|$)`, "gu");
  const matches = [...stdout.matchAll(pattern)].map((match) => match[1]!);
  const unique = [...new Set(matches)];
  if (unique.length !== 1) {
    throw new CupsSubmissionError("uncertain", "CUPS returned no unique trackable job id");
  }
  return unique[0]!;
}

export async function discoverCupsQueues(): Promise<readonly string[]> {
  return discoverCupsQueuesWithExecutable("/usr/bin/lpstat", 5_000);
}

/** Test seam for a controlled fake `lpstat`; production is fixed and bounded. */
export async function discoverCupsQueuesWithExecutable(
  executable: string,
  timeoutMs = 5_000,
): Promise<readonly string[]> {
  if (!isAbsolute(executable)) throw new Error("CUPS discovery executable must be absolute");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) {
    throw new Error("CUPS discovery timeout must be between 1 and 10000 milliseconds");
  }
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      ["-e"],
      {
        encoding: "utf8",
        maxBuffer: 64 * 1024,
        timeout: timeoutMs,
        killSignal: "SIGKILL",
      },
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
              .filter(isCupsQueueName)
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
  return submitCupsBytesWithExecutable(queue, bytes, "/usr/bin/lp", timeoutMs);
}

/** Test seam for a controlled fake `lp`; production always calls `/usr/bin/lp`. */
export async function submitCupsBytesWithExecutable(
  queue: string,
  bytes: Uint8Array,
  executable: string,
  timeoutMs = 10_000,
): Promise<string> {
  if (!isCupsQueueName(queue)) throw new Error("Invalid CUPS queue");
  if (!isAbsolute(executable)) throw new Error("CUPS executable must be absolute");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error("CUPS timeout must be between 1 and 60000 milliseconds");
  }
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["-d", queue, "-o", "raw"], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let spawned = false;
    let settled = false;
    let spawnError: Error | null = null;
    let stdinError = false;
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    const appendBounded = (
      current: Buffer<ArrayBufferLike>,
      chunk: Buffer<ArrayBufferLike>,
    ): Buffer<ArrayBufferLike> => {
      const remaining = MAX_OUTPUT_BYTES - current.byteLength;
      return remaining <= 0
        ? current
        : Buffer.concat(
            [current, chunk.subarray(0, remaining)],
            current.byteLength + Math.min(remaining, chunk.byteLength),
          );
    };
    const settle = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      operation();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle(() => reject(new CupsSubmissionError("uncertain", "CUPS submission timed out")));
    }, timeoutMs);
    child.once("spawn", () => {
      spawned = true;
    });
    child.stdout.on("data", (chunk: Buffer<ArrayBufferLike>) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer<ArrayBufferLike>) => {
      stderr = appendBounded(stderr, chunk);
    });
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (code, signal) => {
      if (spawnError !== null) {
        const error = spawnError;
        settle(() =>
          reject(
            new CupsSubmissionError(
              spawned ? "uncertain" : "failed",
              spawned ? "CUPS submission outcome is unknown" : error.message,
            ),
          ),
        );
        return;
      }
      if (signal !== null) {
        settle(() =>
          reject(new CupsSubmissionError("uncertain", `CUPS submission terminated by ${signal}`)),
        );
        return;
      }
      if (code !== 0) {
        settle(() =>
          reject(
            new CupsSubmissionError(
              spawned ? "uncertain" : "failed",
              stderr.toString("utf8").trim() || `CUPS submission failed with exit code ${code}`,
            ),
          ),
        );
        return;
      }
      if (stdinError) {
        settle(() =>
          reject(new CupsSubmissionError("uncertain", "CUPS input stream outcome is unknown")),
        );
        return;
      }
      try {
        const job = parseCupsJobReference(queue, stdout.toString("utf8"));
        settle(() => resolve(job));
      } catch (error) {
        settle(() => reject(error));
      }
    });
    child.stdin.once("error", () => {
      stdinError = true;
    });
    child.stdin.end(bytes);
  });
}
