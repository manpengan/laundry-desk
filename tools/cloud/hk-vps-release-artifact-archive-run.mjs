// Host-side entry point for retired /opt release trees. Every action, including lists, re-executes
// under the shared release lock and then proves the inherited lock before touching release state.

import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { HK_VPS_CLOUD_TEST as PROFILE } from "./cloud-environment-profile.mjs";
import { assertDataProtectionLockHeld } from "./hk-vps-data-protection-lock.mjs";
import {
  archiveOrphanArtifact,
  archiveRetiredArtifact,
  archiveSupersededRollback,
  listArchivableArtifacts,
  listSupersededRollbacks,
} from "./hk-vps-release-artifact-archive.mjs";
import { CloudReleaseError, REMOTE_RELEASE_LOCK } from "./hk-vps-release-core.mjs";
import { runCloudCommand } from "./hk-vps-release-process.mjs";
import { transitionExists } from "./hk-vps-release-remote-support.mjs";

const NODE = PROFILE.paths.nodeExecutable;
const FLOCK = "/usr/bin/flock";
const LOCK_HELD = "--lock-held";
const ACCEPTING_CODES = Object.freeze(Array.from({ length: 256 }, (_, index) => index));
const COMMAND_ENVIRONMENT = Object.freeze({
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
});

function safeErrorCode(error) {
  if (error instanceof CloudReleaseError) return error.code;
  if (error instanceof Error && /^[A-Z][A-Z0-9_]{2,127}$/u.test(error.message)) {
    return error.message;
  }
  return "CLOUD_RELEASE_ARTIFACT_ARCHIVE_FAILED";
}

export function parseArguments(argv) {
  if (argv.length === 1 && argv[0] === "--list") return Object.freeze({ action: "list" });
  if (argv.length === 1 && argv[0] === "--list-superseded-rollbacks") {
    return Object.freeze({ action: "list-superseded-rollbacks" });
  }
  if (argv.length === 2 && argv[0] === "--archive" && typeof argv[1] === "string") {
    return Object.freeze({ action: "archive", name: argv[1] });
  }
  // Separate subcommands make the orphan and committed-retirement decisions explicit in history.
  if (argv.length === 2 && argv[0] === "--archive-orphan" && typeof argv[1] === "string") {
    return Object.freeze({ action: "archive-orphan", name: argv[1] });
  }
  if (
    argv.length === 2 &&
    argv[0] === "--retire-superseded-rollback" &&
    typeof argv[1] === "string"
  ) {
    return Object.freeze({ action: "retire-superseded-rollback", name: argv[1] });
  }
  throw new CloudReleaseError("CLOUD_RELEASE_ARTIFACT_ARCHIVE_ARGS_INVALID");
}

export function artifactArguments(request) {
  if (request.action === "list") return Object.freeze(["--list"]);
  if (request.action === "list-superseded-rollbacks") {
    return Object.freeze(["--list-superseded-rollbacks"]);
  }
  const flag = Object.freeze({
    archive: "--archive",
    "archive-orphan": "--archive-orphan",
    "retire-superseded-rollback": "--retire-superseded-rollback",
  })[request.action];
  if (flag === undefined || typeof request.name !== "string") {
    throw new CloudReleaseError("CLOUD_RELEASE_ARTIFACT_ARCHIVE_ARGS_INVALID");
  }
  return Object.freeze([flag, request.name]);
}

export function lockedArtifactArguments(scriptPath, request) {
  if (typeof scriptPath !== "string" || !scriptPath.startsWith("/") || scriptPath.includes("\0")) {
    throw new CloudReleaseError("CLOUD_RELEASE_ARTIFACT_ARCHIVE_RUNNER_PATH_INVALID");
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
    ...artifactArguments(request),
  ]);
}

export async function runLockedArtifact(request, dependencies = {}) {
  const scriptPath = dependencies.scriptPath ?? fileURLToPath(import.meta.url);
  return await (dependencies.runCloudCommand ?? runCloudCommand)(
    FLOCK,
    lockedArtifactArguments(scriptPath, request),
    {
      accepting: ACCEPTING_CODES,
      cwd: "/",
      environment: COMMAND_ENVIRONMENT,
      label: "CLOUD_RELEASE_ARTIFACT_ARCHIVE_LOCKED_RUN",
      timeoutMs: 30 * 60_000,
    },
  );
}

const MOVERS = Object.freeze({
  archive: archiveRetiredArtifact,
  "archive-orphan": archiveOrphanArtifact,
  "retire-superseded-rollback": archiveSupersededRollback,
});

function describeBinding(action, result) {
  if (action === "archive-orphan") return `orphan_marker=${result.markerSha}`;
  if (action === "retire-superseded-rollback") {
    return `superseded=${result.candidates.join(",")} retired_marker=${result.markerSha}`;
  }
  return `candidates=${result.candidates.join(",")}`;
}

async function assertNoActiveTransition(dependencies) {
  let active;
  try {
    active = await (dependencies.transitionExists ?? transitionExists)();
  } catch (error) {
    throw new CloudReleaseError("CLOUD_RELEASE_TRANSITION_ACTIVE", { cause: error });
  }
  if (active !== false) throw new CloudReleaseError("CLOUD_RELEASE_TRANSITION_ACTIVE");
}

async function execute(request, write, dependencies) {
  await (dependencies.assertLockHeld ?? assertDataProtectionLockHeld)();
  await assertNoActiveTransition(dependencies);
  if (request.action === "list" || request.action === "list-superseded-rollbacks") {
    const list =
      request.action === "list"
        ? (dependencies.listArtifacts ?? listArchivableArtifacts)
        : (dependencies.listSuperseded ?? listSupersededRollbacks);
    const names = await list();
    const label =
      request.action === "list"
        ? "CLOUD_RELEASE_ARTIFACT_ARCHIVE_LIST"
        : "CLOUD_RELEASE_SUPERSEDED_ROLLBACK_LIST";
    write(`${label} count=${names.length}\n`);
    for (const name of names) write(`  ${name}\n`);
    return;
  }
  const move = dependencies.moveArtifact ?? MOVERS[request.action];
  const result = await move(request.name);
  write(
    `CLOUD_RELEASE_ARTIFACT_ARCHIVE_OK entries=${result.entries} bytes=${result.bytes} ` +
      `ino=${result.ino} ${describeBinding(request.action, result)} target=${result.target}\n`,
  );
}

export async function main(argv, write = (line) => process.stdout.write(line), dependencies = {}) {
  if ((dependencies.processUid ?? process.getuid?.()) !== 0) {
    throw new CloudReleaseError("CLOUD_RELEASE_ARTIFACT_ARCHIVE_ROOT_REQUIRED");
  }
  const lockHeld = argv[0] === LOCK_HELD;
  const request = parseArguments(lockHeld ? argv.slice(1) : argv);
  if (!lockHeld) {
    const result = await (dependencies.runLocked ?? runLockedArtifact)(request, dependencies);
    write(result.stdout);
    (dependencies.stderr ?? process.stderr).write(result.stderr);
    return result.code;
  }
  await execute(request, write, dependencies);
  return 0;
}

export function isDirectEntrypoint(entry, moduleUrl) {
  return entry !== undefined && moduleUrl === pathToFileURL(resolve(entry)).href;
}

if (isDirectEntrypoint(process.argv[1], import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`${safeErrorCode(error)}\n`);
      process.exitCode = 1;
    },
  );
}
