const SHA256 = /^[0-9a-f]{64}$/u;
const SEMVER = /^(?:0|[1-9]\d{0,12})\.(?:0|[1-9]\d{0,12})\.(?:0|[1-9]\d{0,12})$/u;

function exactObject(value, keys, code) {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())
  ) {
    throw new Error(code);
  }
  return value;
}

const nonnegativeInteger = (value) => Number.isSafeInteger(value) && value >= 0;

export function validateCounterManifestFields(authority) {
  const code = "RC_COUNTER_MANIFEST_INVALID";
  if (
    !SEMVER.test(authority.minimum_secure_version) ||
    !SEMVER.test(authority.minimum_upgradable_version) ||
    !nonnegativeInteger(authority.contracts_major) ||
    !nonnegativeInteger(authority.local_schema)
  ) {
    throw new Error(code);
  }
  if (authority.rollback !== null) {
    const rollback = exactObject(
      authority.rollback,
      ["artifact_sha256", "max_compatible_local_schema", "target_version"],
      code,
    );
    if (
      !SHA256.test(rollback.artifact_sha256) ||
      !nonnegativeInteger(rollback.max_compatible_local_schema) ||
      !SEMVER.test(rollback.target_version)
    ) {
      throw new Error(code);
    }
  }
}

export function validateRuntimeManifestFields(payload) {
  const hashes = [
    "compose_sha256",
    "contracts_sha256",
    "database_schema_sha256",
    "migrations_sha256",
    "web_bundle_sha256",
  ];
  if (payload.schema_version === 2) hashes.push("lan_compose_sha256", "owner_spa_sha256");
  if (
    !Number.isSafeInteger(payload.contracts_major) ||
    payload.contracts_major <= 0 ||
    hashes.some((name) => !SHA256.test(payload[name]))
  ) {
    throw new Error("RC_RUNTIME_MANIFEST_INVALID");
  }
}
