import { createHash, type KeyObject } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import {
  inspectPrivateDirectory,
  securePrivateDirectory,
  securePrivateFile,
} from "@laundry/platform-fs";
import { z } from "zod";
import {
  verifyReleaseManifest,
  SignedReleaseManifestSchema,
  type ReleaseManifestAuthority,
  type SignedReleaseManifest,
} from "./release-manifest.js";
import { createRuntimeUpdateIo, type RuntimeUpdateIo } from "./runtime-io.js";
import { runWindowsUpdateRequest, type WindowsUpdateRequest } from "./windows-update-process.js";
import { verifyWindowsBaseline } from "./windows-update-baseline.js";

type WindowsTarget = NonNullable<ReleaseManifestAuthority["target"]>;
type NativeBridge = (request: WindowsUpdateRequest) => Promise<void>;
const ProofSchema = z.strictObject({
  manifest: SignedReleaseManifestSchema,
  executable: z.string().min(1).max(150),
});
const PROFILE_SCHEMA = z.object({ profile_id: z.enum(["generic", "hongfa"]) });
const PROOF_NAME = "windows-release-proof.json";

async function readBounded(path: string, max = 256 * 1024): Promise<Buffer> {
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.size < 1 ||
    info.size > max
  )
    throw new Error("UPDATE_FILE_INVALID");
  return readFile(path);
}

export async function windowsUpdateTarget(resourcesPath: string): Promise<WindowsTarget> {
  const bytes = await readBounded(
    join(resourcesPath, "distribution-profile", "profile.json"),
    8192,
  );
  return Object.freeze({
    platform: "win32",
    arch: "x64",
    profile: PROFILE_SCHEMA.parse(JSON.parse(bytes.toString("utf8"))).profile_id,
  });
}

async function verifyTree(root: string): Promise<void> {
  let count = 0;
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(directory)) !== directory)
      throw new Error("UPDATE_TREE_INVALID");
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++count > 20_000) throw new Error("UPDATE_TREE_LIMIT");
      const path = join(directory, entry.name);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) throw new Error("UPDATE_TREE_LINK");
      if (metadata.isDirectory()) pending.push(path);
      else if (!metadata.isFile() || metadata.nlink !== 1) throw new Error("UPDATE_TREE_SPECIAL");
    }
  }
}

async function verifyZip(root: string, manifest: SignedReleaseManifest): Promise<string> {
  const artifact = manifest.authority.artifacts.find((a) => a.kind === "zip");
  if (!artifact) throw new Error("UPDATE_ZIP_MISSING");
  const path = join(root, artifact.name);
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.size !== artifact.size_bytes ||
    info.size > 1024 ** 3
  )
    throw new Error("UPDATE_ZIP_INVALID");
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  if (hash.digest("hex") !== artifact.sha256) throw new Error("UPDATE_ZIP_HASH_INVALID");
  return path;
}

async function verifyBundledAuthority(currentExe: string, targetExe: string): Promise<void> {
  for (const name of ["update-config.json", "update-public-key.pem"]) {
    const current = await readBounded(
      join(dirname(currentExe), "resources", "update", name),
      16384,
    );
    const target = await readBounded(join(dirname(targetExe), "resources", "update", name), 16384);
    if (!current.equals(target)) throw new Error("UPDATE_BUNDLED_AUTHORITY_CHANGED");
  }
  const before = await windowsUpdateTarget(join(dirname(currentExe), "resources"));
  const after = await windowsUpdateTarget(join(dirname(targetExe), "resources"));
  if (before.profile !== after.profile) throw new Error("UPDATE_PROFILE_MISMATCH");
}

export function createWindowsUpdateIo(
  currentExe: string,
  bridge: NativeBridge = runWindowsUpdateRequest,
): RuntimeUpdateIo {
  return Object.freeze({
    ...createRuntimeUpdateIo(),
    async extractAndVerifyWindowsApp(zipPath, destinationDirectory, manifest) {
      const root = await realpath(destinationDirectory);
      await inspectPrivateDirectory(root);
      if (
        (await verifyZip(root, manifest)) !== zipPath ||
        manifest.authority.target?.platform !== "win32"
      )
        throw new Error("UPDATE_WINDOWS_ARTIFACT_INVALID");
      const payload = join(root, "payload");
      await mkdir(payload, { mode: 0o700 });
      await securePrivateDirectory(payload);
      const targetExe = join(payload, basename(currentExe));
      await bridge({
        currentExe,
        targetExe,
        zipPath,
        destination: payload,
        verifyOnly: false,
        expectedVersion: manifest.authority.version,
      });
      await verifyTree(payload);
      await verifyBundledAuthority(currentExe, targetExe);
      const proofPath = join(root, PROOF_NAME);
      await writeFile(proofPath, JSON.stringify({ manifest, executable: basename(currentExe) }), {
        flag: "wx",
        mode: 0o600,
      });
      await securePrivateFile(proofPath);
      return targetExe;
    },
  });
}

/** Re-check the signed ZIP and every extracted byte on every redirected launch. */
export async function validateWindowsUpdateLaunch(
  options: Readonly<{
    currentExe: string;
    targetExe: string;
    updatesRoot: string;
    publicKey: KeyObject;
    target: WindowsTarget;
    minimumSecureVersion: string;
    originalExe: string;
  }>,
  bridge: NativeBridge = runWindowsUpdateRequest,
): Promise<void> {
  const { currentExe, targetExe } = options;
  if (!isAbsolute(targetExe) || !targetExe.toLowerCase().endsWith(".exe"))
    throw new Error("UPDATE_TARGET_INVALID");
  if (targetExe === options.originalExe) {
    await verifyWindowsBaseline(options.updatesRoot, targetExe);
    await verifyBundledAuthority(currentExe, targetExe);
    await bridge({ currentExe, targetExe });
    return;
  }
  const root = dirname(dirname(targetExe));
  const rel = relative(options.updatesRoot, root);
  if (
    isAbsolute(rel) ||
    rel.startsWith("..") ||
    !/^slots[/\\][AB][/\\][^/\\]+$/u.test(rel) ||
    basename(dirname(targetExe)) !== "payload"
  )
    throw new Error("UPDATE_TARGET_OUTSIDE_SLOT");
  await inspectPrivateDirectory(root);
  const proof = ProofSchema.parse(
    JSON.parse((await readBounded(join(root, PROOF_NAME))).toString("utf8")),
  );
  if (proof.executable !== basename(targetExe)) throw new Error("UPDATE_EXECUTABLE_MISMATCH");
  const authority = proof.manifest.authority;
  const verified = verifyReleaseManifest(proof.manifest, options.publicKey, {
    target: options.target,
    channel: authority.channel,
    current_version: authority.minimum_upgradable_version,
    installed_minimum_secure_version: options.minimumSecureVersion,
    current_local_schema: 3,
    supported_contracts_majors: [0],
  });
  if (!verified.ok || authority.local_schema !== 3) throw new Error("UPDATE_LAUNCH_PROOF_INVALID");
  const zipPath = await verifyZip(root, proof.manifest);
  await verifyTree(dirname(targetExe));
  await verifyBundledAuthority(currentExe, targetExe);
  await bridge({
    currentExe,
    targetExe,
    zipPath,
    destination: dirname(targetExe),
    verifyOnly: true,
    expectedVersion: authority.version,
  });
}
