import { spawn as nodeSpawn } from "node:child_process";
import { createHash } from "node:crypto";

import { isCupsQueueName } from "./cups-queue.js";
import { discoverCupsQueues, parseCupsJobReference } from "./cups-process.js";
import { buildPrinterSmokePayload } from "./printer-smoke.js";

const DEFAULT_TIMEOUT_MS = 10_000;

export type MacPrinterPilotResult = Readonly<{
  ok: boolean;
  mode: "discover" | "validate" | "print";
  queues: readonly string[];
  selected_queue?: string;
  cups_job_id?: string;
  payload_sha256?: string;
  bytes_written?: number;
  message: string;
}>;

export type MacPrinterPilotDependencies = Readonly<{
  platform?: NodeJS.Platform;
  capture?: (file: string, args: readonly string[]) => Promise<string>;
  print?: (
    file: string,
    args: readonly string[],
    bytes: Uint8Array,
    timeoutMs: number,
  ) => Promise<string>;
}>;

const printBytes = async (
  file: string,
  args: readonly string[],
  bytes: Uint8Array,
  timeoutMs: number,
): Promise<string> =>
  await new Promise((resolvePrint, rejectPrint) => {
    const child = nodeSpawn(file, [...args], { shell: false, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPrint(new Error("CUPS print timed out"));
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
      rejectPrint(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePrint(stdout);
      else rejectPrint(new Error(stderr.trim() || "CUPS print failed"));
    });
    child.stdin.end(bytes);
  });

function parseQueues(output: string): readonly string[] {
  return Object.freeze(
    [
      ...new Set(
        output
          .split(/\r?\n/u)
          .map((line) => line.trim())
          .filter(Boolean),
      ),
    ]
      .filter(isCupsQueueName)
      .sort(),
  );
}

function parseCupsJobId(output: string, queue: string): string | null {
  try {
    return parseCupsJobReference(queue, output);
  } catch {
    return null;
  }
}

async function discoverQueues(
  dependencies: MacPrinterPilotDependencies,
): Promise<readonly string[]> {
  if ((dependencies.platform ?? process.platform) !== "darwin") {
    throw new Error("macOS printer pilot requires Darwin");
  }
  if (dependencies.capture !== undefined) {
    return parseQueues(await dependencies.capture("/usr/bin/lpstat", ["-e"]));
  }
  return await discoverCupsQueues();
}

export async function runMacPrinterPilot(
  input: Readonly<{
    mode: "discover" | "validate" | "print";
    queue?: string;
    timeoutMs?: number;
  }>,
  dependencies: MacPrinterPilotDependencies = {},
): Promise<MacPrinterPilotResult> {
  try {
    const queues = await discoverQueues(dependencies);
    if (input.mode === "discover") {
      return Object.freeze({
        ok: true,
        mode: "discover",
        queues,
        message: queues.length === 0 ? "No CUPS printer queues found" : "CUPS queues discovered",
      });
    }
    const queue = input.queue?.trim() ?? "";
    if (!isCupsQueueName(queue) || !queues.includes(queue)) {
      return Object.freeze({
        ok: false,
        mode: input.mode,
        queues,
        message: "Selected CUPS queue is not installed",
      });
    }
    if (input.mode === "validate") {
      return Object.freeze({
        ok: true,
        mode: "validate",
        queues,
        selected_queue: queue,
        message: "Installed CUPS queue validated; no bytes written",
      });
    }
    const payload = buildPrinterSmokePayload("LAUNDRY macOS CUPS pilot OK");
    const output = await (dependencies.print ?? printBytes)(
      "/usr/bin/lp",
      ["-d", queue, "-o", "raw"],
      payload,
      input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    const cupsJobId = parseCupsJobId(output, queue);
    if (cupsJobId === null) {
      return Object.freeze({
        ok: false,
        mode: "print",
        queues,
        selected_queue: queue,
        message: "CUPS accepted bytes without a trackable job id",
      });
    }
    return Object.freeze({
      ok: true,
      mode: "print",
      queues,
      selected_queue: queue,
      cups_job_id: cupsJobId,
      payload_sha256: createHash("sha256").update(payload).digest("hex"),
      bytes_written: payload.byteLength,
      message: "Raw ESC/POS pilot submitted to CUPS",
    });
  } catch {
    return Object.freeze({
      ok: false,
      mode: input.mode,
      queues: Object.freeze([]),
      message: "macOS printer discovery or submission failed",
    });
  }
}
