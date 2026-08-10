import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";

import {
  KB_HEALTH_URL,
  PUBLIC_ORIGIN,
  REMOTE_RELEASE_LOCK,
  fail,
  incomingArchivePath,
  releaseBootstrapScript,
  requireMigrationHead,
  requireSha,
  requireToken,
  scpArguments,
  sshArguments,
} from "./hk-vps-release-core.mjs";
import { assertNoDirectAcceptanceSecrets } from "./hk-vps-release-acceptance-secrets.mjs";
import { releaseControllerLauncherPath } from "./hk-vps-release-controller-contract.mjs";
import { collectFinalizeEvidence } from "./hk-vps-release-local-evidence.mjs";
import { createArchive, withPinnedSshAuthority } from "./hk-vps-release-local-files.mjs";
import { assertRepositoryCandidate } from "./hk-vps-release-local-repository.mjs";
import { runCloudCommand, runPinnedSshReleaseCommand } from "./hk-vps-release-process.mjs";
import { parseTransition } from "./hk-vps-release-remote-support.mjs";

export { parseScannedHostKey } from "./hk-vps-release-local-files.mjs";

const GIT = "/usr/bin/git";
const GH = "/opt/homebrew/bin/gh";
const SSH = "/usr/bin/ssh";
const SCP = "/usr/bin/scp";
const SSH_KEYSCAN = "/usr/bin/ssh-keyscan";
const SSH_KEYGEN = "/usr/bin/ssh-keygen";
const CURL = "/usr/bin/curl";
const NODE = "/opt/nodejs/bin/node";
const REMOTE_ENTRY = "/opt/laundry-desk/tools/cloud/hk-vps-release-remote.mjs";
const HEALTH_ENVELOPE = Object.freeze({ ok: true, data: Object.freeze({ status: "ready" }) });
const STATUS_SCRIPT = `set -euo pipefail
exec 9>"${REMOTE_RELEASE_LOCK}"
flock -n 9 || { echo CLOUD_RELEASE_LOCKED >&2; exit 73; }
path=/var/lib/laundry-desk-release/transition.json
if [ ! -e "$path" ]; then
  printf 'STABLE\\n'
  exit 0
fi
test -f "$path" && test ! -L "$path"
test "$(stat -c '%U:%G:%a' "$path")" = "root:root:600"
cat "$path"`;

export function selectLocalEnvironment(environment) {
  assertNoDirectAcceptanceSecrets(environment);
  const names = [
    "GH_CONFIG_DIR",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "HOME",
    "LANG",
    "LC_ALL",
    "PATH",
    "SSH_AUTH_SOCK",
    "TMPDIR",
  ];
  return Object.freeze(
    Object.fromEntries(
      names.flatMap((name) =>
        typeof environment[name] === "string" ? [[name, environment[name]]] : [],
      ),
    ),
  );
}

export function selectCommandEnvironment(file, environment) {
  const common = ["LANG", "LC_ALL", "PATH"];
  const homeAware = [GIT, SSH, SCP, SSH_KEYSCAN, SSH_KEYGEN].includes(file) ? ["HOME"] : [];
  const github = file === GH ? ["GH_CONFIG_DIR", "GH_TOKEN", "GITHUB_TOKEN", "HOME"] : [];
  const names = new Set([...common, ...homeAware, ...github]);
  return Object.freeze(
    Object.fromEntries(
      [...names].flatMap((name) =>
        typeof environment[name] === "string" ? [[name, environment[name]]] : [],
      ),
    ),
  );
}

function commandOptions(context, label, timeoutMs = 2 * 60_000) {
  return Object.freeze({
    cwd: context.cwd,
    environment: context.environment,
    label,
    signal: context.signal,
    timeoutMs,
  });
}

async function command(context, file, arguments_, label, timeoutMs, extra = {}) {
  const { pinnedSshRelease = false, ...commandExtra } = extra;
  const execute = pinnedSshRelease ? runPinnedSshReleaseCommand : runCloudCommand;
  return await execute(
    file,
    arguments_,
    Object.freeze({
      ...commandOptions(context, label, timeoutMs),
      environment: selectCommandEnvironment(file, context.environment),
      ...commandExtra,
    }),
  );
}

function identityArguments(action, options) {
  return [
    "--action",
    action,
    "--candidate-sha",
    options.candidateSha,
    "--expected-current-sha",
    options.expectedSha,
    "--migration-head",
    options.migrationHead,
    "--release-token",
    options.token,
  ];
}

function rollbackRequest(options) {
  return JSON.stringify({
    candidate_sha: options.candidateSha,
    expected_sha: options.expectedSha,
    migration_head: options.migrationHead,
    schema: "laundry.cloud-release.rollback-request",
    token: options.token,
    version: 1,
  });
}

export function remoteStatefulArguments(action, options, knownHostsPath) {
  if (!/^(api-evidence|finalize|rollback)$/u.test(action)) fail("CLOUD_RELEASE_ACTION_INVALID");
  const entry =
    action === "rollback"
      ? releaseControllerLauncherPath(options.candidateSha, options.token)
      : REMOTE_ENTRY;
  return sshArguments(
    [
      "/usr/bin/flock",
      "-n",
      "-E",
      "73",
      REMOTE_RELEASE_LOCK,
      NODE,
      entry,
      ...(action === "rollback" ? [] : identityArguments(action, options)),
    ],
    knownHostsPath,
  );
}

async function remoteAction(context, action, options, knownHostsPath, extra = {}) {
  const invocation = Object.freeze({
    ...extra,
    ...(action === "rollback" ? { input: rollbackRequest(options) } : {}),
    pinnedSshRelease: true,
  });
  return await command(
    context,
    SSH,
    remoteStatefulArguments(action, options, knownHostsPath),
    `CLOUD_RELEASE_REMOTE_${action.toUpperCase().replaceAll("-", "_")}`,
    action === "api-evidence" ? 30 * 60_000 : 5 * 60_000,
    invocation,
  );
}

async function curl(context, url, label) {
  return await command(
    context,
    CURL,
    ["--fail", "--silent", "--show-error", "--max-time", "15", url],
    label,
  );
}

async function assertExternalHealth(context) {
  const health = await curl(context, `${PUBLIC_ORIGIN}/health`, "CLOUD_RELEASE_EXTERNAL_HEALTH");
  let parsed;
  try {
    parsed = JSON.parse(health.stdout);
  } catch (error) {
    fail("CLOUD_RELEASE_EXTERNAL_HEALTH_INVALID", error);
  }
  if (JSON.stringify(parsed) !== JSON.stringify(HEALTH_ENVELOPE)) {
    fail("CLOUD_RELEASE_EXTERNAL_HEALTH_INVALID");
  }
  await command(
    context,
    CURL,
    [
      "--fail",
      "--silent",
      "--show-error",
      "--max-time",
      "15",
      "--output",
      "/dev/null",
      PUBLIC_ORIGIN,
    ],
    "CLOUD_RELEASE_EXTERNAL_SPA",
  );
  const kb = await curl(context, KB_HEALTH_URL, "CLOUD_RELEASE_EXTERNAL_KB");
  if (kb.stdout.trim() !== "ok") fail("CLOUD_RELEASE_EXTERNAL_KB_INVALID");
}

export async function deployCandidate(context, input, dependencies = {}) {
  const options = Object.freeze({
    candidateSha: requireSha(input.candidateSha),
    expectedSha: requireSha(input.expectedSha),
    migrationHead: requireMigrationHead(input.migrationHead),
    token: input.token === undefined ? randomBytes(16).toString("hex") : requireToken(input.token),
  });
  const execute = dependencies.command ?? command;
  const authorize = dependencies.withPinnedSshAuthority ?? withPinnedSshAuthority;
  await (
    dependencies.assertRepositoryCandidate ??
    ((repositoryContext, candidateSha) =>
      assertRepositoryCandidate(repositoryContext, candidateSha, execute))
  )(context, options.candidateSha);
  return await authorize(execute.bind(undefined, context), async (authority) => {
    const archive = await (dependencies.createArchive ?? createArchive)(
      options.candidateSha,
      execute.bind(undefined, context),
    );
    const remotePath = incomingArchivePath(options.candidateSha, options.token);
    let uploadAttempted = false;
    let operationError;
    try {
      uploadAttempted = true;
      await execute(
        context,
        SCP,
        scpArguments(archive.archivePath, remotePath, authority.path),
        "CLOUD_RELEASE_UPLOAD",
        5 * 60_000,
      );
      await execute(
        context,
        SSH,
        sshArguments(
          [
            "/usr/bin/bash",
            "-s",
            "--",
            options.candidateSha,
            options.expectedSha,
            archive.digest,
            options.token,
            options.migrationHead,
          ],
          authority.path,
        ),
        "CLOUD_RELEASE_REMOTE_DEPLOY",
        30 * 60_000,
        { input: releaseBootstrapScript(), pinnedSshRelease: true },
      );
      try {
        await (dependencies.assertExternalHealth ?? assertExternalHealth)(context);
      } catch (error) {
        const recoveryContext = Object.freeze({ ...context, signal: undefined });
        try {
          await (dependencies.remoteAction ?? remoteAction)(
            recoveryContext,
            "rollback",
            options,
            authority.path,
          );
        } catch (rollbackError) {
          fail("CLOUD_RELEASE_RECOVERY_REQUIRED", rollbackError);
        }
        throw error;
      }
    } catch (error) {
      operationError = error;
    }
    const cleanupContext = Object.freeze({ ...context, signal: undefined });
    let cleanupError;
    try {
      if (uploadAttempted) {
        await execute(
          cleanupContext,
          SSH,
          sshArguments(["/usr/bin/rm", "-f", "--", remotePath], authority.path),
          "CLOUD_RELEASE_REMOTE_ARCHIVE_CLEANUP",
        );
      }
    } catch (error) {
      cleanupError = error;
    }
    try {
      await (dependencies.rm ?? rm)(archive.temporaryRoot, { recursive: true, force: true });
    } catch (error) {
      cleanupError ??= error;
    }
    if (operationError !== undefined) throw operationError;
    if (cleanupError !== undefined) throw cleanupError;
    return options;
  });
}

export async function completeRemoteAction(context, action, input, dependencies = {}) {
  if (!/^(finalize|rollback)$/u.test(action)) fail("CLOUD_RELEASE_ACTION_INVALID");
  const options = Object.freeze({
    candidateSha: requireSha(input.candidateSha),
    expectedSha: requireSha(input.expectedSha),
    migrationHead: requireMigrationHead(input.migrationHead),
    token: requireToken(input.token),
  });
  const execute = dependencies.command ?? command;
  const authorize = dependencies.withPinnedSshAuthority ?? withPinnedSshAuthority;
  const act = dependencies.remoteAction ?? remoteAction;
  if (action === "finalize") {
    await (
      dependencies.assertRepositoryCandidate ??
      ((repositoryContext, candidateSha) =>
        assertRepositoryCandidate(repositoryContext, candidateSha, execute))
    )(context, options.candidateSha);
  }
  await authorize(execute.bind(undefined, context), async (authority) => {
    if (action === "finalize") {
      await (dependencies.assertExternalHealth ?? assertExternalHealth)(context);
      const collected = await (dependencies.collectFinalizeEvidence ?? collectFinalizeEvidence)(
        Object.freeze({
          cwd: context.cwd,
          environment: context.environment,
          execute: execute.bind(undefined, context),
          knownHostsPath: authority.path,
          options,
        }),
        Object.freeze({
          runRemoteApiEvidence: async () =>
            await act(context, "api-evidence", options, authority.path),
        }),
      );
      await act(context, "finalize", options, authority.path, { input: collected.canonical });
      return;
    }
    await act(context, action, options, authority.path, { input: rollbackRequest(options) });
  });
}

export async function remoteStatus(context) {
  const result = await withPinnedSshAuthority(
    command.bind(undefined, context),
    async (authority) =>
      await command(
        context,
        SSH,
        sshArguments(["/usr/bin/bash", "-s", "--"], authority.path),
        "CLOUD_RELEASE_REMOTE_STATUS",
        undefined,
        { input: STATUS_SCRIPT },
      ),
  );
  if (result.stdout === "STABLE\n") {
    return Object.freeze({ ...result, stdout: "CLOUD_RELEASE_REMOTE_STATUS phase=stable\n" });
  }
  let record;
  try {
    record = parseTransition(JSON.parse(result.stdout));
  } catch (error) {
    fail("CLOUD_RELEASE_TRANSITION_INVALID", error);
  }
  return Object.freeze({
    ...result,
    stdout: `CLOUD_RELEASE_REMOTE_STATUS phase=${record.phase} candidate_sha=${record.candidate_sha} expected_sha=${record.expected_sha} migration_head=${record.migration_head}\n`,
  });
}
