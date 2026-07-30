import { createHash, createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { lstat, open, readdir, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";

import {
  ReleaseManifestAuthoritySchema,
  signReleaseManifest,
  type ReleaseManifestAuthority,
  type SignedReleaseManifest,
} from "./release-manifest.js";

const ARTIFACT_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,179}\.(?:dmg|zip)$/u;
const MAX_KEY_BYTES = 16 * 1024;
const MAX_POLICY_BYTES = 64 * 1024;
const OUTPUT_NAME = "latest-laundry-v2.json";

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

export type ReleaseBundleInput = Readonly<{
  releaseDirectory: string;
  version: string;
  policyPath: string;
  privateKeyPath: string;
  publishedAt?: string;
}>;

async function readBoundedRealFile(
  path: string,
  label: string,
  maximumBytes: number,
  requirePrivateMode = false,
): Promise<Buffer> {
  if (!isAbsolute(path) || resolve(path) !== path)
    throw new Error(`${label} path must be canonical`);
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink())
    throw new Error(`${label} must be a real file`);
  if (metadata.size < 1 || metadata.size > maximumBytes)
    throw new Error(`${label} size is invalid`);
  if (requirePrivateMode && (metadata.mode & 0o077) !== 0) {
    throw new Error(`${label} permissions must exclude group and other access`);
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (opened.dev !== metadata.dev || opened.ino !== metadata.ino) {
      throw new Error(`${label} changed while opening`);
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function loadPolicy(path: string): Promise<ReleasePolicy> {
  const bytes = await readBoundedRealFile(path, "release policy", MAX_POLICY_BYTES);
  let candidate: unknown;
  try {
    candidate = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("release policy must be valid JSON");
  }
  return ReleasePolicySchema.parse(candidate);
}

async function loadPrivateKey(path: string): Promise<KeyObject> {
  const bytes = await readBoundedRealFile(path, "update private key", MAX_KEY_BYTES, true);
  const key = createPrivateKey(bytes);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("update private key must be Ed25519");
  return key;
}

async function describeArtifact(
  releaseDirectory: string,
  name: string,
): Promise<ReleaseManifestAuthority["artifacts"][number]> {
  const path = join(releaseDirectory, name);
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink())
    throw new Error("release artifact is unsafe");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (opened.dev !== metadata.dev || opened.ino !== metadata.ino) {
      throw new Error("release artifact changed while opening");
    }
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path, { autoClose: false, fd: handle.fd })) {
      hash.update(chunk);
    }
    const final = await handle.stat();
    if (final.size !== opened.size || final.mtimeMs !== opened.mtimeMs) {
      throw new Error("release artifact changed while hashing");
    }
    return Object.freeze({
      kind: name.endsWith(".dmg") ? ("dmg" as const) : ("zip" as const),
      name,
      size_bytes: metadata.size,
      sha256: hash.digest("hex"),
    });
  } finally {
    await handle.close();
  }
}

async function discoverArtifacts(
  releaseDirectory: string,
): Promise<ReleaseManifestAuthority["artifacts"]> {
  if (!isAbsolute(releaseDirectory) || resolve(releaseDirectory) !== releaseDirectory) {
    throw new Error("release directory path must be canonical");
  }
  const metadata = await lstat(releaseDirectory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("release directory must be a real directory");
  }
  const names = (await readdir(releaseDirectory)).filter((name) => ARTIFACT_NAME.test(name)).sort();
  if (
    names.length !== 2 ||
    !names.some((name) => name.endsWith(".dmg")) ||
    !names.some((name) => name.endsWith(".zip"))
  ) {
    throw new Error("release requires exactly one DMG and one ZIP artifact");
  }
  return await Promise.all(
    names.map(async (name) => await describeArtifact(releaseDirectory, name)),
  );
}

export async function buildSignedReleaseBundle(
  input: ReleaseBundleInput,
): Promise<Readonly<{ path: string; manifest: SignedReleaseManifest; publicKey: string }>> {
  const [policy, privateKey, artifacts] = await Promise.all([
    loadPolicy(input.policyPath),
    loadPrivateKey(input.privateKeyPath),
    discoverArtifacts(input.releaseDirectory),
  ]);
  const authority = ReleaseManifestAuthoritySchema.parse({
    protocol_version: 1,
    ...policy,
    version: input.version,
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

export function releaseBundleOutputName(): string {
  return basename(OUTPUT_NAME);
}
