import { constants } from "node:fs";
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { lstat, open, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const BASE_PAYLOAD_KEYS = Object.freeze([
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
]);
const V2_PAYLOAD_KEYS = Object.freeze([
  ...BASE_PAYLOAD_KEYS,
  "lan_compose_sha256",
  "owner_spa_sha256",
]);
const SERVER_IMAGE_KEYS = Object.freeze(["index", "linux_amd64", "linux_arm64"]);
const ROLLBACK_KEYS = Object.freeze(["maximum_compatible_schema", "release", "server_image_index"]);
const SHA256 = /^[0-9a-f]{64}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const DIGEST_REFERENCE =
  /^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*\/)+[a-z0-9]+(?:[._-][a-z0-9]+)*@sha256:[0-9a-f]{64}$/u;
const MIGRATION = /^[0-9]{4}_[a-z0-9_]+\.sql$/u;
const SEMVER =
  /^(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})(?:-[0-9A-Za-z.-]{1,64})?$/u;
const RAW_PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/u;
const MAX_INPUT_BYTES = 65_536;
const MAX_KEY_BYTES = 16_384;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function exactKeys(value, expected) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort())
  );
}

function compareVersions(left, right) {
  const lhs = left.split(/[.-]/u).slice(0, 3).map(Number);
  const rhs = right.split(/[.-]/u).slice(0, 3).map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (lhs[index] ?? 0) - (rhs[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function migrationNumber(value) {
  return Number(value.slice(0, 4));
}

export function validateRuntimeManifestPayload(value) {
  const schemaVersion = value?.schema_version;
  const expectedKeys = schemaVersion === 1 ? BASE_PAYLOAD_KEYS : V2_PAYLOAD_KEYS;
  if ((schemaVersion !== 1 && schemaVersion !== 2) || !exactKeys(value, expectedKeys)) {
    throw new Error("RUNTIME_MANIFEST_INPUT_INVALID");
  }
  const payload = value;
  if (
    payload.product !== "laundry-desk-runtime" ||
    !SEMVER.test(payload.release) ||
    payload.server_version !== payload.release ||
    !Number.isSafeInteger(payload.contracts_major) ||
    payload.contracts_major <= 0 ||
    !SHA256.test(payload.contracts_sha256) ||
    !SHA256.test(payload.web_bundle_sha256) ||
    !SEMVER.test(payload.minimum_app_version) ||
    !SHA256.test(payload.database_schema_sha256) ||
    !SHA256.test(payload.migrations_sha256) ||
    !MIGRATION.test(payload.migration_head) ||
    !MIGRATION.test(payload.maximum_compatible_schema) ||
    migrationNumber(payload.maximum_compatible_schema) < migrationNumber(payload.migration_head) ||
    !SHA256.test(payload.compose_sha256) ||
    payload.postgres_major !== 16 ||
    !DIGEST_REFERENCE.test(payload.postgres_image) ||
    !exactKeys(payload.server_image, SERVER_IMAGE_KEYS) ||
    !DIGEST_REFERENCE.test(payload.server_image.index) ||
    !DIGEST.test(payload.server_image.linux_arm64) ||
    !DIGEST.test(payload.server_image.linux_amd64)
  ) {
    throw new Error("RUNTIME_MANIFEST_INPUT_INVALID");
  }
  if (
    schemaVersion === 2 &&
    (!SHA256.test(payload.lan_compose_sha256) || !SHA256.test(payload.owner_spa_sha256))
  ) {
    throw new Error("RUNTIME_MANIFEST_INPUT_INVALID");
  }
  if (payload.rollback_target !== null) {
    const rollback = payload.rollback_target;
    if (
      !exactKeys(rollback, ROLLBACK_KEYS) ||
      !SEMVER.test(rollback.release) ||
      compareVersions(rollback.release, payload.release) >= 0 ||
      !DIGEST_REFERENCE.test(rollback.server_image_index) ||
      !MIGRATION.test(rollback.maximum_compatible_schema) ||
      migrationNumber(rollback.maximum_compatible_schema) < migrationNumber(payload.migration_head)
    ) {
      throw new Error("RUNTIME_MANIFEST_INPUT_INVALID");
    }
  }
  return structuredClone(payload);
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => [key, sortJson(child)]),
  );
}

export function canonicalizeRuntimeManifestPayload(value) {
  return Buffer.from(JSON.stringify(sortJson(validateRuntimeManifestPayload(value))), "utf8");
}

function publicKeyFromRaw(text) {
  const trimmed = text.trim();
  if (!RAW_PUBLIC_KEY.test(trimmed)) throw new Error("RUNTIME_MANIFEST_PUBLIC_KEY_INVALID");
  const raw = Buffer.from(trimmed, "base64url");
  if (raw.length !== 32) throw new Error("RUNTIME_MANIFEST_PUBLIC_KEY_INVALID");
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
}

export function signRuntimeManifestPayload(value, privateKey, publicKey) {
  if (privateKey.type !== "private" || privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("RUNTIME_MANIFEST_PRIVATE_KEY_INVALID");
  }
  if (publicKey.type !== "public" || publicKey.asymmetricKeyType !== "ed25519") {
    throw new Error("RUNTIME_MANIFEST_PUBLIC_KEY_INVALID");
  }
  const derived = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  const supplied = publicKey.export({ format: "der", type: "spki" });
  if (!derived.equals(supplied)) throw new Error("RUNTIME_MANIFEST_KEY_PAIR_MISMATCH");
  const parsed = validateRuntimeManifestPayload(value);
  const payload = Object.freeze({
    ...parsed,
    server_image: Object.freeze({ ...parsed.server_image }),
    rollback_target:
      parsed.rollback_target === null ? null : Object.freeze({ ...parsed.rollback_target }),
  });
  const canonical = canonicalizeRuntimeManifestPayload(payload);
  const signature = sign(null, canonical, privateKey).toString("base64url");
  if (!verify(null, canonical, publicKey, Buffer.from(signature, "base64url"))) {
    throw new Error("RUNTIME_MANIFEST_SIGNATURE_INVALID");
  }
  return Object.freeze({ payload, signature });
}

async function readBoundedRealFile(path, label, maximumBytes) {
  if (!isAbsolute(path) || resolve(path) !== path)
    throw new Error(`${label} path must be canonical`);
  const metadata = await lstat(path, { bigint: true });
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1n ||
    metadata.size < 1n ||
    metadata.size > BigInt(maximumBytes) ||
    (metadata.mode & 0o777n) !== 0o600n
  ) {
    throw new Error(`${label} must be a bounded 0600 single-link real file`);
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const unchanged = (candidate) =>
      candidate.isFile() &&
      candidate.dev === metadata.dev &&
      candidate.ino === metadata.ino &&
      candidate.mode === metadata.mode &&
      candidate.nlink === metadata.nlink &&
      candidate.size === metadata.size &&
      candidate.ctimeNs === metadata.ctimeNs &&
      candidate.mtimeNs === metadata.mtimeNs;
    const opened = await handle.stat({ bigint: true });
    if (!unchanged(opened)) {
      throw new Error(`${label} changed while opening`);
    }
    const bytes = await handle.readFile();
    const afterRead = await handle.stat({ bigint: true });
    const afterPath = await lstat(path, { bigint: true });
    if (!unchanged(afterRead) || !unchanged(afterPath)) {
      throw new Error(`${label} changed while reading`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function requiredPath(env, key) {
  const value = env[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${key} is required`);
  if (!isAbsolute(value) || resolve(value) !== value) throw new Error(`${key} must be canonical`);
  return value;
}

export async function generateRuntimeManifest(env) {
  const inputPath = requiredPath(env, "LAUNDRY_RUNTIME_MANIFEST_INPUT_FILE");
  const privateKeyPath = requiredPath(env, "LAUNDRY_RUNTIME_MANIFEST_PRIVATE_KEY_FILE");
  const publicKeyPath = requiredPath(env, "LAUNDRY_RUNTIME_MANIFEST_PUBLIC_KEY_FILE");
  const outputPath = requiredPath(env, "LAUNDRY_RUNTIME_MANIFEST_OUTPUT_FILE");
  const [inputBytes, privateBytes, publicBytes] = await Promise.all([
    readBoundedRealFile(inputPath, "runtime manifest input", MAX_INPUT_BYTES),
    readBoundedRealFile(privateKeyPath, "runtime manifest private key", MAX_KEY_BYTES),
    readBoundedRealFile(publicKeyPath, "runtime manifest public key", MAX_KEY_BYTES),
  ]);
  let input;
  try {
    input = JSON.parse(inputBytes.toString("utf8"));
  } catch {
    throw new Error("RUNTIME_MANIFEST_INPUT_INVALID");
  }
  const privateKey = createPrivateKey(privateBytes);
  const publicKey = publicKeyFromRaw(publicBytes.toString("utf8"));
  const manifest = signRuntimeManifestPayload(input, privateKey, publicKey);
  await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: "wx",
    mode: 0o644,
  });
  return Object.freeze({ outputPath, manifest });
}

async function main() {
  if (process.argv.length !== 2) throw new Error("RUNTIME_MANIFEST_ARGS_INVALID");
  const result = await generateRuntimeManifest(process.env);
  process.stdout.write(`${JSON.stringify({ ok: true, manifest: result.outputPath })}\n`);
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && pathToFileURL(resolve(invokedPath)).href === import.meta.url) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : "runtime manifest generation failed";
    process.stderr.write(`[runtime-manifest] ${message}\n`);
    process.exitCode = 1;
  });
}
