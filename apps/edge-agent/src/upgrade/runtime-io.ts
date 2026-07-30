import { createHash, createPublicKey, type KeyObject } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import {
  SignedReleaseManifestSchema,
  type ReleaseManifestAuthority,
  type SignedReleaseManifest,
} from "./release-manifest.js";

const execFileAsync = promisify(execFile);
const MAX_MANIFEST_BYTES = 256 * 1_024;
const MAX_ARTIFACT_BYTES = 1_024 * 1_024 * 1_024;
const MAX_PUBLIC_KEY_BYTES = 16 * 1_024;

export type UpdateFetch = (
  input: string,
  init: Readonly<{ redirect: "manual"; signal: AbortSignal }>,
) => Promise<Response>;

export type RuntimeUpdateIo = Readonly<{
  fetchManifest: (url: string) => Promise<SignedReleaseManifest>;
  downloadArtifact: (
    manifestUrl: string,
    authority: ReleaseManifestAuthority,
    artifactName: string,
    destinationDirectory: string,
  ) => Promise<Readonly<{ path: string; sha256: string }>>;
  extractAndVerifyMacApp: (zipPath: string, destinationDirectory: string) => Promise<string>;
}>;

function validatedManifestUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    url.search !== "" ||
    url.hostname.length === 0
  ) {
    throw new Error("Update manifest URL must be a fixed credential-free HTTPS URL");
  }
  return url;
}

function artifactUrl(manifestUrl: string, artifactName: string): string {
  const manifest = validatedManifestUrl(manifestUrl);
  const basePath = manifest.pathname.slice(0, manifest.pathname.lastIndexOf("/") + 1);
  const candidate = new URL(`${basePath}${encodeURIComponent(artifactName)}`, manifest.origin);
  if (candidate.origin !== manifest.origin || !candidate.pathname.startsWith(basePath)) {
    throw new Error("Update artifact escaped the manifest origin");
  }
  return candidate.toString();
}

async function readResponseBytes(response: Response, maximumBytes: number): Promise<Buffer> {
  if (response.status !== 200 || response.redirected || response.body === null) {
    throw new Error("Update response was not a direct successful body");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new Error("Update response exceeded its byte limit");
    }
    chunks.push(chunk.value);
  }
  return Buffer.concat(chunks, total);
}

async function fetchWithTimeout(
  fetchImpl: UpdateFetch,
  url: string,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { redirect: "manual", signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function assertContained(root: string, candidate: string): void {
  const rel = relative(root, candidate);
  if (rel === "" || rel.startsWith("..") || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("Update artifact escaped its slot");
  }
}

async function downloadVerified(
  fetchImpl: UpdateFetch,
  url: string,
  authority: ReleaseManifestAuthority,
  artifactName: string,
  destinationDirectory: string,
): Promise<Readonly<{ path: string; sha256: string }>> {
  const artifact = authority.artifacts.find((entry) => entry.name === artifactName);
  if (
    artifact === undefined ||
    artifact.size_bytes > MAX_ARTIFACT_BYTES ||
    !isAbsolute(destinationDirectory)
  ) {
    throw new Error("Update artifact metadata is invalid");
  }
  const root = await realpath(destinationDirectory);
  const finalPath = join(root, artifact.name);
  const tempPath = join(root, `.${artifact.name}.downloading`);
  assertContained(root, finalPath);
  assertContained(root, tempPath);
  const response = await fetchWithTimeout(fetchImpl, url, 120_000);
  if (response.status !== 200 || response.redirected || response.body === null) {
    throw new Error("Update artifact download failed");
  }
  const handle = await open(
    tempPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  const hash = createHash("sha256");
  let received = 0;
  try {
    const reader = response.body.getReader();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += chunk.value.byteLength;
      if (received > artifact.size_bytes || received > MAX_ARTIFACT_BYTES) {
        await reader.cancel();
        throw new Error("Update artifact exceeded signed size");
      }
      hash.update(chunk.value);
      await handle.write(chunk.value);
    }
    await handle.sync();
    await handle.close();
    const digest = hash.digest("hex");
    if (received !== artifact.size_bytes || digest !== artifact.sha256) {
      throw new Error("Update artifact did not match its signed size and digest");
    }
    await rename(tempPath, finalPath);
    const directory = await open(root, constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    return Object.freeze({ path: finalPath, sha256: digest });
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

async function extractAndVerifyMacApp(
  zipPath: string,
  destinationDirectory: string,
): Promise<string> {
  if (!isAbsolute(zipPath) || !isAbsolute(destinationDirectory)) {
    throw new Error("Update extraction paths must be absolute");
  }
  const zipMeta = await lstat(zipPath);
  if (!zipMeta.isFile() || zipMeta.isSymbolicLink()) {
    throw new Error("Update ZIP must be a real file");
  }
  const root = await realpath(destinationDirectory);
  const staging = join(root, ".app-extracting");
  const payload = join(root, "payload");
  assertContained(root, staging);
  assertContained(root, payload);
  await mkdir(staging, { mode: 0o700 });
  await execFileAsync("/usr/bin/ditto", ["-x", "-k", zipPath, staging], {
    timeout: 120_000,
    maxBuffer: 256 * 1_024,
  });
  const entries = await readdir(staging);
  if (entries.length !== 1 || !entries[0]!.endsWith(".app")) {
    throw new Error("Update ZIP must contain exactly one top-level app");
  }
  const stagedApp = join(staging, entries[0]!);
  const appMeta = await lstat(stagedApp);
  if (!appMeta.isDirectory() || appMeta.isSymbolicLink()) {
    throw new Error("Staged update app must be a real directory");
  }
  await execFileAsync("/usr/bin/codesign", ["--verify", "--deep", "--strict", stagedApp], {
    timeout: 60_000,
    maxBuffer: 256 * 1_024,
  });
  await execFileAsync("/usr/sbin/spctl", ["--assess", "--type", "execute", stagedApp], {
    timeout: 60_000,
    maxBuffer: 256 * 1_024,
  });
  const executableDirectory = join(stagedApp, "Contents", "MacOS");
  const resources = join(stagedApp, "Contents", "Resources", "app.asar");
  if (!(await stat(executableDirectory)).isDirectory() || !(await stat(resources)).isFile()) {
    throw new Error("Staged update app is missing required runtime content");
  }
  await rename(staging, payload);
  return join(payload, entries[0]!);
}

export function createRuntimeUpdateIo(fetchImpl: UpdateFetch = fetch): RuntimeUpdateIo {
  return Object.freeze({
    fetchManifest: async (url) => {
      const fixed = validatedManifestUrl(url).toString();
      const response = await fetchWithTimeout(fetchImpl, fixed, 15_000);
      const bytes = await readResponseBytes(response, MAX_MANIFEST_BYTES);
      return SignedReleaseManifestSchema.parse(JSON.parse(bytes.toString("utf8")) as unknown);
    },
    downloadArtifact: (manifestUrl, authority, artifactName, destinationDirectory) =>
      downloadVerified(
        fetchImpl,
        artifactUrl(manifestUrl, artifactName),
        authority,
        artifactName,
        destinationDirectory,
      ),
    extractAndVerifyMacApp,
  });
}

export async function loadUpdatePublicKey(path: string): Promise<KeyObject> {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new Error("Update public key path must be canonical");
  }
  const metadata = await lstat(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size < 1 ||
    metadata.size > MAX_PUBLIC_KEY_BYTES
  ) {
    throw new Error("Update public key file is invalid");
  }
  const key = createPublicKey(await readFile(path));
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("Update public key must be Ed25519");
  }
  return key;
}
