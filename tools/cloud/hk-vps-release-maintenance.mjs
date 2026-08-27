// One-time exact-main bootstrap for retention tools when the live release tree cannot be upgraded
// because every retention set is already full. This installs a root-private copy of the exact
// green Git archive under /var/lib; it never edits /opt/laundry-desk or release evidence.

import { randomBytes } from "node:crypto";
import { realpath, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  DEFAULT_CLOUD_ENVIRONMENT_PROFILE,
  requireCloudEnvironmentProfile,
  resolveCloudEnvironmentProfile,
} from "./cloud-environment-profile.mjs";
import {
  CloudReleaseError,
  fail,
  requireSha,
  scpArguments,
  sshArguments,
} from "./hk-vps-release-core.mjs";
import { createArchive, withPinnedSshAuthority } from "./hk-vps-release-local-files.mjs";
import { assertRepositoryCandidate } from "./hk-vps-release-local-repository.mjs";
import { selectCommandEnvironment, selectLocalEnvironment } from "./hk-vps-release-local.mjs";
import { runCloudCommand, withCloudSignalCancellation } from "./hk-vps-release-process.mjs";

export const MAINTENANCE_ROOT = DEFAULT_CLOUD_ENVIRONMENT_PROFILE.paths.maintenanceRoot;

const SSH = "/usr/bin/ssh";
const SCP = "/usr/bin/scp";
const TOKEN = /^[0-9a-f]{32}$/u;

export function maintenanceIncomingPath(
  candidateSha,
  nonce,
  profileInput = DEFAULT_CLOUD_ENVIRONMENT_PROFILE,
) {
  const profile = requireCloudEnvironmentProfile(profileInput);
  const candidate = requireSha(candidateSha);
  if (typeof nonce !== "string" || !TOKEN.test(nonce)) {
    fail("CLOUD_RELEASE_MAINTENANCE_NONCE_INVALID");
  }
  return `${profile.paths.maintenanceRoot}/incoming-${candidate}-${nonce}.tar`;
}

export function maintenanceTreePath(
  candidateSha,
  profileInput = DEFAULT_CLOUD_ENVIRONMENT_PROFILE,
) {
  const profile = requireCloudEnvironmentProfile(profileInput);
  return `${profile.paths.maintenanceRoot}/trees/${requireSha(candidateSha)}`;
}

export function maintenancePrepareScript(profileInput = DEFAULT_CLOUD_ENVIRONMENT_PROFILE) {
  const profile = requireCloudEnvironmentProfile(profileInput);
  return `set -euo pipefail
umask 077
test "$#" -eq 2 || { echo CLOUD_RELEASE_MAINTENANCE_ARGS_INVALID >&2; exit 64; }
candidate="$1"; nonce="$2"
[[ "\${candidate}" =~ ^[0-9a-f]{40}$ ]] && [[ "\${nonce}" =~ ^[0-9a-f]{32}$ ]] || {
  echo CLOUD_RELEASE_MAINTENANCE_ARGS_INVALID >&2; exit 64;
}
root=${profile.paths.maintenanceRoot}
if [ ! -e "\${root}" ]; then mkdir -m 0700 -- "\${root}"; fi
test -d "\${root}" && test ! -L "\${root}" &&
  test "$(stat -c '%U:%G:%a' "\${root}")" = root:root:700 &&
  test "$(realpath -e -- "\${root}")" = "\${root}" || {
    echo CLOUD_RELEASE_MAINTENANCE_ROOT_INVALID >&2; exit 74;
  }
incoming="\${root}/incoming-\${candidate}-\${nonce}.tar"
test ! -e "\${incoming}" && test ! -L "\${incoming}" || {
  echo CLOUD_RELEASE_MAINTENANCE_COLLISION >&2; exit 74;
}
printf 'CLOUD_RELEASE_MAINTENANCE_READY\\n'
`;
}

export function maintenanceInstallScript(profileInput = DEFAULT_CLOUD_ENVIRONMENT_PROFILE) {
  const profile = requireCloudEnvironmentProfile(profileInput);
  return `set -euo pipefail
umask 077
fail() { printf '%s\\n' "$1" >&2; exit 74; }
test "$#" -eq 3 || { echo CLOUD_RELEASE_MAINTENANCE_ARGS_INVALID >&2; exit 64; }
candidate="$1"; nonce="$2"; digest="$3"
[[ "\${candidate}" =~ ^[0-9a-f]{40}$ ]] && [[ "\${nonce}" =~ ^[0-9a-f]{32}$ ]] &&
  [[ "\${digest}" =~ ^[0-9a-f]{64}$ ]] || {
    echo CLOUD_RELEASE_MAINTENANCE_ARGS_INVALID >&2; exit 64;
  }
root=${profile.paths.maintenanceRoot}
lock=${profile.paths.releaseLock}
exec 9>"\${lock}" || fail CLOUD_RELEASE_MAINTENANCE_LOCK_FAILED
flock -n 9 || { echo CLOUD_RELEASE_LOCKED >&2; exit 73; }
test ! -e ${profile.paths.releaseStateRoot}/transition.json ||
  fail CLOUD_RELEASE_SET_TRANSITION_ACTIVE
test -d "\${root}" && test ! -L "\${root}" &&
  test "$(stat -c '%U:%G:%a' "\${root}")" = root:root:700 &&
  test "$(realpath -e -- "\${root}")" = "\${root}" ||
  fail CLOUD_RELEASE_MAINTENANCE_ROOT_INVALID
incoming="\${root}/incoming-\${candidate}-\${nonce}.tar"
test -f "\${incoming}" && test ! -L "\${incoming}" &&
  test "$(stat -c '%U:%G:%h' "\${incoming}")" = root:root:1 ||
  fail CLOUD_RELEASE_MAINTENANCE_ARCHIVE_INVALID
chmod 0600 -- "\${incoming}" || fail CLOUD_RELEASE_MAINTENANCE_ARCHIVE_INVALID
actual="$(sha256sum -- "\${incoming}" | awk '{print $1}')"
test "\${actual}" = "\${digest}" || fail CLOUD_RELEASE_MAINTENANCE_DIGEST_MISMATCH
for directory in archives trees; do
  path="\${root}/\${directory}"
  if [ ! -e "\${path}" ]; then mkdir -m 0700 -- "\${path}"; fi
  test -d "\${path}" && test ! -L "\${path}" &&
    test "$(stat -c '%U:%G:%a' "\${path}")" = root:root:700 ||
    fail CLOUD_RELEASE_MAINTENANCE_ROOT_INVALID
done
tree="\${root}/trees/\${candidate}"
marker="\${tree}/.maintenance-source"
if [ -e "\${tree}" ] || [ -L "\${tree}" ]; then
  test -d "\${tree}" && test ! -L "\${tree}" &&
    test "$(stat -c '%U:%G:%a' "\${tree}")" = root:root:700 &&
    test -f "\${marker}" && test ! -L "\${marker}" &&
    test "$(stat -c '%U:%G:%a' "\${marker}")" = root:root:600 &&
    test "$(cat -- "\${marker}")" = "\${candidate} \${digest}" ||
    fail CLOUD_RELEASE_MAINTENANCE_TREE_INVALID
else
  stage="$(mktemp -d "\${root}/.stage-\${candidate}-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX")" ||
    fail CLOUD_RELEASE_MAINTENANCE_STAGE_FAILED
  chmod 0700 -- "\${stage}" || fail CLOUD_RELEASE_MAINTENANCE_STAGE_FAILED
  tar --extract --file "\${incoming}" --directory "\${stage}" \
    --no-same-owner --no-same-permissions || fail CLOUD_RELEASE_MAINTENANCE_STAGE_FAILED
  test -z "$(find "\${stage}" -type l -print -quit)" ||
    fail CLOUD_RELEASE_MAINTENANCE_STAGE_FAILED
  for required in \
    tools/cloud/hk-vps-release-artifact-archive-run.mjs \
    tools/cloud/hk-vps-release-set-archive-run.mjs; do
    test -f "\${stage}/\${required}" && test ! -L "\${stage}/\${required}" ||
      fail CLOUD_RELEASE_MAINTENANCE_STAGE_FAILED
  done
  printf '%s %s\\n' "\${candidate}" "\${digest}" >"\${stage}/.maintenance-source"
  chmod 0600 -- "\${stage}/.maintenance-source"
  sync -f "\${stage}/.maintenance-source" "\${stage}"
  mv -- "\${stage}" "\${tree}" || fail CLOUD_RELEASE_MAINTENANCE_PUBLISH_FAILED
  sync -f "\${root}/trees"
fi
for required in \
  tools/cloud/hk-vps-release-artifact-archive-run.mjs \
  tools/cloud/hk-vps-release-set-archive-run.mjs; do
  test -f "\${tree}/\${required}" && test ! -L "\${tree}/\${required}" ||
    fail CLOUD_RELEASE_MAINTENANCE_TREE_INVALID
done
archive="\${root}/archives/\${candidate}-\${digest}.tar"
if [ -e "\${archive}" ] || [ -L "\${archive}" ]; then
  test -f "\${archive}" && test ! -L "\${archive}" &&
    test "$(stat -c '%U:%G:%a:%h' "\${archive}")" = root:root:600:1 &&
    test "$(sha256sum -- "\${archive}" | awk '{print $1}')" = "\${digest}" ||
    fail CLOUD_RELEASE_MAINTENANCE_ARCHIVE_INVALID
  rm -f -- "\${incoming}" || fail CLOUD_RELEASE_MAINTENANCE_ARCHIVE_INVALID
else
  mv -- "\${incoming}" "\${archive}" || fail CLOUD_RELEASE_MAINTENANCE_PUBLISH_FAILED
  chmod 0600 -- "\${archive}"
  sync -f "\${archive}" "\${root}/archives" "\${root}"
fi
printf 'CLOUD_RELEASE_MAINTENANCE_OK candidate=%s archive_sha256=%s tree=%s\\n' \
  "\${candidate}" "\${digest}" "\${tree}"
`;
}

export function parseMaintenanceArguments(argv) {
  const arguments_ = argv[0] === "--" ? argv.slice(1) : argv;
  const values = new Map();
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    const value = arguments_[index + 1];
    if (
      !new Set(["--candidate-sha", "--profile"]).has(key) ||
      typeof value !== "string" ||
      values.has(key)
    ) {
      fail("CLOUD_RELEASE_MAINTENANCE_ARGS_INVALID");
    }
    values.set(key, value);
  }
  if (!values.has("--candidate-sha")) fail("CLOUD_RELEASE_MAINTENANCE_ARGS_INVALID");
  const profileName = values.get("--profile");
  if (profileName !== undefined) resolveCloudEnvironmentProfile(profileName);
  return Object.freeze({
    candidateSha: requireSha(values.get("--candidate-sha")),
    ...(profileName === undefined ? {} : { profileName }),
  });
}

function commandOptions(context, file, label, timeoutMs, extra) {
  return Object.freeze({
    cwd: context.cwd,
    environment: selectCommandEnvironment(file, context.environment),
    label,
    signal: context.signal,
    timeoutMs,
    ...extra,
  });
}

async function command(context, file, arguments_, label, timeoutMs = 2 * 60_000, extra = {}) {
  return await runCloudCommand(
    file,
    arguments_,
    commandOptions(context, file, label, timeoutMs, extra),
  );
}

export async function installMaintenanceTree(context, input, dependencies = {}) {
  const candidateSha = requireSha(input.candidateSha);
  const profile = requireCloudEnvironmentProfile(
    context?.profile ?? DEFAULT_CLOUD_ENVIRONMENT_PROFILE,
  );
  const execute = dependencies.command ?? command;
  await (dependencies.assertRepositoryCandidate ?? assertRepositoryCandidate)(
    context,
    candidateSha,
    execute,
  );
  const archive = await (dependencies.createArchive ?? createArchive)(
    candidateSha,
    execute.bind(undefined, context),
  );
  const nonce = (dependencies.randomBytes ?? randomBytes)(16).toString("hex");
  const incoming = maintenanceIncomingPath(candidateSha, nonce, profile);
  let result;
  let operationError;
  try {
    result = await (dependencies.withPinnedSshAuthority ?? withPinnedSshAuthority)(
      execute.bind(undefined, context),
      async (authority) => {
        await execute(
          context,
          SSH,
          sshArguments(["/usr/bin/bash", "-s", "--", candidateSha, nonce], authority.path, profile),
          "CLOUD_RELEASE_MAINTENANCE_PREPARE",
          2 * 60_000,
          { input: maintenancePrepareScript(profile) },
        );
        await execute(
          context,
          SCP,
          scpArguments(archive.archivePath, incoming, authority.path, profile),
          "CLOUD_RELEASE_MAINTENANCE_UPLOAD",
          5 * 60_000,
        );
        const installed = await execute(
          context,
          SSH,
          sshArguments(
            ["/usr/bin/bash", "-s", "--", candidateSha, nonce, archive.digest],
            authority.path,
            profile,
          ),
          "CLOUD_RELEASE_MAINTENANCE_INSTALL",
          10 * 60_000,
          { input: maintenanceInstallScript(profile) },
        );
        return Object.freeze({
          archiveSha256: archive.digest,
          candidateSha,
          output: installed.stdout,
          tree: maintenanceTreePath(candidateSha, profile),
        });
      },
      {},
      profile,
    );
  } catch (error) {
    operationError = error;
  }
  let cleanupError;
  try {
    await (dependencies.rm ?? rm)(archive.temporaryRoot, { force: true, recursive: true });
  } catch (error) {
    cleanupError = error;
  }
  if (operationError !== undefined) throw operationError;
  if (cleanupError !== undefined) throw cleanupError;
  return result;
}

function safeErrorCode(error) {
  return error instanceof CloudReleaseError ? error.code : "CLOUD_RELEASE_MAINTENANCE_FAILED";
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseMaintenanceArguments(argv);
  const context = Object.freeze({
    cwd: await realpath(process.cwd()),
    environment: selectLocalEnvironment(process.env),
    profile: resolveCloudEnvironmentProfile(options.profileName),
  });
  await withCloudSignalCancellation(async (signal) => {
    const result = await installMaintenanceTree(Object.freeze({ ...context, signal }), options);
    process.stdout.write(result.output);
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
