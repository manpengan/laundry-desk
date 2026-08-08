import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { lstat, mkdir, open, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describeCanonicalAppTree } from "./release-tree.mjs";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function parseReleaseUpdateConfiguration(bytes) {
  let candidate;
  try {
    candidate = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("update configuration must be valid JSON");
  }
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate) ||
    JSON.stringify(Object.keys(candidate).sort()) !==
      JSON.stringify(["channel", "enabled", "manifest_url", "schema_version"]) ||
    candidate.schema_version !== 1 ||
    candidate.enabled !== true ||
    !["beta", "stable", "lts"].includes(candidate.channel) ||
    typeof candidate.manifest_url !== "string" ||
    candidate.manifest_url.length > 2_048
  ) {
    throw new Error("release update configuration is invalid");
  }
  let url;
  try {
    url = new URL(candidate.manifest_url);
  } catch {
    throw new Error("release update configuration is invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hostname.length === 0 ||
    url.search !== "" ||
    url.hash !== "" ||
    !url.pathname.endsWith("/latest-laundry-v2.json") ||
    url.hostname === "example" ||
    url.hostname.endsWith(".example") ||
    url.toString() !== candidate.manifest_url
  ) {
    throw new Error("release update configuration is invalid");
  }
  return Object.freeze({ ...candidate });
}

function releasePolicyChannel(bytes) {
  let candidate;
  try {
    candidate = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("release policy must be valid JSON");
  }
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate) ||
    !["beta", "stable", "lts"].includes(candidate.channel)
  ) {
    throw new Error("release policy channel is invalid");
  }
  return candidate.channel;
}

function validInputMetadata(metadata, maximumBytes, requiredMode) {
  return (
    metadata.isFile() &&
    !metadata.isSymbolicLink() &&
    metadata.nlink === 1 &&
    metadata.size >= 1 &&
    metadata.size <= maximumBytes &&
    (metadata.mode & 0o777) === requiredMode
  );
}

function sameInputSnapshot(left, right) {
  return ["dev", "ino", "size", "mode", "nlink", "mtimeMs", "ctimeMs"].every(
    (key) => left[key] === right[key],
  );
}

export async function readReleaseInputFile(
  path,
  label,
  maximumBytes,
  { requiredMode = 0o600, afterOpen } = {},
) {
  const metadata = await lstat(path);
  if (!validInputMetadata(metadata, maximumBytes, requiredMode))
    throw new Error(`${label} must be one bounded ${requiredMode.toString(8)} file`);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (
      !validInputMetadata(opened, maximumBytes, requiredMode) ||
      !sameInputSnapshot(metadata, opened)
    ) {
      throw new Error(`${label} changed while opening`);
    }
    await afterOpen?.();
    const bytes = await handle.readFile();
    const [final, pathFinal] = await Promise.all([handle.stat(), lstat(path)]);
    if (
      bytes.byteLength !== opened.size ||
      !validInputMetadata(final, maximumBytes, requiredMode) ||
      !validInputMetadata(pathFinal, maximumBytes, requiredMode) ||
      !sameInputSnapshot(opened, final) ||
      !sameInputSnapshot(final, pathFinal)
    ) {
      throw new Error(`${label} changed while reading`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

export async function stageReleaseResources(releaseEnvironment, root = packageRoot) {
  const [privateBytes, publicBytes, policyBytes, updateConfigBytes] = await Promise.all([
    readReleaseInputFile(releaseEnvironment.privateKeyPath, "update private key", 16 * 1024),
    readReleaseInputFile(releaseEnvironment.publicKeyPath, "update public key", 16 * 1024),
    readReleaseInputFile(releaseEnvironment.policyPath, "release policy", 64 * 1024),
    readReleaseInputFile(releaseEnvironment.updateConfigPath, "update configuration", 16 * 1024),
  ]);
  const privateKey = createPrivateKey(privateBytes);
  const publicKey = createPublicKey(publicBytes);
  if (privateKey.asymmetricKeyType !== "ed25519" || publicKey.asymmetricKeyType !== "ed25519") {
    throw new Error("update key pair must be Ed25519");
  }
  const derived = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  const supplied = publicKey.export({ format: "der", type: "spki" });
  if (!derived.equals(supplied)) throw new Error("update public key does not match private key");
  const updateConfiguration = parseReleaseUpdateConfiguration(updateConfigBytes);
  if (releasePolicyChannel(policyBytes) !== updateConfiguration.channel) {
    throw new Error("release policy and update configuration channels must match");
  }

  const stagingDirectory = join(root, "build", "release");
  const publicKeyStagingPath = join(stagingDirectory, "update-public-key.pem");
  const updateConfigStagingPath = join(stagingDirectory, "update-config.json");
  await mkdir(stagingDirectory, { recursive: true, mode: 0o700 });
  try {
    await writeFile(publicKeyStagingPath, publicKey.export({ format: "pem", type: "spki" }), {
      flag: "wx",
      mode: 0o644,
    });
    const canonicalUpdateConfig = Buffer.from(`${JSON.stringify(updateConfiguration)}\n`, "utf8");
    await writeFile(updateConfigStagingPath, canonicalUpdateConfig, {
      flag: "wx",
      mode: 0o644,
    });
    return Object.freeze({
      stagingDirectory,
      publicKeyStagingPath,
      updateConfigStagingPath,
      channel: updateConfiguration.channel,
      publicKeySpkiSha256: sha256(supplied),
      policySha256: sha256(policyBytes),
      updateConfigSha256: sha256(canonicalUpdateConfig),
    });
  } catch (error) {
    await unlink(publicKeyStagingPath).catch(() => undefined);
    await unlink(updateConfigStagingPath).catch(() => undefined);
    throw error;
  }
}

async function describeReleaseArtifact(path, kind) {
  const metadata = await lstat(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    metadata.size < 1 ||
    (metadata.mode & 0o022) !== 0
  ) {
    throw new Error("release artifact is unsafe");
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!sameInputSnapshot(metadata, opened)) {
      throw new Error("release artifact changed while opening");
    }
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path, { autoClose: false, fd: handle.fd })) {
      hash.update(chunk);
    }
    const [final, pathFinal] = await Promise.all([handle.stat(), lstat(path)]);
    if (!sameInputSnapshot(opened, final) || !sameInputSnapshot(final, pathFinal)) {
      throw new Error("release artifact changed while hashing");
    }
    return Object.freeze({
      kind,
      name: basename(path),
      size_bytes: opened.size,
      sha256: hash.digest("hex"),
    });
  } finally {
    await handle.close();
  }
}

export async function createReleaseInputDescriptor(staged, artifacts, version, application) {
  const [described, appTree] = await Promise.all([
    Promise.all([
      describeReleaseArtifact(artifacts.dmgPath, "dmg"),
      describeReleaseArtifact(artifacts.zipPath, "zip"),
    ]),
    describeCanonicalAppTree(artifacts.appPath),
  ]);
  described.sort((left, right) => left.name.localeCompare(right.name, "en"));
  const relativeAppPath = relative(dirname(artifacts.dmgPath), artifacts.appPath);
  return Object.freeze({
    schema_version: 1,
    version,
    channel: staged.channel,
    public_key_spki_sha256: staged.publicKeySpkiSha256,
    policy_sha256: staged.policySha256,
    update_config_sha256: staged.updateConfigSha256,
    application: Object.freeze({
      relative_path: relativeAppPath,
      name: appTree.name,
      bundle_identifier: application.bundleIdentifier,
      version: application.version,
      team_identifier: application.teamIdentifier,
      root_mode: appTree.root_mode,
      entry_count: appTree.entry_count,
      size_bytes: appTree.size_bytes,
      tree_sha256: appTree.tree_sha256,
    }),
    artifacts: Object.freeze(described),
  });
}
