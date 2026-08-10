import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { isAbsolute } from "node:path";

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

const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const TOKEN_PATTERN = /^[0-9a-f]{32}$/u;
const MIGRATION_PATTERN = /^\d{4}_[a-z0-9_]+\.sql$/u;

export class CloudReleaseError extends Error {
  constructor(code, options) {
    super(code, options);
    this.name = "CloudReleaseError";
    this.code = code;
  }
}

export function fail(code, cause) {
  throw new CloudReleaseError(code, cause === undefined ? undefined : { cause });
}

export function requireSha(value, code = "CLOUD_RELEASE_SHA_INVALID") {
  if (typeof value !== "string" || !SHA_PATTERN.test(value)) fail(code);
  return value;
}

export function requireDigest(value) {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    fail("CLOUD_RELEASE_ARCHIVE_DIGEST_INVALID");
  }
  return value;
}

export function requireToken(value) {
  if (typeof value !== "string" || !TOKEN_PATTERN.test(value)) {
    fail("CLOUD_RELEASE_TOKEN_INVALID");
  }
  return value;
}

export function requireMigrationHead(value) {
  if (typeof value !== "string" || !MIGRATION_PATTERN.test(value)) {
    fail("CLOUD_RELEASE_MIGRATION_HEAD_INVALID");
  }
  return value;
}

export function incomingArchivePath(candidateSha, token) {
  return `/opt/laundry-desk.incoming-${requireSha(candidateSha)}-${requireToken(token)}.tar`;
}

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
    !/^\/opt\/laundry-desk\.incoming-[0-9a-f]{40}-[0-9a-f]{32}\.tar$/u.test(remotePath)
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

export async function sha256File(path) {
  return await new Promise((resolveHash, rejectHash) => {
    const hash = createHash("sha256");
    const input = createReadStream(path);
    input.on("error", rejectHash);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("end", () => resolveHash(hash.digest("hex")));
  });
}

export function releaseBootstrapScript() {
  return `set -euo pipefail
umask 077
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
exec 9>"\${lock}"
flock -n 9 || { echo CLOUD_RELEASE_LOCKED >&2; exit 73; }
cleanup() {
  rm -f -- "\${archive}"
  if [ -d "\${staging}" ]; then
    rm -rf --one-file-system -- "\${staging}"
  fi
}
trap cleanup EXIT HUP INT TERM
test -f "\${archive}" && test ! -L "\${archive}"
test "$(stat -c '%U:%G' "\${archive}")" = "root:root"
chmod 0600 "\${archive}"
actual="$(sha256sum "\${archive}" | awk '{print $1}')"
test "\${actual}" = "\${digest}"
test ! -e "\${staging}"
umask 022
mkdir -m 0755 -- "\${staging}"
tar --extract --file "\${archive}" --directory "\${staging}" --no-same-owner --no-same-permissions
/opt/nodejs/bin/node "\${staging}/tools/cloud/hk-vps-release-remote.mjs" \
  --candidate-sha "\${candidate}" \
  --expected-current-sha "\${expected}" \
  --archive-sha256 "\${digest}" \
  --migration-head "\${migration_head}" \
  --release-token "\${token}"
`;
}
