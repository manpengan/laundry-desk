import { readDataProtectionJsonFile } from "./hk-vps-data-protection-files.mjs";
import { fail } from "./hk-vps-release-core.mjs";

export const DATA_PROTECTION_OFFSITE_AUTHORITY_PATH =
  "/etc/laundry-desk/data-protection-offsite-authority.json";

const TARGET_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const REMOTE_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9:+/=_@.-]{7,255}$/u;
const MAXIMUM_AUTHORITY_AGE_MS = 366 * 24 * 60 * 60 * 1000;
const LOCAL_FAILURE_DOMAINS = new Set(["hk-vps", "hk-vps-cloud-test", "local", "localhost"]);

function exactKeys(value, expected) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === [...expected].sort().join(",")
  );
}

function timestamp(value) {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value ? parsed : null;
}

function mountHost(source, fstype) {
  let host;
  if (fstype === "cifs") host = /^\/\/([^/]+)\//u.exec(source)?.[1];
  else if (fstype === "fuse.sshfs") host = /^(?:[^@:/]+@)?(\[[^\]]+\]|[^:]+):\//u.exec(source)?.[1];
  else host = /^(\[[^\]]+\]|[^:]+):\//u.exec(source)?.[1];
  if (host === undefined) fail("CLOUD_DATA_OFFSITE_AUTHORITY_INVALID");
  return host.replace(/^\[|\]$/gu, "").toLowerCase();
}

function assertNonLocalSource(source, fstype) {
  const host = mountHost(source, fstype);
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "0.0.0.0" ||
    host === "::" ||
    host === "::1" ||
    /^127(?:\.\d{1,3}){3}$/u.test(host)
  ) {
    fail("CLOUD_DATA_OFFSITE_AUTHORITY_INVALID");
  }
}

export function parseDataProtectionOffsiteAuthority(value, now = new Date()) {
  if (
    !exactKeys(value, [
      "schema",
      "version",
      "target_id",
      "mount_source",
      "mount_fstype",
      "failure_domain",
      "remote_identity",
      "attested_at",
      "expires_at",
    ]) ||
    value.schema !== "laundry.cloud-data-protection.offsite-authority" ||
    value.version !== 1 ||
    !TARGET_ID.test(value.target_id) ||
    !new Set(["nfs4", "cifs", "fuse.sshfs"]).has(value.mount_fstype) ||
    typeof value.mount_source !== "string" ||
    value.mount_source.length < 3 ||
    value.mount_source.length > 512 ||
    value.mount_source.includes("\0") ||
    !TARGET_ID.test(value.failure_domain) ||
    LOCAL_FAILURE_DOMAINS.has(value.failure_domain) ||
    !REMOTE_IDENTITY.test(value.remote_identity) ||
    !(now instanceof Date) ||
    Number.isNaN(now.getTime())
  ) {
    fail("CLOUD_DATA_OFFSITE_AUTHORITY_INVALID");
  }
  const attestedAt = timestamp(value.attested_at);
  const expiresAt = timestamp(value.expires_at);
  if (
    attestedAt === null ||
    expiresAt === null ||
    attestedAt.getTime() > now.getTime() ||
    expiresAt.getTime() <= now.getTime() ||
    expiresAt.getTime() - attestedAt.getTime() > MAXIMUM_AUTHORITY_AGE_MS
  ) {
    fail("CLOUD_DATA_OFFSITE_AUTHORITY_INVALID");
  }
  assertNonLocalSource(value.mount_source, value.mount_fstype);
  return Object.freeze({ ...value });
}

export async function readDataProtectionOffsiteAuthority(options = {}) {
  const read = await (options.readJson ?? readDataProtectionJsonFile)(
    options.path ?? DATA_PROTECTION_OFFSITE_AUTHORITY_PATH,
    {
      identity: options.identity ?? Object.freeze({ uid: 0, gid: 0 }),
      code: "CLOUD_DATA_OFFSITE_AUTHORITY_INVALID",
    },
  );
  const authority = parseDataProtectionOffsiteAuthority(read.value, options.now ?? new Date());
  if (read.source !== `${JSON.stringify(authority)}\n`) {
    fail("CLOUD_DATA_OFFSITE_AUTHORITY_INVALID");
  }
  return authority;
}

export async function assertDataProtectionOffsiteAuthority(mount, targetId, options = {}) {
  const authority = await (options.readAuthority ?? readDataProtectionOffsiteAuthority)(options);
  if (
    authority.target_id !== targetId ||
    authority.mount_source !== mount.source ||
    authority.mount_fstype !== mount.fstype
  ) {
    fail("CLOUD_DATA_OFFSITE_AUTHORITY_INVALID");
  }
  return authority;
}
