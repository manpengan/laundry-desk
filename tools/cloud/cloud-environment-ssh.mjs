import { isAbsolute } from "node:path";

import {
  DEFAULT_CLOUD_ENVIRONMENT_PROFILE,
  requireCloudEnvironmentProfile,
} from "./cloud-environment-profile.mjs";
import { fail } from "./hk-vps-release-identifiers.mjs";

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

export function sshArguments(
  arguments_,
  knownHostsPath,
  profileInput = DEFAULT_CLOUD_ENVIRONMENT_PROFILE,
) {
  const profile = requireCloudEnvironmentProfile(profileInput);
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
    profile.ssh.alias,
    ...arguments_,
  ]);
}

function isRemoteArchivePath(value, profile) {
  const suffix = /^[0-9a-f]{40}-[0-9a-f]{32}\.tar$/u;
  const prefixes = [
    `${profile.paths.liveRoot}.incoming-`,
    `${profile.paths.maintenanceRoot}/incoming-`,
  ];
  return prefixes.some(
    (prefix) => value.startsWith(prefix) && suffix.test(value.slice(prefix.length)),
  );
}

export function scpArguments(
  sourcePath,
  remotePath,
  knownHostsPath,
  profileInput = DEFAULT_CLOUD_ENVIRONMENT_PROFILE,
) {
  const profile = requireCloudEnvironmentProfile(profileInput);
  if (typeof sourcePath !== "string" || !isAbsolute(sourcePath) || sourcePath.includes("\0")) {
    fail("CLOUD_RELEASE_ARCHIVE_PATH_INVALID");
  }
  if (typeof remotePath !== "string" || !isRemoteArchivePath(remotePath, profile)) {
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
    `${profile.ssh.alias}:${remotePath}`,
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

export function assertPinnedSshConfig(source, profileInput = DEFAULT_CLOUD_ENVIRONMENT_PROFILE) {
  const profile = requireCloudEnvironmentProfile(profileInput);
  const config = parseSshConfig(source);
  const identity = config.get("identityfile");
  if (
    config.get("hostname") !== profile.ssh.host ||
    config.get("user") !== profile.ssh.user ||
    config.get("port") !== profile.ssh.port ||
    config.get("passwordauthentication") !== "no" ||
    config.get("kbdinteractiveauthentication") !== "no" ||
    (config.has("proxycommand") && config.get("proxycommand") !== "none") ||
    (config.has("proxyjump") && config.get("proxyjump") !== "none") ||
    config.has("hostkeyalias") ||
    typeof identity !== "string" ||
    !identity.endsWith(profile.ssh.identitySuffix)
  ) {
    fail("CLOUD_RELEASE_SSH_CONFIG_INVALID");
  }
}
