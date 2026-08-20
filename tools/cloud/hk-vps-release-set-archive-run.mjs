// Root-only hk-vps entry point for manifest-bound release-set archive and restore. The public CLI
// never accepts or prints the raw release token; identity is candidate SHA + token SHA-256 + outcome.

import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  archiveReleaseSet,
  listArchivableReleaseSets,
  restoreReleaseSet,
} from "./hk-vps-release-set-archive.mjs";
import { CloudReleaseError, REMOTE_RELEASE_LOCK, fail } from "./hk-vps-release-core.mjs";
import { runCloudCommand } from "./hk-vps-release-process.mjs";
import {
  assertReadonlyReleasePreflight,
  formatReadonlyReleaseSnapshot,
  readReadonlyReleaseSnapshot,
} from "./hk-vps-release-readonly-preflight.mjs";

const NODE = "/opt/nodejs/bin/node";
const FLOCK = "/usr/bin/flock";
const LOCK_HELD = "--lock-held";
const SHA = /^[0-9a-f]{40}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const OUTCOMES = new Set(["committed", "rolled_back"]);
const IDENTITYLESS_ACTIONS = new Set(["inventory", "list", "preflight"]);
const ACCEPTING_CODES = Object.freeze(Array.from({ length: 256 }, (_, index) => index));
const COMMAND_ENVIRONMENT = Object.freeze({
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
});

function requireIdentity(candidateSha, tokenSha256, outcome) {
  if (!SHA.test(candidateSha) || !DIGEST.test(tokenSha256) || !OUTCOMES.has(outcome)) {
    fail("CLOUD_RELEASE_SET_ARGS_INVALID");
  }
  return Object.freeze({ candidateSha, outcome, tokenSha256 });
}

export function parseReleaseSetArguments(arguments_) {
  if (
    !Array.isArray(arguments_) ||
    arguments_.some((value) => typeof value !== "string" || value.includes("\0"))
  ) {
    fail("CLOUD_RELEASE_SET_ARGS_INVALID");
  }
  if (arguments_.length === 1 && IDENTITYLESS_ACTIONS.has(arguments_[0])) {
    return Object.freeze({ action: arguments_[0], identity: null });
  }
  if (arguments_.length === 4 && (arguments_[0] === "archive" || arguments_[0] === "restore")) {
    return Object.freeze({
      action: arguments_[0],
      identity: requireIdentity(arguments_[1], arguments_[2], arguments_[3]),
    });
  }
  fail("CLOUD_RELEASE_SET_ARGS_INVALID");
}

export function releaseSetArguments(options) {
  return Object.freeze(
    IDENTITYLESS_ACTIONS.has(options.action)
      ? [options.action]
      : [
          options.action,
          options.identity.candidateSha,
          options.identity.tokenSha256,
          options.identity.outcome,
        ],
  );
}

export function lockedReleaseSetArguments(scriptPath, options) {
  if (typeof scriptPath !== "string" || !scriptPath.startsWith("/") || scriptPath.includes("\0")) {
    fail("CLOUD_RELEASE_SET_RUNNER_PATH_INVALID");
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
    ...releaseSetArguments(options),
  ]);
}

export async function runLockedReleaseSet(options, dependencies = {}) {
  const scriptPath = dependencies.scriptPath ?? fileURLToPath(import.meta.url);
  return await (dependencies.runCloudCommand ?? runCloudCommand)(
    FLOCK,
    lockedReleaseSetArguments(scriptPath, options),
    {
      accepting: ACCEPTING_CODES,
      cwd: "/",
      environment: COMMAND_ENVIRONMENT,
      label: "CLOUD_RELEASE_SET_LOCKED_RUN",
      timeoutMs: 30 * 60_000,
    },
  );
}

async function execute(options, dependencies) {
  if (options.action === "inventory" || options.action === "preflight") {
    const snapshot = await (
      dependencies.readReadonlyReleaseSnapshot ?? readReadonlyReleaseSnapshot
    )(undefined, dependencies);
    if (options.action === "preflight") {
      await (dependencies.assertReadonlyReleasePreflight ?? assertReadonlyReleasePreflight)(
        snapshot,
      );
    }
    return (dependencies.formatReadonlyReleaseSnapshot ?? formatReadonlyReleaseSnapshot)(
      options.action,
      snapshot,
    );
  }
  if (options.action === "list") {
    const candidates = await (dependencies.listReleaseSets ?? listArchivableReleaseSets)(
      dependencies,
    );
    const lines = [`CLOUD_RELEASE_SET_LIST count=${candidates.length}`];
    for (const candidate of candidates) {
      lines.push(
        `  candidate=${candidate.candidateSha} token_sha256=${candidate.tokenSha256} ` +
          `outcome=${candidate.outcome}`,
      );
    }
    return `${lines.join("\n")}\n`;
  }
  const operation =
    options.action === "archive"
      ? (dependencies.archiveReleaseSet ?? archiveReleaseSet)
      : (dependencies.restoreReleaseSet ?? restoreReleaseSet);
  const result = await operation(options.identity, dependencies);
  return (
    `CLOUD_RELEASE_SET_OK state=${result.state} candidate=${result.candidateSha} ` +
    `token_sha256=${result.tokenSha256} outcome=${result.outcome} items=${result.itemCount}\n`
  );
}

export async function main(arguments_ = process.argv.slice(2), dependencies = {}) {
  if ((dependencies.processUid ?? process.getuid?.()) !== 0) {
    fail("CLOUD_RELEASE_SET_ROOT_REQUIRED");
  }
  const lockHeld = arguments_[0] === LOCK_HELD;
  const options = parseReleaseSetArguments(lockHeld ? arguments_.slice(1) : arguments_);
  if (!lockHeld) {
    const result = await (dependencies.runLocked ?? runLockedReleaseSet)(options, dependencies);
    (dependencies.stdout ?? process.stdout).write(result.stdout);
    (dependencies.stderr ?? process.stderr).write(result.stderr);
    return result.code;
  }
  (dependencies.stdout ?? process.stdout).write(await execute(options, dependencies));
  return 0;
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
      const code = error instanceof CloudReleaseError ? error.code : "CLOUD_RELEASE_SET_FAILED";
      process.stderr.write(`${code}\n`);
      process.exitCode = 1;
    });
}
