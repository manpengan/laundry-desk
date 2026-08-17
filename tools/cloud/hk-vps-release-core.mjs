import { isAbsolute } from "node:path";

import { releaseBootstrapSignalScript } from "./hk-vps-release-bootstrap-signal.mjs";
import { fail, requireSha } from "./hk-vps-release-identifiers.mjs";
import { safeRemoteReleaseErrorCodes } from "./hk-vps-release-remote-error-contract.mjs";

export {
  CloudReleaseError,
  fail,
  incomingArchivePath,
  requireDigest,
  requireMigrationHead,
  requireSha,
  requireToken,
  sha256File,
} from "./hk-vps-release-identifiers.mjs";

export const HK_VPS_ALIAS = "hk-vps";
export const HK_VPS_HOST = "103.233.252.201";
export const HK_VPS_USER = "root";
export const HK_VPS_PORT = "22";
export const HK_VPS_IDENTITY_SUFFIX = "/.ssh/hk_vps_ed25519";
export const HK_VPS_ED25519_FINGERPRINT = "SHA256:Urp+pKpu/XD45nZlT+1tYJ5VYmV5X0fXStu+zmQjv4A";
export const REQUIRED_CHECKS = Object.freeze(["workspace-check", "real-postgres"]);
export const PUBLIC_ORIGIN = "https://desk.manpengan.xyz";
export const KB_HEALTH_URL = "https://kb.manpengan.xyz/healthz";
export const REMOTE_RELEASE_LOCK = "/run/lock/laundry-desk-cloud-release.lock";

function requireKnownHostsPath(value) {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) {
    fail("CLOUD_RELEASE_KNOWN_HOSTS_INVALID");
  }
  return value;
}

function hostAuthorityArguments(knownHostsPath) {
  return [
    "-o",
    `UserKnownHostsFile=${requireKnownHostsPath(knownHostsPath)}`,
    "-o",
    "GlobalKnownHostsFile=/dev/null",
    "-o",
    "HostKeyAlgorithms=ssh-ed25519",
  ];
}

export function sshArguments(arguments_, knownHostsPath) {
  return Object.freeze([
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
    ...hostAuthorityArguments(knownHostsPath),
    HK_VPS_ALIAS,
    ...arguments_,
  ]);
}

export function scpArguments(sourcePath, remotePath, knownHostsPath) {
  if (typeof sourcePath !== "string" || !isAbsolute(sourcePath) || sourcePath.includes("\0")) {
    fail("CLOUD_RELEASE_ARCHIVE_PATH_INVALID");
  }
  if (
    typeof remotePath !== "string" ||
    ![
      /^\/opt\/laundry-desk\.incoming-[0-9a-f]{40}-[0-9a-f]{32}\.tar$/u,
      /^\/var\/lib\/laundry-desk-release-maintenance\/incoming-[0-9a-f]{40}-[0-9a-f]{32}\.tar$/u,
    ].some((pattern) => pattern.test(remotePath))
  ) {
    fail("CLOUD_RELEASE_REMOTE_PATH_INVALID");
  }
  return Object.freeze([
    "-q",
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
    ...hostAuthorityArguments(knownHostsPath),
    sourcePath,
    `${HK_VPS_ALIAS}:${remotePath}`,
  ]);
}

export function parseSshConfig(source) {
  if (typeof source !== "string" || source.length > 65_536) {
    fail("CLOUD_RELEASE_SSH_CONFIG_INVALID");
  }
  const entries = new Map();
  for (const line of source.split("\n")) {
    const match = /^([^\s]+)\s+(.+)$/u.exec(line.trim());
    if (match === null) continue;
    const [, key, value] = match;
    if (key !== undefined && value !== undefined && !entries.has(key)) entries.set(key, value);
  }
  return entries;
}

export function assertPinnedSshConfig(source) {
  const config = parseSshConfig(source);
  const identity = config.get("identityfile");
  if (
    config.get("hostname") !== HK_VPS_HOST ||
    config.get("user") !== HK_VPS_USER ||
    config.get("port") !== HK_VPS_PORT ||
    config.get("passwordauthentication") !== "no" ||
    config.get("kbdinteractiveauthentication") !== "no" ||
    (config.has("proxycommand") && config.get("proxycommand") !== "none") ||
    (config.has("proxyjump") && config.get("proxyjump") !== "none") ||
    config.has("hostkeyalias") ||
    typeof identity !== "string" ||
    !identity.endsWith(HK_VPS_IDENTITY_SUFFIX)
  ) {
    fail("CLOUD_RELEASE_SSH_CONFIG_INVALID");
  }
}

export function assertRequiredChecks(checkRuns, expectedSha) {
  if (!Array.isArray(checkRuns)) fail("CLOUD_RELEASE_CI_INVALID");
  const headSha = requireSha(expectedSha, "CLOUD_RELEASE_CI_INVALID");
  for (const required of REQUIRED_CHECKS) {
    const matches = checkRuns
      .filter((run) => run?.name === required)
      .sort((left, right) => {
        const rightTime = String(
          right?.started_at ?? right?.created_at ?? right?.completed_at ?? "",
        );
        const leftTime = String(left?.started_at ?? left?.created_at ?? left?.completed_at ?? "");
        return rightTime.localeCompare(leftTime) || Number(right?.id ?? 0) - Number(left?.id ?? 0);
      });
    if (
      matches.length < 1 ||
      matches[0]?.status !== "completed" ||
      matches[0]?.conclusion !== "success" ||
      matches[0]?.head_sha !== headSha ||
      matches[0]?.app?.slug !== "github-actions"
    ) {
      fail("CLOUD_RELEASE_CI_NOT_GREEN");
    }
  }
}

export function releaseBootstrapScript() {
  const safeRemoteCodes = safeRemoteReleaseErrorCodes()
    .map((code) => `  (${code}) return 0 ;;`)
    .join("\n");
  return `set -euo pipefail
umask 077
bootstrap_error=""
bootstrap_fail() {
  bootstrap_error="$1"
  exit 74
}
is_safe_remote_code() {
  case "$1" in
${safeRemoteCodes}
    (*) return 1 ;;
  esac
}
test "$#" -eq 5 || { echo CLOUD_RELEASE_ARGS_INVALID >&2; exit 64; }
candidate="$1"
expected="$2"
digest="$3"
token="$4"
migration_head="$5"
case "\${candidate}" in (*[!0-9a-f]*|'') echo CLOUD_RELEASE_SHA_INVALID >&2; exit 64;; esac
case "\${expected}" in (*[!0-9a-f]*|'') echo CLOUD_RELEASE_SHA_INVALID >&2; exit 64;; esac
case "\${digest}" in (*[!0-9a-f]*|'') echo CLOUD_RELEASE_DIGEST_INVALID >&2; exit 64;; esac
case "\${token}" in (*[!0-9a-f]*|'') echo CLOUD_RELEASE_TOKEN_INVALID >&2; exit 64;; esac
test "\${#candidate}" -eq 40 && test "\${#expected}" -eq 40 &&
  test "\${#digest}" -eq 64 && test "\${#token}" -eq 32 || {
    echo CLOUD_RELEASE_ARGS_INVALID >&2
    exit 64
  }
case "\${migration_head}" in
  (*[!0-9a-z_.]*|'') echo CLOUD_RELEASE_MIGRATION_HEAD_INVALID >&2; exit 64;;
esac
printf '%s' "\${migration_head}" |
  grep -Eq '^[0-9]{4}_[a-z0-9_]+\.sql$' || {
    echo CLOUD_RELEASE_MIGRATION_HEAD_INVALID >&2
    exit 64
  }
test "\${candidate}" != "\${expected}" || {
  echo CLOUD_RELEASE_ALREADY_CURRENT >&2
  exit 64
}
archive="/opt/laundry-desk.incoming-\${candidate}-\${token}.tar"
staging="/opt/laundry-desk.next-\${candidate}"
lock="${REMOTE_RELEASE_LOCK}"
staging_created=0; staging_identity=""
capture_dir=""; remote_stdout=""; remote_stderr=""
stdout_pipe=""; stderr_pipe=""; watchdog_pipe=""
capture_created=0; capture_identity=""
archive_identity=""
success_output_ready=0
remote_pid=""; remote_identity=""; signal_pending=""
bootstrap_pid=""; bootstrap_identity=""
session_parent_pid=""; session_parent_identity=""
watchdog_pid=""; watchdog_identity=""
stdout_reader=""; stdout_reader_identity=""
stderr_reader=""; stderr_reader_identity=""
capture_remote_code() {
  remote_code=""
  [ "\${capture_created}" -eq 1 ] && [ -n "\${remote_stdout}" ] &&
    [ -n "\${remote_stderr}" ] && [ -f "\${remote_stdout}" ] &&
    [ ! -L "\${remote_stdout}" ] && [ -f "\${remote_stderr}" ] &&
    [ ! -L "\${remote_stderr}" ] || return 1
  remote_bytes="$(wc -c 2>/dev/null <"\${remote_stderr}")" || return 1
  [ ! -s "\${remote_stdout}" ] && [ "\${remote_bytes}" -le 128 ] &&
    IFS= read -r remote_code 2>/dev/null <"\${remote_stderr}" &&
    [ "$(printf '%s\\n' "\${remote_code}" | wc -c)" -eq "\${remote_bytes}" ] &&
    [[ "\${remote_code}" =~ ^CLOUD_RELEASE_[A-Z0-9_]+$ ]] &&
    is_safe_remote_code "\${remote_code}"
}
${releaseBootstrapSignalScript()}
cleanup_artifacts() {
  cleanup_failed=0
  if [ -e "\${archive}" ] || [ -L "\${archive}" ]; then
    current_identity="$(stat -c '%d:%i' "\${archive}" 2>/dev/null)" || current_identity=""
    if [ -f "\${archive}" ] && [ ! -L "\${archive}" ] &&
      { [ -z "\${archive_identity}" ] || [ "\${current_identity}" = "\${archive_identity}" ]; }; then
      rm -f -- "\${archive}" >/dev/null 2>&1 || cleanup_failed=1
    elif [ -L "\${archive}" ]; then
      rm -f -- "\${archive}" >/dev/null 2>&1 || cleanup_failed=1
    else
      cleanup_failed=1
    fi
  fi
  if [ "\${staging_created}" -eq 1 ]; then
    current_identity="$(stat -c '%d:%i' "\${staging}" 2>/dev/null)" || current_identity=""
    if [ -d "\${staging}" ] && [ ! -L "\${staging}" ] &&
      [ "\${current_identity}" = "\${staging_identity}" ]; then
      rm -rf --one-file-system -- "\${staging}" >/dev/null 2>&1 || cleanup_failed=1
    elif [ -e "\${staging}" ] || [ -L "\${staging}" ]; then
      cleanup_failed=1
    fi
  fi
  if [ "\${capture_created}" -eq 1 ]; then
    current_identity="$(stat -c '%d:%i' "\${capture_dir}" 2>/dev/null)" || current_identity=""
    if [ -d "\${capture_dir}" ] && [ ! -L "\${capture_dir}" ] &&
      [ "\${current_identity}" = "\${capture_identity}" ]; then
      rm -rf --one-file-system -- "\${capture_dir}" >/dev/null 2>&1 || cleanup_failed=1
    elif [ -e "\${capture_dir}" ] || [ -L "\${capture_dir}" ]; then
      cleanup_failed=1
    fi
  fi
  return "\${cleanup_failed}"
}
on_exit() {
  status=$?
  trap - EXIT
  trap '' HUP INT TERM
  stop_session_watchdog
  { exec 6>&- 7>&-; } 2>/dev/null || true
  stop_reader "\${stdout_reader}" "\${stdout_reader_identity}"
  stop_reader "\${stderr_reader}" "\${stderr_reader_identity}"
  stdout_reader=""
  stdout_reader_identity=""
  stderr_reader=""
  stderr_reader_identity=""
  cleanup_status=0
  cleanup_artifacts || cleanup_status=$?
  if [ "\${status}" -eq 0 ]; then
    if [ "\${cleanup_status}" -ne 0 ]; then
      printf '%s\\n' CLOUD_RELEASE_BOOTSTRAP_CLEANUP_FAILED >&2
      exit 74
    fi
    if [ "\${success_output_ready}" -ne 1 ]; then
      printf '%s\\n' CLOUD_RELEASE_BOOTSTRAP_REMOTE_ENTRY_FAILED >&2
      exit 74
    fi
    if ! cat 2>/dev/null <&8; then
      printf '%s\\n' CLOUD_RELEASE_BOOTSTRAP_REMOTE_ENTRY_FAILED >&2
      exit 74
    fi
    exit 0
  fi
  final_error="\${bootstrap_error:-CLOUD_RELEASE_BOOTSTRAP_REMOTE_ENTRY_FAILED}"
  if [ "\${final_error}" != CLOUD_RELEASE_RECOVERY_REQUIRED ] &&
    [ "\${cleanup_status}" -ne 0 ]; then
    final_error=CLOUD_RELEASE_BOOTSTRAP_CLEANUP_FAILED
  fi
  printf '%s\\n' "\${final_error}" >&2
  exit "\${status}"
}
trap on_exit EXIT
handle_release_signals
{ exec 9>"\${lock}"; } 2>/dev/null || bootstrap_fail CLOUD_RELEASE_BOOTSTRAP_LOCK_FAILED
flock -n 9 2>/dev/null || { bootstrap_error=CLOUD_RELEASE_LOCKED; exit 73; }
test -f "\${archive}" && test ! -L "\${archive}" ||
  bootstrap_fail CLOUD_RELEASE_BOOTSTRAP_ARCHIVE_INVALID
archive_metadata="$(stat -c '%U:%G:%h:%d:%i' "\${archive}" 2>/dev/null)" ||
  bootstrap_fail CLOUD_RELEASE_BOOTSTRAP_ARCHIVE_INVALID
case "\${archive_metadata}" in
  (root:root:1:*) archive_identity="\${archive_metadata#root:root:1:}" ;;
  (*) bootstrap_fail CLOUD_RELEASE_BOOTSTRAP_ARCHIVE_INVALID ;;
esac
chmod 0600 "\${archive}" 2>/dev/null || bootstrap_fail CLOUD_RELEASE_BOOTSTRAP_ARCHIVE_INVALID
actual="$(sha256sum "\${archive}" 2>/dev/null | awk '{print $1}' 2>/dev/null)" ||
  bootstrap_fail CLOUD_RELEASE_BOOTSTRAP_ARCHIVE_INVALID
test "\${actual}" = "\${digest}" || bootstrap_fail CLOUD_RELEASE_BOOTSTRAP_ARCHIVE_DIGEST_MISMATCH
test ! -e "\${staging}" && test ! -L "\${staging}" ||
  bootstrap_fail CLOUD_RELEASE_BOOTSTRAP_STAGING_COLLISION
umask 022
mkdir -m 0755 -- "\${staging}" 2>/dev/null ||
  bootstrap_fail CLOUD_RELEASE_BOOTSTRAP_STAGING_CREATE_FAILED
staging_created=1
staging_identity="$(stat -c '%d:%i' "\${staging}" 2>/dev/null)" ||
  bootstrap_fail CLOUD_RELEASE_BOOTSTRAP_STAGING_CREATE_FAILED
tar --extract --file "\${archive}" --directory "\${staging}" --no-same-owner --no-same-permissions \
  2>/dev/null || bootstrap_fail CLOUD_RELEASE_BOOTSTRAP_EXTRACT_FAILED
umask 077
capture_dir="$(mktemp -d 2>/dev/null)" || bootstrap_fail CLOUD_RELEASE_BOOTSTRAP_REMOTE_ENTRY_FAILED
capture_created=1
capture_identity="$(stat -c '%d:%i' "\${capture_dir}" 2>/dev/null)" ||
  bootstrap_fail CLOUD_RELEASE_BOOTSTRAP_REMOTE_ENTRY_FAILED
start_session_watchdog
remote_stdout="\${capture_dir}/stdout"
remote_stderr="\${capture_dir}/stderr"
stdout_pipe="\${capture_dir}/stdout.pipe"
stderr_pipe="\${capture_dir}/stderr.pipe"
mkfifo -- "\${stdout_pipe}" "\${stderr_pipe}" 2>/dev/null ||
  bootstrap_fail CLOUD_RELEASE_BOOTSTRAP_REMOTE_ENTRY_FAILED
defer_release_signals
{ head -c 2097153 <"\${stdout_pipe}" >"\${remote_stdout}"; } 2>/dev/null &
stdout_reader=$!
stdout_reader_identity="$(read_process_identity "\${stdout_reader}")" || stdout_reader_identity=""
{ head -c 129 <"\${stderr_pipe}" >"\${remote_stderr}"; } 2>/dev/null &
stderr_reader=$!
stderr_reader_identity="$(read_process_identity "\${stderr_reader}")" || stderr_reader_identity=""
if [ -z "\${stdout_reader_identity}" ] || [ -z "\${stderr_reader_identity}" ]; then
  { exec 6>"\${stdout_pipe}" 7>"\${stderr_pipe}"; } 2>/dev/null || true
  { exec 6>&- 7>&-; } 2>/dev/null || true
  stop_reader "\${stdout_reader}" "\${stdout_reader_identity}"
  stop_reader "\${stderr_reader}" "\${stderr_reader_identity}"
  stdout_reader=""
  stdout_reader_identity=""
  stderr_reader=""
  stderr_reader_identity=""
  handle_release_signals
  bootstrap_fail CLOUD_RELEASE_BOOTSTRAP_REMOTE_ENTRY_FAILED
fi
{ exec 6>"\${stdout_pipe}" 7>"\${stderr_pipe}"; } 2>/dev/null ||
  bootstrap_fail CLOUD_RELEASE_BOOTSTRAP_REMOTE_ENTRY_FAILED
/opt/nodejs/bin/node "\${staging}/tools/cloud/hk-vps-release-remote.mjs" \
  --candidate-sha "\${candidate}" \
  --expected-current-sha "\${expected}" \
  --archive-sha256 "\${digest}" \
  --migration-head "\${migration_head}" \
  --release-token "\${token}" >&6 2>&7 &
remote_pid=$!
remote_identity="$(read_process_identity "\${remote_pid}")" || remote_identity=""
{ exec 6>&- 7>&-; } 2>/dev/null || signal_pending=TERM
handle_release_signals
if [ -n "\${signal_pending}" ]; then
  on_signal "\${signal_pending}"
fi
if wait "\${remote_pid}" 2>/dev/null; then
  remote_status=0
else
  remote_status=$?
fi
remote_pid=""
capture_failed=0
wait "\${stdout_reader}" 2>/dev/null || capture_failed=1
wait "\${stderr_reader}" 2>/dev/null || capture_failed=1
stdout_reader=""
stdout_reader_identity=""
stderr_reader=""
stderr_reader_identity=""
test "\${capture_failed}" -eq 0 || bootstrap_fail CLOUD_RELEASE_BOOTSTRAP_REMOTE_ENTRY_FAILED
if [ "\${remote_status}" -eq 0 ]; then
  test ! -s "\${remote_stderr}" || bootstrap_fail CLOUD_RELEASE_BOOTSTRAP_REMOTE_ENTRY_FAILED
  stdout_bytes="$(wc -c 2>/dev/null <"\${remote_stdout}")" ||
    bootstrap_fail CLOUD_RELEASE_BOOTSTRAP_REMOTE_ENTRY_FAILED
  test "\${stdout_bytes}" -le 2097152 ||
    bootstrap_fail CLOUD_RELEASE_BOOTSTRAP_REMOTE_ENTRY_FAILED
else
  if capture_remote_code; then
    bootstrap_error="\${remote_code}"
    exit "\${remote_status}"
  fi
  bootstrap_fail CLOUD_RELEASE_BOOTSTRAP_REMOTE_ENTRY_FAILED
fi
{ exec 8<"\${remote_stdout}"; } 2>/dev/null ||
  bootstrap_fail CLOUD_RELEASE_BOOTSTRAP_REMOTE_ENTRY_FAILED
success_output_ready=1
`;
}
