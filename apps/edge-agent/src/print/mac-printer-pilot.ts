import { execFile as nodeExecFile, spawn as nodeSpawn } from "node:child_process";

import { buildPrinterSmokePayload } from "./printer-smoke.js";

const QUEUE_NAME = /^[A-Za-z0-9_.-]{1,128}$/u;
const DEFAULT_TIMEOUT_MS = 10_000;

export type MacPrinterPilotResult = Readonly<{
  ok: boolean;
  mode: "discover" | "validate" | "print";
  queues: readonly string[];
  selected_queue?: string;
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
  ) => Promise<void>;
}>;

const capture = async (file: string, args: readonly string[]): Promise<string> =>
  await new Promise((resolveCapture, rejectCapture) => {
    nodeExecFile(file, [...args], { encoding: "utf8", maxBuffer: 64 * 1024 }, (error, stdout) => {
      if (error !== null) rejectCapture(error);
      else resolveCapture(stdout);
    });
  });

const printBytes = async (
  file: string,
  args: readonly string[],
  bytes: Uint8Array,
  timeoutMs: number,
): Promise<void> =>
  await new Promise((resolvePrint, rejectPrint) => {
    const child = nodeSpawn(file, [...args], { shell: false, stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPrint(new Error("CUPS print timed out"));
    }, timeoutMs);
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
      if (code === 0) resolvePrint();
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
      .filter((queue) => QUEUE_NAME.test(queue))
      .sort(),
  );
}

async function discoverQueues(
  dependencies: MacPrinterPilotDependencies,
): Promise<readonly string[]> {
  if ((dependencies.platform ?? process.platform) !== "darwin") {
    throw new Error("macOS printer pilot requires Darwin");
  }
  const output = await (dependencies.capture ?? capture)("/usr/bin/lpstat", ["-e"]);
  return parseQueues(output);
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
    if (!QUEUE_NAME.test(queue) || !queues.includes(queue)) {
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
    await (dependencies.print ?? printBytes)(
      "/usr/bin/lp",
      ["-d", queue, "-o", "raw"],
      payload,
      input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    return Object.freeze({
      ok: true,
      mode: "print",
      queues,
      selected_queue: queue,
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
