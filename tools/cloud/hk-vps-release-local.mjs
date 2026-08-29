import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";

import {
  DEFAULT_CLOUD_ENVIRONMENT_PROFILE,
  requireCloudEnvironmentProfile,
} from "./cloud-environment-profile.mjs";
import {
  fail,
  releaseBootstrapScript,
  requireMigrationHead,
  requireSha,
  requireToken,
  scpArguments,
  sshArguments,
} from "./hk-vps-release-core.mjs";
import { assertNoDirectAcceptanceSecrets } from "./hk-vps-release-acceptance-secrets.mjs";
import { releaseControllerLauncherPath } from "./hk-vps-release-controller-contract.mjs";
import { classifyRemoteDeployError } from "./hk-vps-release-local-errors.mjs";
import { collectFinalizeEvidence } from "./hk-vps-release-local-evidence.mjs";
import { createArchive, withPinnedSshAuthority } from "./hk-vps-release-local-files.mjs";
import { assertProfileExternalHealth } from "./hk-vps-release-local-health.mjs";
import { assertRepositoryCandidate } from "./hk-vps-release-local-repository.mjs";
import { runCloudCommand, runPinnedSshReleaseCommand } from "./hk-vps-release-process.mjs";
import { parseTransition } from "./hk-vps-release-remote-support.mjs";

export { parseScannedHostKey } from "./hk-vps-release-local-files.mjs";

const GIT = "/usr/bin/git";
const GH_PATHS = new Set(["/opt/homebrew/bin/gh", "/usr/bin/gh"]);
const SSH = "/usr/bin/ssh";
const SCP = "/usr/bin/scp";
const SSH_KEYSCAN = "/usr/bin/ssh-keyscan";
const SSH_KEYGEN = "/usr/bin/ssh-keygen";
const REMOTE_API_EVIDENCE_TIMEOUT_MS = 30 * 60_000;
export const REMOTE_FINALIZE_ROLLBACK_TIMEOUT_MS = 10 * 60_000;

function environmentProfile(context) {
  return requireCloudEnvironmentProfile(context?.profile ?? DEFAULT_CLOUD_ENVIRONMENT_PROFILE);
}

function statusScript(profile) {
  return `set -euo pipefail
exec 9>"${profile.paths.releaseLock}"
flock -n 9 || { echo CLOUD_RELEASE_LOCKED >&2; exit 73; }
path=${profile.paths.releaseStateRoot}/transition.json
if [ ! -e "$path" ]; then
  printf 'STABLE\\n'
  exit 0
fi
test -f "$path" && test ! -L "$path"
test "$(stat -c '%U:%G:%a' "$path")" = "root:root:600"
cat "$path"`;
}

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
  const sshAgent = [SSH, SCP].includes(file) ? ["SSH_AUTH_SOCK"] : [];
  const github = GH_PATHS.has(file) ? ["GH_CONFIG_DIR", "GH_TOKEN", "GITHUB_TOKEN", "HOME"] : [];
  const names = new Set([...common, ...homeAware, ...sshAgent, ...github]);
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
      ...(pinnedSshRelease ? { profile: environmentProfile(context) } : {}),
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

export function remoteStatefulArguments(
  action,
  options,
  knownHostsPath,
  profileInput = DEFAULT_CLOUD_ENVIRONMENT_PROFILE,
) {
  if (!/^(api-evidence|finalize|rollback)$/u.test(action)) fail("CLOUD_RELEASE_ACTION_INVALID");
  const profile = requireCloudEnvironmentProfile(profileInput);
  const entry =
    action === "rollback"
      ? releaseControllerLauncherPath(options.candidateSha, options.token)
      : `${profile.paths.liveRoot}/tools/cloud/hk-vps-release-remote.mjs`;
  return sshArguments(
    [
      "/usr/bin/flock",
      "-n",
      "-E",
      "73",
      profile.paths.releaseLock,
      profile.paths.nodeExecutable,
      entry,
      ...(action === "rollback" ? [] : identityArguments(action, options)),
    ],
    knownHostsPath,
    profile,
  );
}

export async function remoteAction(
  context,
  action,
  options,
  knownHostsPath,
  extra = {},
  dependencies = {},
) {
  const profile = environmentProfile(context);
  const invocation = Object.freeze({
    ...extra,
    ...(action === "rollback" ? { input: rollbackRequest(options) } : {}),
    pinnedSshRelease: true,
  });
  return await (dependencies.command ?? command)(
    context,
    SSH,
    remoteStatefulArguments(action, options, knownHostsPath, profile),
    `CLOUD_RELEASE_REMOTE_${action.toUpperCase().replaceAll("-", "_")}`,
    action === "api-evidence"
      ? REMOTE_API_EVIDENCE_TIMEOUT_MS
      : REMOTE_FINALIZE_ROLLBACK_TIMEOUT_MS,
    invocation,
  );
}

async function assertExternalHealth(context) {
  return await assertProfileExternalHealth(context, command);
}

export async function deployCandidate(context, input, dependencies = {}) {
  const options = Object.freeze({
    candidateSha: requireSha(input.candidateSha),
    expectedSha: requireSha(input.expectedSha),
    migrationHead: requireMigrationHead(input.migrationHead),
    token: input.token === undefined ? randomBytes(16).toString("hex") : requireToken(input.token),
  });
  const profile = environmentProfile(context);
  const execute = dependencies.command ?? command;
  const authorize = dependencies.withPinnedSshAuthority ?? withPinnedSshAuthority;
  await (
    dependencies.assertRepositoryCandidate ??
    ((repositoryContext, candidateSha) =>
      assertRepositoryCandidate(repositoryContext, candidateSha, execute))
  )(context, options.candidateSha);
  return await authorize(
    execute.bind(undefined, context),
    async (authority) => {
      const archive = await (dependencies.createArchive ?? createArchive)(
        options.candidateSha,
        execute.bind(undefined, context),
      );
      const remotePath = `${profile.paths.liveRoot}.incoming-${options.candidateSha}-${options.token}.tar`;
      let uploadAttempted = false;
      let operationError;
      try {
        uploadAttempted = true;
        await execute(
          context,
          SCP,
          scpArguments(archive.archivePath, remotePath, authority.path, profile),
          "CLOUD_RELEASE_UPLOAD",
          5 * 60_000,
        );
        try {
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
              profile,
            ),
            "CLOUD_RELEASE_REMOTE_DEPLOY",
            30 * 60_000,
            { input: releaseBootstrapScript(profile), pinnedSshRelease: true },
          );
        } catch (error) {
          throw classifyRemoteDeployError(error);
        }
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
            sshArguments(["/usr/bin/rm", "-f", "--", remotePath], authority.path, profile),
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
    },
    {},
    profile,
  );
}

export async function completeRemoteAction(context, action, input, dependencies = {}) {
  if (!/^(finalize|rollback)$/u.test(action)) fail("CLOUD_RELEASE_ACTION_INVALID");
  const options = Object.freeze({
    candidateSha: requireSha(input.candidateSha),
    expectedSha: requireSha(input.expectedSha),
    migrationHead: requireMigrationHead(input.migrationHead),
    token: requireToken(input.token),
  });
  const profile = environmentProfile(context);
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
  await authorize(
    execute.bind(undefined, context),
    async (authority) => {
      if (action === "finalize") {
        await (dependencies.assertExternalHealth ?? assertExternalHealth)(context);
        const collected = await (dependencies.collectFinalizeEvidence ?? collectFinalizeEvidence)(
          Object.freeze({
            cwd: context.cwd,
            environment: context.environment,
            execute: execute.bind(undefined, context),
            knownHostsPath: authority.path,
            options,
            profile,
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
    },
    {},
    profile,
  );
}

export async function remoteStatus(context) {
  const profile = environmentProfile(context);
  const result = await withPinnedSshAuthority(
    command.bind(undefined, context),
    async (authority) =>
      await command(
        context,
        SSH,
        sshArguments(["/usr/bin/bash", "-s", "--"], authority.path, profile),
        "CLOUD_RELEASE_REMOTE_STATUS",
        undefined,
        { input: statusScript(profile) },
      ),
    {},
    profile,
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
