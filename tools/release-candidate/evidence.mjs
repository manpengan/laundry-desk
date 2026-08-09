import { createPrivateKey, createPublicKey } from "node:crypto";
import { lstat } from "node:fs/promises";
import { basename, resolve } from "node:path";

import {
  DIGEST,
  SEMVER,
  exactObject,
  publicKeyDigest,
  sha256,
  validateCounterManifest,
  validateRuntimeManifest,
} from "./schema.mjs";
import { canonicalAbsolutePath, readBoundedRealFile, readStrictJson } from "./safe-io.mjs";
import { assertFormalStrings } from "./reports.mjs";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const RAW_KEY = /^[A-Za-z0-9_-]{43}$/u;

function exactOptionalObject(value, required, optional, code) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(code);
  const keys = Object.keys(value);
  if (
    required.some((key) => !keys.includes(key)) ||
    keys.some((key) => !required.includes(key) && !optional.includes(key))
  ) {
    throw new Error(code);
  }
  return value;
}

function sourceGroup(value, code) {
  exactObject(value, ["app", "dmg", "manifest", "zip"], code);
  for (const key of ["app", "dmg", "manifest", "zip"]) canonicalAbsolutePath(value[key], code);
  if (!value.app.endsWith(".app") || !value.dmg.endsWith(".dmg") || !value.zip.endsWith(".zip")) {
    throw new Error(code);
  }
  return Object.freeze({ ...value });
}

export function parseAssemblyInput(value) {
  exactObject(
    value,
    [
      "counter",
      "mode",
      "oci",
      "output_directory",
      "reports",
      "runtime",
      "schema_version",
      "testing_identity",
      "verifier_app",
    ],
    "RC_ASSEMBLY_INPUT_INVALID",
  );
  if (value.schema_version !== 1 || !["formal", "testing"].includes(value.mode)) {
    throw new Error("RC_ASSEMBLY_INPUT_INVALID");
  }
  canonicalAbsolutePath(value.output_directory, "RC_OUTPUT");
  canonicalAbsolutePath(value.verifier_app, "RC_VERIFIER_APP");
  if (!value.verifier_app.endsWith(".app")) throw new Error("RC_ASSEMBLY_INPUT_INVALID");
  exactObject(value.oci, ["postgres_index", "server_index"], "RC_ASSEMBLY_INPUT_INVALID");
  exactObject(
    value.reports,
    ["clean_second_mac", "real_container_transfer", "xp58"],
    "RC_ASSEMBLY_INPUT_INVALID",
  );
  for (const path of [...Object.values(value.oci), ...Object.values(value.reports)]) {
    canonicalAbsolutePath(path, "RC_ASSEMBLY_INPUT");
  }
  if (value.mode === "formal") {
    if (value.testing_identity !== null) throw new Error("RC_FORMAL_TEST_INPUT_FORBIDDEN");
  } else {
    exactObject(value.testing_identity, ["git_sha", "product_version"], "RC_TEST_IDENTITY_INVALID");
    if (
      !/^[0-9a-f]{40}$/u.test(value.testing_identity.git_sha) ||
      !SEMVER.test(value.testing_identity.product_version)
    ) {
      throw new Error("RC_TEST_IDENTITY_INVALID");
    }
  }
  return Object.freeze({
    ...value,
    counter: sourceGroup(value.counter, "RC_COUNTER_INPUT_INVALID"),
    runtime: sourceGroup(value.runtime, "RC_RUNTIME_INPUT_INVALID"),
  });
}

export async function loadCounterPublicKey(appPath) {
  const path = resolve(appPath, "Contents/Resources/update/update-public-key.pem");
  const bytes = await readBoundedRealFile(path, "RC_COUNTER_PUBLIC_KEY", 16 * 1024);
  const key = createPublicKey(bytes);
  if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") {
    throw new Error("RC_COUNTER_PUBLIC_KEY_INVALID");
  }
  return Object.freeze({ key, digest: publicKeyDigest(key) });
}

export async function loadRuntimePublicKey(appPath) {
  const path = resolve(appPath, "Contents/Resources/trusted-manifest-public-key.txt");
  const text = (await readBoundedRealFile(path, "RC_RUNTIME_PUBLIC_KEY", 16 * 1024))
    .toString("utf8")
    .trim();
  if (!RAW_KEY.test(text)) throw new Error("RC_RUNTIME_PUBLIC_KEY_INVALID");
  const raw = Buffer.from(text, "base64url");
  if (raw.length !== 32) throw new Error("RC_RUNTIME_PUBLIC_KEY_INVALID");
  const key = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
  return Object.freeze({ key, digest: sha256(raw) });
}

export async function loadPrivateKey(path, label) {
  const metadata = await lstat(path);
  if ((metadata.mode & 0o777) !== 0o600) throw new Error("RC_SIGNING_KEY_PERMISSIONS_INVALID");
  const bytes = await readBoundedRealFile(path, label, 16 * 1024);
  const key = createPrivateKey(bytes);
  if (key.type !== "private" || key.asymmetricKeyType !== "ed25519") {
    throw new Error("RC_SIGNING_KEY_INVALID");
  }
  return key;
}

export function assertKeyPair(privateKey, publicKey, code) {
  const derived = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  const supplied = publicKey.export({ format: "der", type: "spki" });
  if (!derived.equals(supplied)) throw new Error(code);
}

export async function loadProductManifests(input, keys) {
  const [counter, runtime] = await Promise.all([
    readStrictJson(input.counter.manifest, "RC_COUNTER_MANIFEST"),
    readStrictJson(input.runtime.manifest, "RC_RUNTIME_MANIFEST"),
  ]);
  return Object.freeze({
    counter: validateCounterManifest(counter.value, keys.counter.key),
    runtime: validateRuntimeManifest(runtime.value, keys.runtime.key),
  });
}

function validateOciPlatform(value) {
  exactOptionalObject(
    value,
    ["architecture", "os"],
    ["os.features", "os.version", "variant"],
    "RC_OCI_INDEX_INVALID",
  );
  if (
    typeof value.architecture !== "string" ||
    typeof value.os !== "string" ||
    !/^[a-z0-9][a-z0-9._-]{0,31}$/u.test(value.architecture) ||
    !/^[a-z0-9][a-z0-9._-]{0,31}$/u.test(value.os)
  ) {
    throw new Error("RC_OCI_INDEX_INVALID");
  }
}

function validateStringMap(value) {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length > 128 ||
    Object.entries(value).some(
      ([key, child]) =>
        !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/u.test(key) ||
        typeof child !== "string" ||
        Buffer.byteLength(child, "utf8") > 4096,
    )
  ) {
    throw new Error("RC_OCI_INDEX_INVALID");
  }
}

function validateOciDescriptor(value) {
  exactOptionalObject(
    value,
    ["digest", "mediaType", "size"],
    ["annotations", "artifactType", "data", "platform", "urls"],
    "RC_OCI_INDEX_INVALID",
  );
  if (
    !DIGEST.test(value.digest) ||
    typeof value.mediaType !== "string" ||
    !value.mediaType.startsWith("application/vnd.") ||
    !Number.isSafeInteger(value.size) ||
    value.size < 1 ||
    value.size > 8 * 1024 * 1024 * 1024
  ) {
    throw new Error("RC_OCI_INDEX_INVALID");
  }
  if (value.platform !== undefined) validateOciPlatform(value.platform);
  if (value.annotations !== undefined) validateStringMap(value.annotations);
  if (
    value.urls !== undefined &&
    (!Array.isArray(value.urls) ||
      value.urls.length > 32 ||
      value.urls.some((url) => typeof url !== "string" || Buffer.byteLength(url, "utf8") > 2048))
  ) {
    throw new Error("RC_OCI_INDEX_INVALID");
  }
}

export async function loadOciIndex(path, expectedDigest, expectedPlatforms) {
  const { bytes, value } = await readStrictJson(path, "RC_OCI_INDEX", 8 * 1024 * 1024);
  if (`sha256:${sha256(bytes)}` !== expectedDigest) throw new Error("RC_OCI_INDEX_DIGEST_MISMATCH");
  exactOptionalObject(
    value,
    ["manifests", "schemaVersion"],
    ["annotations", "artifactType", "mediaType", "subject"],
    "RC_OCI_INDEX_INVALID",
  );
  if (
    value.schemaVersion !== 2 ||
    !Array.isArray(value.manifests) ||
    value.manifests.length < 2 ||
    value.manifests.length > 256
  ) {
    throw new Error("RC_OCI_INDEX_INVALID");
  }
  if (value.annotations !== undefined) validateStringMap(value.annotations);
  for (const descriptor of value.manifests) validateOciDescriptor(descriptor);
  for (const [architecture, digest] of Object.entries(expectedPlatforms)) {
    const matching = value.manifests.filter(
      (entry) => entry.platform?.os === "linux" && entry.platform.architecture === architecture,
    );
    if (matching.length !== 1 || (digest !== null && matching[0].digest !== digest)) {
      throw new Error("RC_OCI_PLATFORM_MISMATCH");
    }
  }
  return Object.freeze({ bytes, value });
}

export function manifestDigests(manifests) {
  const serverDigest = manifests.runtime.server_image.index.match(/@(sha256:[0-9a-f]{64})$/u)?.[1];
  const postgresDigest = manifests.runtime.postgres_image.match(/@(sha256:[0-9a-f]{64})$/u)?.[1];
  if (serverDigest === undefined || postgresDigest === undefined)
    throw new Error("RC_RUNTIME_MANIFEST_INVALID");
  return Object.freeze({ serverDigest, postgresDigest });
}

export function validateManifestRelease(manifests, version, formal) {
  if (manifests.counter.version !== version || manifests.runtime.release !== version) {
    throw new Error("RC_PRODUCT_VERSION_MISMATCH");
  }
  if (formal && !["stable", "lts"].includes(manifests.counter.channel)) {
    throw new Error("RC_FORMAL_CHANNEL_INVALID");
  }
  if (formal) assertFormalStrings(manifests);
}

export function validateCounterArtifacts(authority, artifacts) {
  for (const kind of ["dmg", "zip"]) {
    const expected = authority.artifacts.find((entry) => entry.kind === kind);
    const actual = artifacts[kind];
    if (
      expected === undefined ||
      expected.name !== basename(actual.path) ||
      expected.sha256 !== actual.sha256 ||
      expected.size_bytes !== actual.size_bytes
    ) {
      throw new Error("RC_COUNTER_ARTIFACT_MISMATCH");
    }
  }
}
