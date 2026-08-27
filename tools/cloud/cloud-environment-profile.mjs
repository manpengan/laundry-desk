import { isAbsolute, normalize } from "node:path";

import { fail } from "./hk-vps-release-identifiers.mjs";

const PROFILE_ERROR = "CLOUD_ENVIRONMENT_PROFILE_INVALID";
const SAFE_NAME = /^[a-z0-9][a-z0-9-]{2,63}$/u;
const SAFE_PATH = /^\/[A-Za-z0-9._/-]+$/u;

function requireUrl(value, protocol) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch (error) {
    fail(PROFILE_ERROR, error);
  }
  if (
    parsed.protocol !== protocol ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    fail(PROFILE_ERROR);
  }
  return parsed;
}

function assertProfile(profile) {
  const { endpoints, markers, paths, services, ssh } = profile;
  const deskPublic = requireUrl(endpoints.deskPublicOrigin, "https:");
  const deskLoopback = requireUrl(endpoints.deskLoopbackOrigin, "http:");
  const kbPublic = requireUrl(endpoints.kbPublicHealthUrl, "https:");
  const kbLoopback = requireUrl(endpoints.kbLoopbackHealthUrl, "http:");
  if (
    !SAFE_NAME.test(profile.name) ||
    profile.environmentMarker !== profile.name ||
    profile.dataPolicy !== "synthetic-only" ||
    deskPublic.origin !== endpoints.deskPublicOrigin ||
    deskPublic.hostname !== endpoints.deskTlsServerName ||
    deskLoopback.origin !== endpoints.deskLoopbackOrigin ||
    deskLoopback.hostname !== "127.0.0.1" ||
    Number(deskLoopback.port) !== services.deskPort ||
    kbPublic.hostname !== endpoints.kbTlsServerName ||
    kbPublic.pathname !== "/healthz" ||
    kbLoopback.hostname !== "127.0.0.1" ||
    kbLoopback.pathname !== "/healthz" ||
    Number(kbLoopback.port) !== services.kbPort ||
    !SAFE_NAME.test(ssh.alias) ||
    !/^[A-Za-z0-9.-]+$/u.test(ssh.host) ||
    !/^[A-Za-z_][A-Za-z0-9_-]{0,31}$/u.test(ssh.user) ||
    !/^\d{1,5}$/u.test(ssh.port) ||
    Number(ssh.port) < 1 ||
    Number(ssh.port) > 65_535 ||
    !SAFE_PATH.test(ssh.identitySuffix) ||
    !/^SHA256:[A-Za-z0-9+/]+$/u.test(ssh.ed25519Fingerprint) ||
    !Number.isSafeInteger(services.postgresPort) ||
    services.postgresPort < 1 ||
    services.postgresPort > 65_535 ||
    !/^[a-z0-9_]{1,63}$/u.test(services.postgresDatabase) ||
    [services.caddy, services.desk, services.kb, services.postgres].some(
      (service) => typeof service !== "string" || !/^[a-z0-9@_.-]+\.service$/u.test(service),
    ) ||
    !/^[A-Za-z0-9._-]+$/u.test(markers.offsiteStoreFile) ||
    !/^[A-Za-z0-9._-]+$/u.test(markers.photoStoreFile) ||
    typeof markers.photoStoreContent !== "string" ||
    !markers.photoStoreContent.endsWith("\n") ||
    Object.values(paths).some(
      (path) =>
        typeof path !== "string" ||
        !isAbsolute(path) ||
        !SAFE_PATH.test(path) ||
        normalize(path) !== path,
    )
  ) {
    fail(PROFILE_ERROR);
  }
}

function createProfile(input) {
  const profile = Object.freeze({
    dataPolicy: input.dataPolicy,
    endpoints: Object.freeze({ ...input.endpoints }),
    environmentMarker: input.environmentMarker,
    markers: Object.freeze({ ...input.markers }),
    name: input.name,
    paths: Object.freeze({ ...input.paths }),
    services: Object.freeze({ ...input.services }),
    ssh: Object.freeze({ ...input.ssh }),
  });
  assertProfile(profile);
  return profile;
}

const HK_VPS_CLOUD_TEST = createProfile({
  dataPolicy: "synthetic-only",
  endpoints: {
    deskLoopbackOrigin: "http://127.0.0.1:8787",
    deskPublicOrigin: "https://desk.manpengan.xyz",
    deskTlsServerName: "desk.manpengan.xyz",
    kbLoopbackHealthUrl: "http://127.0.0.1:8700/healthz",
    kbPublicHealthUrl: "https://kb.manpengan.xyz/healthz",
    kbTlsServerName: "kb.manpengan.xyz",
  },
  environmentMarker: "hk-vps-cloud-test",
  markers: {
    offsiteStoreFile: ".laundry-offsite-store-v1",
    photoStoreContent: "laundry-desk-photo-store:v1\n",
    photoStoreFile: ".laundry-photo-store-v1",
  },
  name: "hk-vps-cloud-test",
  paths: {
    acceptanceEnvironmentFile: "/etc/laundry-desk/adr36-acceptance.env",
    acceptanceSecretRoot: "/etc/laundry-desk/acceptance-secrets",
    archiveRoot: "/var/lib/laundry-desk-release-archive",
    controllerRoot: "/var/lib/laundry-desk-release-controllers",
    dataProtectionAuthorityFile: "/etc/laundry-desk/data-protection-offsite-authority.json",
    dataProtectionOffsiteRoot: "/mnt/laundry-desk-offsite",
    dataProtectionPhotoRoot: "/var/lib/laundry/photos",
    dataProtectionRoot: "/var/lib/laundry-desk-data-protection",
    liveRoot: "/opt/laundry-desk",
    maintenanceRoot: "/var/lib/laundry-desk-release-maintenance",
    nodeExecutable: "/opt/nodejs/bin/node",
    releaseBackupRoot: "/var/lib/laundry-desk-release-backups",
    releaseLock: "/run/lock/laundry-desk-cloud-release.lock",
    releaseStateRoot: "/var/lib/laundry-desk-release",
    serverEnvironmentFile: "/etc/laundry-desk/server.env",
  },
  services: {
    caddy: "caddy.service",
    desk: "laundry-desk.service",
    deskPort: 8787,
    kb: "kb-web.service",
    kbPort: 8700,
    postgres: "postgresql.service",
    postgresDatabase: "laundry_v2",
    postgresPort: 5432,
  },
  ssh: {
    alias: "hk-vps",
    ed25519Fingerprint: "SHA256:Urp+pKpu/XD45nZlT+1tYJ5VYmV5X0fXStu+zmQjv4A",
    host: "103.233.252.201",
    identitySuffix: "/.ssh/hk_vps_ed25519",
    port: "22",
    user: "root",
  },
});

const PROFILES = new Map([[HK_VPS_CLOUD_TEST.name, HK_VPS_CLOUD_TEST]]);

export const CLOUD_ENVIRONMENT_PROFILE_NAMES = Object.freeze([...PROFILES.keys()]);
export const DEFAULT_CLOUD_ENVIRONMENT_PROFILE = HK_VPS_CLOUD_TEST;

export function resolveCloudEnvironmentProfile(name = DEFAULT_CLOUD_ENVIRONMENT_PROFILE.name) {
  if (typeof name !== "string" || !SAFE_NAME.test(name)) fail(PROFILE_ERROR);
  const profile = PROFILES.get(name);
  if (profile === undefined) fail(PROFILE_ERROR);
  return profile;
}

export function requireCloudEnvironmentProfile(value) {
  if (value === undefined) return DEFAULT_CLOUD_ENVIRONMENT_PROFILE;
  if (typeof value === "string") return resolveCloudEnvironmentProfile(value);
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(PROFILE_ERROR);
  const profile = PROFILES.get(value.name);
  if (profile !== value) fail(PROFILE_ERROR);
  return profile;
}

export const HK_VPS_ALIAS = HK_VPS_CLOUD_TEST.ssh.alias;
export const HK_VPS_HOST = HK_VPS_CLOUD_TEST.ssh.host;
export const HK_VPS_USER = HK_VPS_CLOUD_TEST.ssh.user;
export const HK_VPS_PORT = HK_VPS_CLOUD_TEST.ssh.port;
export const HK_VPS_IDENTITY_SUFFIX = HK_VPS_CLOUD_TEST.ssh.identitySuffix;
export const HK_VPS_ED25519_FINGERPRINT = HK_VPS_CLOUD_TEST.ssh.ed25519Fingerprint;
export const PUBLIC_ORIGIN = HK_VPS_CLOUD_TEST.endpoints.deskPublicOrigin;
export const DESK_LOOPBACK_ORIGIN = HK_VPS_CLOUD_TEST.endpoints.deskLoopbackOrigin;
export const KB_HEALTH_URL = HK_VPS_CLOUD_TEST.endpoints.kbPublicHealthUrl;
export const KB_LOOPBACK_HEALTH_URL = HK_VPS_CLOUD_TEST.endpoints.kbLoopbackHealthUrl;
export const REMOTE_RELEASE_LOCK = HK_VPS_CLOUD_TEST.paths.releaseLock;
