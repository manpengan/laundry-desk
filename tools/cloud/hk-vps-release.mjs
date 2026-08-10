import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { CloudReleaseError, fail } from "./hk-vps-release-core.mjs";
import {
  completeRemoteAction,
  deployCandidate,
  remoteStatus,
  selectLocalEnvironment,
} from "./hk-vps-release-local.mjs";
import { withCloudSignalCancellation } from "./hk-vps-release-process.mjs";

const ACTIONS = new Set(["prepare", "finalize", "rollback", "status"]);

export function parseArguments(argv) {
  const arguments_ = argv[0] === "--" ? argv.slice(1) : argv;
  if (arguments_.includes("--")) fail("CLOUD_RELEASE_ARGS_INVALID");
  const values = new Map();
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    const value = arguments_[index + 1];
    if (
      typeof key !== "string" ||
      !key.startsWith("--") ||
      typeof value !== "string" ||
      values.has(key)
    ) {
      fail("CLOUD_RELEASE_ARGS_INVALID");
    }
    values.set(key, value);
  }
  const action = values.get("--action");
  if (action === undefined || !ACTIONS.has(action)) fail("CLOUD_RELEASE_ACTION_INVALID");
  const identityKeys = [
    "--candidate-sha",
    "--expected-current-sha",
    "--migration-head",
    "--release-token",
  ];
  const allowed = new Set(["--action", ...(action === "status" ? [] : identityKeys)]);
  if ([...values.keys()].some((key) => !allowed.has(key))) {
    fail("CLOUD_RELEASE_ARGS_INVALID");
  }
  if (action === "status") return Object.freeze({ action });
  const required = action === "prepare" ? identityKeys.slice(0, 3) : identityKeys;
  if (required.some((key) => !values.has(key))) fail("CLOUD_RELEASE_ARGS_INVALID");
  return Object.freeze({
    action,
    candidateSha: values.get("--candidate-sha"),
    expectedSha: values.get("--expected-current-sha"),
    migrationHead: values.get("--migration-head"),
    token: values.get("--release-token"),
  });
}

function safeErrorCode(error) {
  if (error instanceof CloudReleaseError) return error.code;
  if (error instanceof Error && /^[A-Z][A-Z0-9_]{2,127}$/u.test(error.message)) {
    return error.message;
  }
  return "CLOUD_RELEASE_FAILED";
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const cwd = await realpath(process.cwd());
  const context = Object.freeze({
    cwd,
    environment: selectLocalEnvironment(process.env),
  });
  await withCloudSignalCancellation(async (signal) => {
    const active = Object.freeze({ ...context, signal });
    if (options.action === "status") {
      const result = await remoteStatus(active);
      process.stdout.write(result.stdout);
      return;
    }
    if (options.action === "prepare") {
      const identity = await deployCandidate(active, options);
      process.stdout.write(
        `CLOUD_RELEASE_AWAITING_EXTERNAL_VERIFICATION candidate_sha=${identity.candidateSha} expected_sha=${identity.expectedSha} token=${identity.token} migration_head=${identity.migrationHead}\n`,
      );
      return;
    }
    await completeRemoteAction(active, options.action, options);
    process.stdout.write(
      options.action === "finalize"
        ? `CLOUD_RELEASE_COMMITTED candidate_sha=${options.candidateSha}\n`
        : `CLOUD_RELEASE_ROLLED_BACK candidate_sha=${options.candidateSha}\n`,
    );
  });
}

export function isDirectEntrypoint(entry, moduleUrl) {
  return entry !== undefined && moduleUrl === pathToFileURL(resolve(entry)).href;
}

if (isDirectEntrypoint(process.argv[1], import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${safeErrorCode(error)}\n`);
    process.exitCode = 1;
  });
}
