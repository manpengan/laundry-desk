import { createHash, createPrivateKey, createPublicKey, verify, type KeyObject } from "node:crypto";
import { lstat, readdir, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";

import {
  describeCanonicalAppTree,
  describeReleaseArtifact,
  readBoundedRealFile,
} from "../../scripts/release-tree.mjs";

export { readBoundedRealFile } from "../../scripts/release-tree.mjs";

import {
  SignedReleaseManifestSchema,
  canonicalizeReleaseManifest,
  ReleaseManifestAuthoritySchema,
  signReleaseManifest,
  type ReleaseManifestAuthority,
  type SignedReleaseManifest,
} from "./release-manifest.js";

const ARTIFACT_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,179}\.(?:dmg|zip)$/u;
const MAX_KEY_BYTES = 16 * 1024;
const MAX_POLICY_BYTES = 64 * 1024;
const OUTPUT_NAME = "latest-laundry-v2.json";
const SHA256 = /^[0-9a-f]{64}$/u;
const APP_RELATIVE_PATH =
  /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,127}\/[A-Za-z0-9][A-Za-z0-9 ._()-]{0,127}\.app$/u;

const ReleasePolicySchema = z
  .object({
    channel: z.enum(["beta", "stable", "lts"]),
    minimum_secure_version: z.string(),
    minimum_upgradable_version: z.string(),
    contracts_major: z.number().int().nonnegative().safe(),
    local_schema: z.number().int().nonnegative().safe(),
    rollback: z
      .object({
        target_version: z.string(),
        artifact_sha256: z.string(),
        max_compatible_local_schema: z.number().int().nonnegative().safe(),
      })
      .strict()
      .nullable(),
  })
  .strict();

type ReleasePolicy = z.infer<typeof ReleasePolicySchema>;

export const ReleaseInputDescriptorSchema = z
  .object({
    schema_version: z.literal(1),
    version: z.string(),
    channel: z.enum(["beta", "stable", "lts"]),
    public_key_spki_sha256: z.string().regex(SHA256),
    policy_sha256: z.string().regex(SHA256),
    update_config_sha256: z.string().regex(SHA256),
    application: z
      .object({
        relative_path: z.string().regex(APP_RELATIVE_PATH),
        name: z.string().endsWith(".app"),
        bundle_identifier: z.literal("com.laundry-desk.v2"),
        version: z.string(),
        team_identifier: z.string().regex(/^[A-Z0-9]{10}$/u),
        root_mode: z.number().int().min(0).max(0o7777),
        entry_count: z.number().int().positive().safe(),
        size_bytes: z.number().int().positive().safe(),
        tree_sha256: z.string().regex(SHA256),
      })
      .strict(),
    artifacts: ReleaseManifestAuthoritySchema.shape.artifacts,
  })
  .strict()
  .superRefine((value, context) => {
    if (basename(value.application.relative_path) !== value.application.name) {
      context.addIssue({ code: "custom", message: "application path and name must match" });
    }
    if (value.application.version !== value.version) {
      context.addIssue({ code: "custom", message: "application and release versions must match" });
    }
  });

export type ReleaseInputDescriptor = z.infer<typeof ReleaseInputDescriptorSchema>;

export type ReleaseBundleInput = Readonly<{
  releaseDirectory: string;
  policyPath: string;
  privateKeyPath: string;
  descriptor: unknown;
  publishedAt?: string;
}>;

export type ReleaseBundleVerificationInput = Readonly<{
  releaseDirectory: string;
  publicKeyPath: string;
  updateConfigPath: string;
  descriptor: unknown;
}>;

function applicationPath(releaseDirectory: string, descriptor: ReleaseInputDescriptor): string {
  const path = join(releaseDirectory, descriptor.application.relative_path);
  if (resolve(path) !== path || !path.startsWith(`${releaseDirectory}/`)) {
    throw new Error("release application path escapes the release directory");
  }
  return path;
}

async function assertApplicationMatchesDescriptor(
  releaseDirectory: string,
  descriptor: ReleaseInputDescriptor,
): Promise<void> {
  const current = await describeCanonicalAppTree(applicationPath(releaseDirectory, descriptor));
  const expected = {
    name: descriptor.application.name,
    root_mode: descriptor.application.root_mode,
    entry_count: descriptor.application.entry_count,
    size_bytes: descriptor.application.size_bytes,
    tree_sha256: descriptor.application.tree_sha256,
  };
  if (JSON.stringify(current) !== JSON.stringify(expected)) {
    throw new Error("release application does not match the immutable release input");
  }
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function publicKeyDigest(key: KeyObject): string {
  const publicKey = key.type === "public" ? key : createPublicKey(key);
  return sha256(publicKey.export({ format: "der", type: "spki" }));
}

async function loadPolicy(
  path: string,
): Promise<Readonly<{ policy: ReleasePolicy; bytes: Buffer }>> {
  const bytes = await readBoundedRealFile(path, "release policy", MAX_POLICY_BYTES, {
    requiredMode: 0o600,
  });
  let candidate: unknown;
  try {
    candidate = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("release policy must be valid JSON");
  }
  return Object.freeze({ policy: ReleasePolicySchema.parse(candidate), bytes });
}

async function loadPrivateKey(path: string): Promise<KeyObject> {
  const bytes = await readBoundedRealFile(path, "update private key", MAX_KEY_BYTES, {
    requiredMode: 0o600,
  });
  const key = createPrivateKey(bytes);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("update private key must be Ed25519");
  return key;
}

async function discoverArtifacts(
  releaseDirectory: string,
  descriptor: ReleaseInputDescriptor,
  includesManifest: boolean,
): Promise<ReleaseManifestAuthority["artifacts"]> {
  if (!isAbsolute(releaseDirectory) || resolve(releaseDirectory) !== releaseDirectory) {
    throw new Error("release directory path must be canonical");
  }
  const metadata = await lstat(releaseDirectory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("release directory must be a real directory");
  }
  const entries = await readdir(releaseDirectory, { withFileTypes: true });
  if (entries.some((entry) => entry.isSymbolicLink())) {
    throw new Error("release directory contains a symlink");
  }
  const names = entries
    .filter((entry) => entry.isFile() && ARTIFACT_NAME.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (
    names.length !== 2 ||
    !names.some((name) => name.endsWith(".dmg")) ||
    !names.some((name) => name.endsWith(".zip"))
  ) {
    throw new Error("release requires exactly one DMG and one ZIP artifact");
  }
  const appContainer = descriptor.application.relative_path.split("/")[0];
  if (appContainer === undefined) throw new Error("release application container is missing");
  const expectedEntries = [
    appContainer,
    ...names,
    ...(includesManifest ? [OUTPUT_NAME] : []),
  ].sort();
  const actualEntries = entries.map((entry) => entry.name).sort();
  if (JSON.stringify(actualEntries) !== JSON.stringify(expectedEntries)) {
    throw new Error("release directory contains an unexpected entry");
  }
  const containerEntries = await readdir(join(releaseDirectory, appContainer), {
    withFileTypes: true,
  });
  if (
    containerEntries.length !== 1 ||
    !containerEntries[0]?.isDirectory() ||
    containerEntries[0].isSymbolicLink() ||
    containerEntries[0].name !== descriptor.application.name
  ) {
    throw new Error("release application container is not exact");
  }
  return await Promise.all(
    names.map(
      async (name) =>
        await describeReleaseArtifact(
          join(releaseDirectory, name),
          name.endsWith(".dmg") ? "dmg" : "zip",
        ),
    ),
  );
}

export async function buildSignedReleaseBundle(
  input: ReleaseBundleInput,
): Promise<Readonly<{ path: string; manifest: SignedReleaseManifest; publicKey: string }>> {
  const descriptor = ReleaseInputDescriptorSchema.parse(input.descriptor);
  const [loadedPolicy, privateKey, artifacts] = await Promise.all([
    loadPolicy(input.policyPath),
    loadPrivateKey(input.privateKeyPath),
    discoverArtifacts(input.releaseDirectory, descriptor, false),
    assertApplicationMatchesDescriptor(input.releaseDirectory, descriptor),
  ]);
  if (
    sha256(loadedPolicy.bytes) !== descriptor.policy_sha256 ||
    loadedPolicy.policy.channel !== descriptor.channel
  ) {
    throw new Error("release policy does not match the immutable release input");
  }
  if (publicKeyDigest(privateKey) !== descriptor.public_key_spki_sha256) {
    throw new Error("update private key does not match the immutable release input");
  }
  if (JSON.stringify(artifacts) !== JSON.stringify(descriptor.artifacts)) {
    throw new Error("release artifacts do not match the immutable release input");
  }
  const authority = ReleaseManifestAuthoritySchema.parse({
    protocol_version: 1,
    ...loadedPolicy.policy,
    version: descriptor.version,
    published_at: input.publishedAt ?? new Date().toISOString(),
    artifacts,
  });
  const manifest = signReleaseManifest(authority, privateKey);
  const outputPath = join(input.releaseDirectory, OUTPUT_NAME);
  await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o644,
  });
  return Object.freeze({
    path: outputPath,
    manifest,
    publicKey: createPublicKey(privateKey).export({ format: "pem", type: "spki" }).toString(),
  });
}

export async function verifySignedReleaseBundle(
  input: ReleaseBundleVerificationInput,
): Promise<Readonly<{ ok: true }>> {
  const descriptor = ReleaseInputDescriptorSchema.parse(input.descriptor);
  const [publicBytes, updateConfigBytes, manifestBytes, artifacts] = await Promise.all([
    readBoundedRealFile(input.publicKeyPath, "embedded update public key", MAX_KEY_BYTES),
    readBoundedRealFile(input.updateConfigPath, "embedded update configuration", MAX_POLICY_BYTES),
    readBoundedRealFile(join(input.releaseDirectory, OUTPUT_NAME), "release manifest", 256 * 1024),
    discoverArtifacts(input.releaseDirectory, descriptor, true),
    assertApplicationMatchesDescriptor(input.releaseDirectory, descriptor),
  ]);
  const publicKey = createPublicKey(publicBytes);
  if (
    publicKey.asymmetricKeyType !== "ed25519" ||
    publicKeyDigest(publicKey) !== descriptor.public_key_spki_sha256
  ) {
    throw new Error("embedded update public key does not match the immutable release input");
  }
  if (sha256(updateConfigBytes) !== descriptor.update_config_sha256) {
    throw new Error("embedded update configuration does not match the immutable release input");
  }
  let candidate: unknown;
  try {
    candidate = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    throw new Error("release manifest must be valid JSON");
  }
  const manifest = SignedReleaseManifestSchema.parse(candidate);
  if (
    !verify(
      null,
      canonicalizeReleaseManifest(manifest.authority),
      publicKey,
      Buffer.from(manifest.signature, "base64"),
    )
  ) {
    throw new Error("release manifest signature is invalid");
  }
  if (
    manifest.authority.version !== descriptor.version ||
    manifest.authority.channel !== descriptor.channel ||
    JSON.stringify(manifest.authority.artifacts) !== JSON.stringify(descriptor.artifacts) ||
    JSON.stringify(artifacts) !== JSON.stringify(descriptor.artifacts)
  ) {
    throw new Error("signed release does not match the immutable release input");
  }
  return Object.freeze({ ok: true });
}

export function releaseBundleOutputName(): string {
  return basename(OUTPUT_NAME);
}
