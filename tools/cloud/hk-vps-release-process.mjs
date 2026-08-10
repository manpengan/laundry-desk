import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";

import { CloudReleaseError, HK_VPS_ALIAS, fail } from "./hk-vps-release-core.mjs";
import { parseSafeRemoteReleaseErrorCode } from "./hk-vps-release-remote-error-contract.mjs";

const MAXIMUM_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAXIMUM_INPUT_BYTES = 64 * 1024;
const MAXIMUM_TIMEOUT_MS = 30 * 60_000;
const TERMINATION_GRACE_MS = 2_000;
const SIGNALS = Object.freeze(["SIGINT", "SIGTERM", "SIGHUP"]);
const SSH = "/usr/bin/ssh";
const PINNED_SSH_RELEASE_LABELS = new Set([
  "CLOUD_RELEASE_REMOTE_API_EVIDENCE",
  "CLOUD_RELEASE_REMOTE_DEPLOY",
  "CLOUD_RELEASE_REMOTE_FINALIZE",
  "CLOUD_RELEASE_REMOTE_ROLLBACK",
]);
const PINNED_SSH_ARGUMENTS = Object.freeze([
  "-o",
  "BatchMode=yes",
  "-o",
  "PasswordAuthentication=no",
  "-o",
  "KbdInteractiveAuthentication=no",
  "-o",
  "IdentitiesOnly=yes",
  "-o",
  "StrictHostKeyChecking=yes",
  "-o",
  null,
  "-o",
  "GlobalKnownHostsFile=/dev/null",
  "-o",
  "HostKeyAlgorithms=ssh-ed25519",
  HK_VPS_ALIAS,
]);

function assertPinnedSshReleaseCommand(file, arguments_, label) {
  const knownHostsOption = arguments_[11];
  const knownHosts =
    typeof knownHostsOption === "string" && knownHostsOption.startsWith("UserKnownHostsFile=")
      ? knownHostsOption.slice("UserKnownHostsFile=".length)
      : null;
  const matches = PINNED_SSH_ARGUMENTS.every(
    (argument, index) => argument === null || arguments_[index] === argument,
  );
  if (
    file !== SSH ||
    !PINNED_SSH_RELEASE_LABELS.has(label) ||
    arguments_.length <= PINNED_SSH_ARGUMENTS.length ||
    !matches ||
    typeof knownHosts !== "string" ||
    !isAbsolute(knownHosts) ||
    knownHosts.includes("\0")
  ) {
    fail("CLOUD_RELEASE_COMMAND_INVALID");
  }
}

function validateCommand(file, arguments_, options) {
  if (
    typeof file !== "string" ||
    !isAbsolute(file) ||
    !Array.isArray(arguments_) ||
    arguments_.length > 256 ||
    arguments_.some((argument) => typeof argument !== "string" || argument.includes("\0")) ||
    typeof options.cwd !== "string" ||
    !isAbsolute(options.cwd) ||
    !/^[A-Z][A-Z0-9_]{2,63}$/u.test(options.label) ||
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs < 1 ||
    options.timeoutMs > MAXIMUM_TIMEOUT_MS ||
    !Number.isSafeInteger(options.maximumOutputBytes) ||
    options.maximumOutputBytes < 1 ||
    options.maximumOutputBytes > MAXIMUM_OUTPUT_BYTES ||
    typeof options.input !== "string" ||
    Buffer.byteLength(options.input) > MAXIMUM_INPUT_BYTES ||
    (options.signal !== undefined && !(options.signal instanceof AbortSignal))
  ) {
    fail("CLOUD_RELEASE_COMMAND_INVALID");
  }
  if (
    typeof options.environment !== "object" ||
    options.environment === null ||
    Array.isArray(options.environment)
  ) {
    fail("CLOUD_RELEASE_COMMAND_INVALID");
  }
  for (const [name, value] of Object.entries(options.environment)) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) ||
      typeof value !== "string" ||
      value.includes("\0")
    ) {
      fail("CLOUD_RELEASE_COMMAND_INVALID");
    }
  }
}

function signalGroup(child, signal) {
  if (!Number.isSafeInteger(child.pid) || child.pid <= 1) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}

function runCommand(file, arguments_, inputOptions, preserveRemoteFailure) {
  const options = Object.freeze({
    accepting: Object.freeze([...(inputOptions.accepting ?? [0])]),
    cwd: inputOptions.cwd ?? "/",
    environment: Object.freeze({ ...(inputOptions.environment ?? {}) }),
    input: inputOptions.input ?? "",
    label: inputOptions.label ?? "CLOUD_RELEASE_COMMAND",
    maximumOutputBytes: inputOptions.maximumOutputBytes ?? MAXIMUM_OUTPUT_BYTES,
    signal: inputOptions.signal,
    timeoutMs: inputOptions.timeoutMs ?? 2 * 60_000,
  });
  validateCommand(file, arguments_, options);
  if (
    options.accepting.length < 1 ||
    options.accepting.some((code) => !Number.isInteger(code) || code < 0 || code > 255)
  ) {
    fail("CLOUD_RELEASE_COMMAND_INVALID");
  }
  if (options.signal?.aborted) fail(`${options.label}_ABORTED`);

  return new Promise((resolveCommand, rejectCommand) => {
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

    const cleanup = () => {
      clearTimeout(killTimer);
      clearTimeout(timeoutTimer);
      options.signal?.removeEventListener("abort", abortHandler);
    };
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error === undefined) resolveCommand(result);
      else rejectCommand(error);
    };
    const stop = (reason) => {
      if (stopReason !== null) return;
      stopReason = reason;
      try {
        signalGroup(child, "SIGTERM");
      } catch {
        // The bounded SIGKILL remains authoritative.
      }
      killTimer = setTimeout(() => {
        try {
          signalGroup(child, "SIGKILL");
        } finally {
          finish(new CloudReleaseError(`${options.label}_${reason}`));
        }
      }, TERMINATION_GRACE_MS);
    };
    const abortHandler = () => stop("ABORTED");
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
    child.once("error", () => finish(new CloudReleaseError(`${options.label}_FAILED`)));
    child.once("close", (code, closeSignal) => {
      if (stopReason !== null) return;
      if (code === null || closeSignal !== null || !options.accepting.includes(code)) {
        const remoteCode =
          preserveRemoteFailure && code !== null && closeSignal === null
            ? parseSafeRemoteReleaseErrorCode(
                Buffer.concat(stdout).toString("utf8"),
                Buffer.concat(stderr).toString("utf8"),
              )
            : null;
        finish(new CloudReleaseError(remoteCode ?? `${options.label}_FAILED`));
        return;
      }
      finish(
        undefined,
        Object.freeze({
          code,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        }),
      );
    });
    child.stdin.end(options.input);
  });
}

export function runCloudCommand(file, arguments_, inputOptions = {}) {
  return runCommand(file, arguments_, inputOptions, false);
}

export function runPinnedSshReleaseCommand(file, arguments_, inputOptions = {}) {
  assertPinnedSshReleaseCommand(file, arguments_, inputOptions.label);
  return runCommand(file, arguments_, inputOptions, true);
}

export async function withCloudSignalCancellation(operation, processObject = process) {
  if (typeof operation !== "function") fail("CLOUD_RELEASE_ORCHESTRATOR_INVALID");
  const controller = new AbortController();
  let received = null;
  const handlers = new Map(
    SIGNALS.map((signal) => [
      signal,
      () => {
        if (received !== null) return;
        received = signal;
        controller.abort(new Error(`CLOUD_RELEASE_INTERRUPTED_${signal}`));
      },
    ]),
  );
  for (const [signal, handler] of handlers) processObject.on(signal, handler);
  try {
    const result = await operation(controller.signal);
    if (received !== null) fail(`CLOUD_RELEASE_INTERRUPTED_${received}`);
    return result;
  } finally {
    for (const [signal, handler] of handlers) processObject.off(signal, handler);
  }
}
