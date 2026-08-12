import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";

import {
  runDataProtectionBackup,
  runDataProtectionDrill,
} from "./hk-vps-data-protection-backup.mjs";
import { requireDataProtectionSetId } from "./hk-vps-data-protection-contract.mjs";
import { runDataProtectionOffsite } from "./hk-vps-data-protection-offsite.mjs";
import {
  readDataProtectionRecoveryInput,
  runDataProtectionRecovery,
} from "./hk-vps-data-protection-recovery.mjs";
import {
  formatDataProtectionPrometheus,
  runDataProtectionStatus,
} from "./hk-vps-data-protection-status.mjs";
import { assertDataProtectionLockHeld } from "./hk-vps-data-protection-lock.mjs";
import { CloudReleaseError, REMOTE_RELEASE_LOCK, fail } from "./hk-vps-release-core.mjs";
import { runCloudCommand, withCloudSignalCancellation } from "./hk-vps-release-process.mjs";

const NODE = "/opt/nodejs/bin/node";
const FLOCK = "/usr/bin/flock";
const LOCK_HELD = "--lock-held";
const COMMAND_ENVIRONMENT = Object.freeze({
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
});
const ACCEPTING_CODES = Object.freeze(Array.from({ length: 256 }, (_, index) => index));

function parseSetId(arguments_, index, current) {
  if (current !== null || arguments_[index + 1] === undefined) {
    fail("CLOUD_DATA_ARGS_INVALID");
  }
  try {
    return requireDataProtectionSetId(arguments_[index + 1]);
  } catch {
    fail("CLOUD_DATA_ARGS_INVALID");
  }
}

export function parseDataProtectionArguments(arguments_) {
  if (
    !Array.isArray(arguments_) ||
    arguments_.length < 1 ||
    arguments_.length > 4 ||
    arguments_.some((value) => typeof value !== "string" || value.includes("\0"))
  ) {
    fail("CLOUD_DATA_ARGS_INVALID");
  }
  const [action, ...rest] = arguments_;
  if (!new Set(["backup", "drill", "offsite", "recover", "status"]).has(action)) {
    fail("CLOUD_DATA_ARGS_INVALID");
  }
  let format = "json";
  let scheduled = false;
  let setId = null;
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (value === "--scheduled" && action === "backup" && !scheduled) {
      scheduled = true;
    } else if (value === "--set-id" && ["drill", "offsite", "recover"].includes(action)) {
      setId = parseSetId(rest, index, setId);
      index += 1;
    } else if (value === "--format" && action === "status" && rest[index + 1] !== undefined) {
      format = rest[index + 1];
      if (!new Set(["json", "prometheus"]).has(format)) fail("CLOUD_DATA_ARGS_INVALID");
      index += 1;
    } else {
      fail("CLOUD_DATA_ARGS_INVALID");
    }
  }
  if (action === "recover" && setId === null) fail("CLOUD_DATA_ARGS_INVALID");
  return Object.freeze({ action, format, scheduled, setId });
}

export function dataProtectionArguments(options) {
  if (options.action === "backup") {
    return Object.freeze(options.scheduled ? ["backup", "--scheduled"] : ["backup"]);
  }
  if (["drill", "offsite", "recover"].includes(options.action)) {
    return Object.freeze(
      options.setId === null ? [options.action] : [options.action, "--set-id", options.setId],
    );
  }
  return Object.freeze(
    options.format === "json" ? ["status"] : ["status", "--format", options.format],
  );
}

function success(action, result) {
  return `${JSON.stringify({ ok: true, action, result })}\n`;
}

export async function executeDataProtectionAction(options, signal, dependencies = {}) {
  if (options.action === "backup") {
    const result = await (dependencies.runBackup ?? runDataProtectionBackup)(
      { kind: options.scheduled ? "scheduled" : "manual", signal },
      dependencies.backupDependencies,
    );
    return Object.freeze({ exitCode: 0, output: success(options.action, result) });
  }
  if (options.action === "drill") {
    const result = await (dependencies.runDrill ?? runDataProtectionDrill)(
      { setId: options.setId ?? undefined, signal },
      dependencies.drillDependencies,
    );
    return Object.freeze({ exitCode: 0, output: success(options.action, result) });
  }
  if (options.action === "offsite") {
    const result = await (dependencies.runOffsite ?? runDataProtectionOffsite)(
      { setId: options.setId ?? undefined, signal },
      dependencies.offsiteDependencies,
    );
    return Object.freeze({ exitCode: 0, output: success(options.action, result) });
  }
  if (options.action === "recover") {
    const result = await (dependencies.runRecovery ?? runDataProtectionRecovery)(
      { setId: options.setId, confirmation: options.confirmation, signal },
      dependencies.recoveryDependencies,
    );
    return Object.freeze({ exitCode: 0, output: success(options.action, result) });
  }
  const report = await (dependencies.runStatus ?? runDataProtectionStatus)(
    { signal },
    dependencies.statusDependencies,
  );
  const output =
    options.format === "prometheus"
      ? formatDataProtectionPrometheus(report)
      : `${JSON.stringify(report)}\n`;
  return Object.freeze({ exitCode: report.healthy ? 0 : 1, output });
}

export function lockedDataProtectionArguments(scriptPath, options) {
  if (typeof scriptPath !== "string" || !scriptPath.startsWith("/") || scriptPath.includes("\0")) {
    fail("CLOUD_DATA_RUNNER_PATH_INVALID");
  }
  return Object.freeze([
    "--no-fork",
    "--exclusive",
    "--nonblock",
    "--conflict-exit-code",
    "73",
    REMOTE_RELEASE_LOCK,
    NODE,
    scriptPath,
    LOCK_HELD,
    ...dataProtectionArguments(options),
  ]);
}

export async function runLockedDataProtection(options, input = {}) {
  const scriptPath = input.scriptPath ?? fileURLToPath(import.meta.url);
  return await (input.runCloudCommand ?? runCloudCommand)(
    FLOCK,
    lockedDataProtectionArguments(scriptPath, options),
    {
      accepting: ACCEPTING_CODES,
      cwd: "/",
      environment: COMMAND_ENVIRONMENT,
      label: "CLOUD_DATA_LOCKED_RUN",
      input: input.input ?? "",
      signal: input.signal,
      timeoutMs: 30 * 60_000,
    },
  );
}

export async function main(arguments_ = process.argv.slice(2), dependencies = {}) {
  if ((dependencies.uid ?? process.getuid?.()) !== 0) fail("CLOUD_DATA_ROOT_REQUIRED");
  const lockHeld = arguments_[0] === LOCK_HELD;
  const options = parseDataProtectionArguments(lockHeld ? arguments_.slice(1) : arguments_);
  if (!lockHeld) {
    const input =
      options.action === "recover"
        ? await (dependencies.readRecoveryInput ?? readDataProtectionRecoveryInput)(
            dependencies.stdin ?? process.stdin,
          )
        : "";
    const result = await (dependencies.runLocked ?? runLockedDataProtection)(options, {
      ...dependencies,
      input,
    });
    (dependencies.stdout ?? process.stdout).write(result.stdout);
    (dependencies.stderr ?? process.stderr).write(result.stderr);
    return result.code;
  }
  await (dependencies.assertLockHeld ?? assertDataProtectionLockHeld)();
  return await withCloudSignalCancellation(async (signal) => {
    const actionOptions =
      options.action === "recover"
        ? Object.freeze({
            ...options,
            confirmation: await (dependencies.readRecoveryInput ?? readDataProtectionRecoveryInput)(
              dependencies.stdin ?? process.stdin,
            ),
          })
        : options;
    const result = await executeDataProtectionAction(actionOptions, signal, dependencies);
    (dependencies.stdout ?? process.stdout).write(result.output);
    return result.exitCode;
  }, dependencies.processObject);
}

export function isDirectEntrypoint(entry, moduleUrl) {
  return entry !== undefined && moduleUrl === pathToFileURL(resolve(entry)).href;
}

if (isDirectEntrypoint(process.argv[1], import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      const code = error instanceof CloudReleaseError ? error.code : "CLOUD_DATA_FAILED";
      process.stderr.write(`${code}\n`);
      process.exitCode = 1;
    });
}
