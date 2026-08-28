import { spawn } from "node:child_process";

import { HK_VPS_CLOUD_TEST as PROFILE } from "./cloud-environment-profile.mjs";
import { CloudReleaseError, fail } from "./hk-vps-release-core.mjs";

const COMMAND_ENVIRONMENT = Object.freeze({
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
});
const MAXIMUM_STDERR_BYTES = 64 * 1024;
const TIMEOUT_MS = 10 * 60_000;
const TERMINATION_GRACE_MS = 2_000;

function signalGroup(child, signal) {
  if (!Number.isSafeInteger(child.pid) || child.pid <= 1) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}

export function dataProtectionDumpArguments() {
  return Object.freeze([
    "-u",
    "postgres",
    "--",
    "/usr/bin/pg_dump",
    `--dbname=${PROFILE.services.postgresDatabase}`,
    "--format=custom",
    "--lock-wait-timeout=10s",
  ]);
}

export async function runDataProtectionDumpProcess(outputHandle, signal, dependencies = {}) {
  if (!Number.isSafeInteger(outputHandle?.fd) || outputHandle.fd < 0) {
    fail("CLOUD_DATA_DUMP_OUTPUT_INVALID");
  }
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    fail("CLOUD_DATA_DUMP_OUTPUT_INVALID");
  }
  if (signal?.aborted) fail("CLOUD_DATA_DATABASE_DUMP_ABORTED");
  const spawnProcess = dependencies.spawn ?? spawn;
  return await new Promise((resolveDump, rejectDump) => {
    const child = spawnProcess("/usr/bin/sudo", [...dataProtectionDumpArguments()], {
      cwd: "/",
      detached: true,
      env: COMMAND_ENVIRONMENT,
      shell: false,
      stdio: ["ignore", outputHandle.fd, "pipe"],
    });
    let stderrBytes = 0;
    let stopping = false;
    let settled = false;
    let killTimer;
    let timeoutTimer;

    const cleanup = () => {
      clearTimeout(killTimer);
      clearTimeout(timeoutTimer);
      signal?.removeEventListener("abort", abortHandler);
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error === undefined) resolveDump();
      else rejectDump(error);
    };
    const stop = (code) => {
      if (stopping) return;
      stopping = true;
      try {
        signalGroup(child, "SIGTERM");
      } catch {
        // The bounded SIGKILL remains authoritative.
      }
      killTimer = setTimeout(() => {
        try {
          signalGroup(child, "SIGKILL");
        } finally {
          finish(new CloudReleaseError(code));
        }
      }, TERMINATION_GRACE_MS);
    };
    const abortHandler = () => stop("CLOUD_DATA_DATABASE_DUMP_ABORTED");

    timeoutTimer = setTimeout(() => stop("CLOUD_DATA_DATABASE_DUMP_TIMEOUT"), TIMEOUT_MS);
    signal?.addEventListener("abort", abortHandler, { once: true });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > MAXIMUM_STDERR_BYTES) stop("CLOUD_DATA_DATABASE_DUMP_OUTPUT_TOO_LARGE");
    });
    child.once("error", () => finish(new CloudReleaseError("CLOUD_DATA_DATABASE_DUMP_FAILED")));
    child.once("close", (code, closeSignal) => {
      if (stopping) return;
      if (code !== 0 || closeSignal !== null) {
        finish(new CloudReleaseError("CLOUD_DATA_DATABASE_DUMP_FAILED"));
        return;
      }
      finish();
    });
  });
}
