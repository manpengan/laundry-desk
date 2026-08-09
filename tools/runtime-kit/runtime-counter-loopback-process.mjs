import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { isAbsolute } from "node:path";

import { fail } from "./runtime-counter-loopback-core.mjs";

export const DEFAULT_COMMAND_TIMEOUT_MS = 2 * 60_000;
export const BUILD_COMMAND_TIMEOUT_MS = 20 * 60_000;
export const MAXIMUM_COMMAND_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAXIMUM_TIMEOUT_MS = 30 * 60_000;
const TERMINATION_GRACE_MS = 2_000;
const MAXIMUM_INPUT_BYTES = 4_096;
const ORCHESTRATOR_SIGNALS = Object.freeze(["SIGINT", "SIGTERM", "SIGHUP"]);

function validateSpec(file, arguments_, options) {
  if (
    typeof file !== "string" ||
    !isAbsolute(file) ||
    !Array.isArray(arguments_) ||
    arguments_.length > 256 ||
    arguments_.some((argument) => typeof argument !== "string" || argument.includes("\0")) ||
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs <= 0 ||
    options.timeoutMs > MAXIMUM_TIMEOUT_MS ||
    !Number.isSafeInteger(options.maximumOutputBytes) ||
    options.maximumOutputBytes <= 0 ||
    options.maximumOutputBytes > MAXIMUM_COMMAND_OUTPUT_BYTES ||
    !/^[A-Z][A-Z0-9_]{1,63}$/u.test(options.label) ||
    typeof options.environment !== "object" ||
    options.environment === null ||
    Array.isArray(options.environment) ||
    typeof options.input !== "string" ||
    (options.signal !== undefined && !(options.signal instanceof AbortSignal))
  ) {
    fail("RUNTIME_COUNTER_COMMAND_INVALID");
  }
  const inputBytes = Buffer.byteLength(options.input);
  if (inputBytes > MAXIMUM_INPUT_BYTES) fail("RUNTIME_COUNTER_COMMAND_INPUT_TOO_LARGE");
  for (const [name, value] of Object.entries(options.environment)) {
    if (!/^[A-Z_][A-Z0-9_]*$/u.test(name) || typeof value !== "string" || value.includes("\0")) {
      fail("RUNTIME_COUNTER_COMMAND_INVALID");
    }
  }
}

export async function runWithProcessSignalCancellation(operation, processObject = process) {
  if (
    typeof operation !== "function" ||
    typeof processObject?.on !== "function" ||
    typeof processObject?.off !== "function"
  ) {
    fail("RUNTIME_COUNTER_ORCHESTRATOR_INVALID");
  }
  const controller = new AbortController();
  let receivedSignal = null;
  const handlers = new Map(
    ORCHESTRATOR_SIGNALS.map((signal) => [
      signal,
      () => {
        if (receivedSignal !== null) return;
        receivedSignal = signal;
        controller.abort(new Error(`RUNTIME_COUNTER_INTERRUPTED_${signal}`));
      },
    ]),
  );
  for (const [signal, handler] of handlers) processObject.on(signal, handler);
  try {
    const result = await operation(controller.signal);
    if (receivedSignal !== null) fail(`RUNTIME_COUNTER_INTERRUPTED_${receivedSignal}`);
    return result;
  } finally {
    for (const [signal, handler] of handlers) processObject.off(signal, handler);
  }
}

function signalProcessGroup(child, signal) {
  const processId = child.pid;
  if (processId === undefined) return;
  try {
    process.kill(-processId, signal);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}

export function runBoundedCommand(file, arguments_, inputOptions = {}) {
  const accepting = inputOptions.accepting ?? [0];
  const options = Object.freeze({
    accepting: Array.isArray(accepting) ? Object.freeze([...accepting]) : accepting,
    cwd: inputOptions.cwd,
    environment: Object.freeze({ ...(inputOptions.environment ?? {}) }),
    input: inputOptions.input ?? "",
    label: inputOptions.label ?? "RUNTIME_COUNTER_COMMAND",
    maximumOutputBytes: inputOptions.maximumOutputBytes ?? MAXIMUM_COMMAND_OUTPUT_BYTES,
    signal: inputOptions.signal,
    timeoutMs: inputOptions.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
  });
  validateSpec(file, arguments_, options);
  if (
    !Array.isArray(options.accepting) ||
    options.accepting.length === 0 ||
    options.accepting.some((code) => !Number.isInteger(code) || code < 0 || code > 255)
  ) {
    fail("RUNTIME_COUNTER_COMMAND_INVALID");
  }
  if (options.signal?.aborted) {
    return Promise.reject(new Error(`${options.label}_ABORTED`));
  }

  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(file, [...arguments_], {
      cwd: options.cwd,
      detached: true,
      env: options.environment,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let capturedBytes = 0;
    let stopReason = null;
    let settled = false;
    let killTimer;
    let timeoutTimer;
    const abortHandler = () => stop("ABORTED");

    const cleanup = () => {
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", abortHandler);
    };
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error === undefined) resolveRun(result);
      else rejectRun(error);
    };
    const stop = (reason) => {
      if (stopReason !== null) return;
      stopReason = reason;
      try {
        signalProcessGroup(child, "SIGTERM");
      } catch {
        // The bounded SIGKILL timer still settles with the stable reason.
      }
      killTimer = setTimeout(() => {
        try {
          signalProcessGroup(child, "SIGKILL");
        } catch {
          // The stable stop reason remains authoritative.
        } finally {
          finish(new Error(`${options.label}_${reason}`));
        }
      }, TERMINATION_GRACE_MS);
    };
    const capture = (target) => (chunk) => {
      if (stopReason !== null) return;
      capturedBytes += chunk.byteLength;
      if (capturedBytes > options.maximumOutputBytes) {
        stop("OUTPUT_TOO_LARGE");
        return;
      }
      target.push(chunk);
    };
    timeoutTimer = setTimeout(() => stop("TIMEOUT"), options.timeoutMs);
    options.signal?.addEventListener("abort", abortHandler, { once: true });
    if (options.signal?.aborted) abortHandler();
    child.stdout.on("data", capture(stdout));
    child.stderr.on("data", capture(stderr));
    child.stdin.on("error", () => undefined);
    child.once("error", () => finish(new Error(`${options.label}_FAILED`)));
    child.once("close", (code, closeSignal) => {
      if (stopReason !== null) return;
      if (closeSignal !== null || code === null) {
        finish(new Error(`${options.label}_FAILED`));
        return;
      }
      const result = Object.freeze({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
      if (!options.accepting.includes(result.code)) {
        finish(new Error(`${options.label}_FAILED`));
        return;
      }
      finish(undefined, result);
    });
    child.stdin.end(options.input);
  });
}
