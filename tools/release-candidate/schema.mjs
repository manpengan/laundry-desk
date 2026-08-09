import { createHash, createPublicKey, sign, verify } from "node:crypto";

import {
  validateCounterManifestFields,
  validateRuntimeManifestFields,
} from "./product-manifest-schema.mjs";

export const RELEASE_DOMAIN = "laundry-desk/release-candidate/release/v1\n";
export const FIELD_DOMAIN = "laundry-desk/release-candidate/field/v1\n";
export const COUNTER_MANIFEST_DOMAIN = "laundry-desk/update-manifest/v1\n";
export const SHA256 = /^[0-9a-f]{64}$/u;
export const DIGEST = /^sha256:[0-9a-f]{64}$/u;
export const SEMVER = /^(?:0|[1-9]\d{0,12})\.(?:0|[1-9]\d{0,12})\.(?:0|[1-9]\d{0,12})$/u;
export const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/u;
const COUNTER_SIGNATURE = /^[A-Za-z0-9+/]{86}==$/u;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._()+-]{0,179}$/u;
const TEAM = /^[A-Z0-9]{10}$/u;

export function exactObject(value, keys, code) {
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

export function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => [key, sortJson(child)]),
  );
}

export function canonicalJson(value) {
  return JSON.stringify(sortJson(value));
}

export function authorityBytes(domain, authority) {
  return Buffer.from(`${domain}${canonicalJson(authority)}\n`, "utf8");
}

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function validFileDescriptor(value) {
  exactObject(value, ["path", "sha256", "size_bytes"], "RC_FILE_DESCRIPTOR_INVALID");
  if (
    typeof value.path !== "string" ||
    !SAFE_NAME.test(value.path.split("/").at(-1) ?? "") ||
    value.path.startsWith("/") ||
    value.path.split("/").some((part) => part === "" || part === "." || part === "..") ||
    !Number.isSafeInteger(value.size_bytes) ||
    value.size_bytes < 1 ||
    !SHA256.test(value.sha256)
  ) {
    throw new Error("RC_FILE_DESCRIPTOR_INVALID");
  }
  return value;
}

function validAppDescriptor(value) {
  exactObject(
    value,
    ["entry_count", "name", "path", "root_mode", "size_bytes", "tree_sha256"],
    "RC_APP_DESCRIPTOR_INVALID",
  );
  if (
    typeof value.name !== "string" ||
    !value.name.endsWith(".app") ||
    !SAFE_NAME.test(value.name) ||
    typeof value.path !== "string" ||
    !value.path.endsWith(`/${value.name}`) ||
    value.path.startsWith("/") ||
    value.path.split("/").some((part) => part === "" || part === "." || part === "..") ||
    !Number.isSafeInteger(value.entry_count) ||
    value.entry_count < 1 ||
    !Number.isSafeInteger(value.root_mode) ||
    value.root_mode < 0 ||
    value.root_mode > 0o7777 ||
    !Number.isSafeInteger(value.size_bytes) ||
    value.size_bytes < 1 ||
    !SHA256.test(value.tree_sha256)
  ) {
    throw new Error("RC_APP_DESCRIPTOR_INVALID");
  }
  return value;
}

function validProduct(value, kind, assurance, version) {
  const keyField = kind === "counter" ? "public_key_spki_sha256" : "public_key_raw_sha256";
  exactObject(
    value,
    ["app", "bundle_identifier", "dmg", "manifest", keyField, "team_identifier", "version", "zip"],
    "RC_PRODUCT_DESCRIPTOR_INVALID",
  );
  validAppDescriptor(value.app);
  validFileDescriptor(value.dmg);
  validFileDescriptor(value.zip);
  validFileDescriptor(value.manifest);
  const expectedIdentifier =
    kind === "counter" ? "com.laundry-desk.v2" : "com.laundry-desk.runtime";
  if (
    value.bundle_identifier !== expectedIdentifier ||
    value.version !== version ||
    !SHA256.test(value[keyField]) ||
    (assurance === "formal"
      ? !TEAM.test(value.team_identifier)
      : value.team_identifier !== "software_only")
  ) {
    throw new Error("RC_PRODUCT_DESCRIPTOR_INVALID");
  }
}

function validOci(value) {
  exactObject(value, ["digest", "index"], "RC_OCI_DESCRIPTOR_INVALID");
  validFileDescriptor(value.index);
  if (!DIGEST.test(value.digest) || value.index.sha256 !== value.digest.slice(7)) {
    throw new Error("RC_OCI_DESCRIPTOR_INVALID");
  }
}

export function validateReleaseAuthority(value) {
  exactObject(
    value,
    [
      "assurance",
      "counter",
      "git",
      "oci",
      "product_version",
      "real_container_transfer",
      "runtime",
      "schema_version",
      "verifier",
    ],
    "RC_RELEASE_AUTHORITY_INVALID",
  );
  if (
    value.schema_version !== 1 ||
    !["formal", "software_only"].includes(value.assurance) ||
    !SEMVER.test(value.product_version)
  ) {
    throw new Error("RC_RELEASE_AUTHORITY_INVALID");
  }
  exactObject(value.git, ["clean", "sha"], "RC_RELEASE_AUTHORITY_INVALID");
  if (value.git.clean !== true || !/^[0-9a-f]{40}$/u.test(value.git.sha)) {
    throw new Error("RC_RELEASE_AUTHORITY_INVALID");
  }
  validProduct(value.counter, "counter", value.assurance, value.product_version);
  validProduct(value.runtime, "runtime", value.assurance, value.product_version);
  exactObject(value.oci, ["postgres", "server"], "RC_RELEASE_AUTHORITY_INVALID");
  validOci(value.oci.server);
  validOci(value.oci.postgres);
  validFileDescriptor(value.real_container_transfer);
  exactObject(
    value.verifier,
    ["app", "bundle_identifier", "team_identifier", "version"],
    "RC_RELEASE_AUTHORITY_INVALID",
  );
  validAppDescriptor(value.verifier.app);
  if (
    value.verifier.bundle_identifier !== "com.laundry-desk.release-candidate-verifier" ||
    value.verifier.version !== value.product_version ||
    (value.assurance === "formal"
      ? value.verifier.team_identifier !== value.counter.team_identifier ||
        value.verifier.team_identifier !== value.runtime.team_identifier
      : value.verifier.team_identifier !== "software_only")
  ) {
    throw new Error("RC_RELEASE_AUTHORITY_INVALID");
  }
  return structuredClone(value);
}

export function validateFieldAuthority(value) {
  exactObject(
    value,
    [
      "assurance",
      "clean_second_mac",
      "git_sha",
      "product_version",
      "release_authority_sha256",
      "schema_version",
      "xp58",
    ],
    "RC_FIELD_AUTHORITY_INVALID",
  );
  validFileDescriptor(value.clean_second_mac);
  validFileDescriptor(value.xp58);
  if (
    value.schema_version !== 1 ||
    !["formal", "software_only"].includes(value.assurance) ||
    !/^[0-9a-f]{40}$/u.test(value.git_sha) ||
    !SEMVER.test(value.product_version) ||
    !SHA256.test(value.release_authority_sha256)
  ) {
    throw new Error("RC_FIELD_AUTHORITY_INVALID");
  }
  return structuredClone(value);
}

export function signAuthority(authority, domain, counterPrivateKey, runtimePrivateKey) {
  const bytes = authorityBytes(domain, authority);
  for (const key of [counterPrivateKey, runtimePrivateKey]) {
    if (key.type !== "private" || key.asymmetricKeyType !== "ed25519") {
      throw new Error("RC_SIGNING_KEY_INVALID");
    }
  }
  if (publicKeyDigest(counterPrivateKey) === publicKeyDigest(runtimePrivateKey)) {
    throw new Error("RC_EVIDENCE_KEYS_NOT_DISTINCT");
  }
  return Object.freeze({
    authority,
    counter_signature: sign(null, bytes, counterPrivateKey).toString("base64url"),
    runtime_signature: sign(null, bytes, runtimePrivateKey).toString("base64url"),
    schema_version: 1,
  });
}

export function validateEnvelope(value, validateAuthority, domain, counterKey, runtimeKey) {
  if (publicKeyDigest(counterKey) === publicKeyDigest(runtimeKey)) {
    throw new Error("RC_EVIDENCE_KEYS_NOT_DISTINCT");
  }
  exactObject(
    value,
    ["authority", "counter_signature", "runtime_signature", "schema_version"],
    "RC_EVIDENCE_ENVELOPE_INVALID",
  );
  if (
    value.schema_version !== 1 ||
    !SIGNATURE.test(value.counter_signature) ||
    !SIGNATURE.test(value.runtime_signature)
  ) {
    throw new Error("RC_EVIDENCE_ENVELOPE_INVALID");
  }
  const authority = validateAuthority(value.authority);
  const bytes = authorityBytes(domain, authority);
  if (
    !verify(null, bytes, counterKey, Buffer.from(value.counter_signature, "base64url")) ||
    !verify(null, bytes, runtimeKey, Buffer.from(value.runtime_signature, "base64url"))
  ) {
    throw new Error("RC_EVIDENCE_SIGNATURE_INVALID");
  }
  return authority;
}

export function validateCounterManifest(value, publicKey) {
  exactObject(value, ["authority", "signature"], "RC_COUNTER_MANIFEST_INVALID");
  const authority = exactObject(
    value.authority,
    [
      "artifacts",
      "channel",
      "contracts_major",
      "local_schema",
      "minimum_secure_version",
      "minimum_upgradable_version",
      "protocol_version",
      "published_at",
      "rollback",
      "version",
    ],
    "RC_COUNTER_MANIFEST_INVALID",
  );
  if (
    authority.protocol_version !== 1 ||
    !["beta", "stable", "lts"].includes(authority.channel) ||
    !SEMVER.test(authority.version) ||
    !ISO_UTC.test(authority.published_at) ||
    !Array.isArray(authority.artifacts) ||
    authority.artifacts.length !== 2 ||
    !COUNTER_SIGNATURE.test(value.signature)
  ) {
    throw new Error("RC_COUNTER_MANIFEST_INVALID");
  }
  validateCounterManifestFields(authority);
  const kinds = new Set();
  for (const artifact of authority.artifacts) {
    exactObject(artifact, ["kind", "name", "sha256", "size_bytes"], "RC_COUNTER_MANIFEST_INVALID");
    if (
      !["dmg", "zip"].includes(artifact.kind) ||
      !SAFE_NAME.test(artifact.name) ||
      !artifact.name.endsWith(`.${artifact.kind}`) ||
      !SHA256.test(artifact.sha256) ||
      !Number.isSafeInteger(artifact.size_bytes) ||
      artifact.size_bytes < 1 ||
      kinds.has(artifact.kind)
    ) {
      throw new Error("RC_COUNTER_MANIFEST_INVALID");
    }
    kinds.add(artifact.kind);
  }
  const bytes = Buffer.from(`${COUNTER_MANIFEST_DOMAIN}${canonicalJson(authority)}\n`, "utf8");
  if (!verify(null, bytes, publicKey, Buffer.from(value.signature, "base64"))) {
    throw new Error("RC_COUNTER_MANIFEST_SIGNATURE_INVALID");
  }
  return structuredClone(authority);
}

export function validateRuntimeManifest(value, publicKey) {
  exactObject(value, ["payload", "signature"], "RC_RUNTIME_MANIFEST_INVALID");
  const payload = value.payload;
  const base = [
    "compose_sha256",
    "contracts_major",
    "contracts_sha256",
    "database_schema_sha256",
    "maximum_compatible_schema",
    "migration_head",
    "migrations_sha256",
    "minimum_app_version",
    "postgres_image",
    "postgres_major",
    "product",
    "release",
    "rollback_target",
    "schema_version",
    "server_image",
    "server_version",
    "web_bundle_sha256",
  ];
  const keys =
    payload?.schema_version === 2 ? [...base, "lan_compose_sha256", "owner_spa_sha256"] : base;
  exactObject(payload, keys, "RC_RUNTIME_MANIFEST_INVALID");
  exactObject(
    payload.server_image,
    ["index", "linux_amd64", "linux_arm64"],
    "RC_RUNTIME_MANIFEST_INVALID",
  );
  validateRuntimeManifestFields(payload);
  if (
    ![1, 2].includes(payload.schema_version) ||
    payload.product !== "laundry-desk-runtime" ||
    !SEMVER.test(payload.release) ||
    payload.server_version !== payload.release ||
    payload.postgres_major !== 16 ||
    !DIGEST.test(payload.server_image.linux_amd64) ||
    !DIGEST.test(payload.server_image.linux_arm64) ||
    !/@sha256:[0-9a-f]{64}$/u.test(payload.server_image.index) ||
    !/@sha256:[0-9a-f]{64}$/u.test(payload.postgres_image) ||
    !SIGNATURE.test(value.signature)
  ) {
    throw new Error("RC_RUNTIME_MANIFEST_INVALID");
  }
  if (
    !verify(
      null,
      Buffer.from(canonicalJson(payload), "utf8"),
      publicKey,
      Buffer.from(value.signature, "base64url"),
    )
  ) {
    throw new Error("RC_RUNTIME_MANIFEST_SIGNATURE_INVALID");
  }
  return structuredClone(payload);
}

export function publicKeyDigest(key) {
  const publicKey = key.type === "public" ? key : createPublicKey(key);
  return sha256(publicKey.export({ format: "der", type: "spki" }));
}
