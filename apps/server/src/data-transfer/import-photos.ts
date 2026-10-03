import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, parse, relative, sep } from "node:path";
import { canonicalMigrationJson, type V2MigrationPlan } from "@laundry/migrate-v1/plan";
import type { PhotoFileStore, StoredPhoto } from "../photo/file-store.js";

async function assertDirectoryChain(path: string): Promise<void> {
  let current = parse(path).root;
  for (const segment of relative(current, path).split(sep).filter(Boolean)) {
    current = join(current, segment);
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("V1_MIGRATION_PHOTO_PATH");
  }
}

async function readSource(root: string, sourceRelativePath: string): Promise<Buffer> {
  if (
    !isAbsolute(root) ||
    sourceRelativePath.includes("\\") ||
    sourceRelativePath.split("/").some((part) => part === ".." || part === "." || part === "") ||
    isAbsolute(sourceRelativePath) ||
    sourceRelativePath.includes(":")
  ) {
    throw new Error("V1_MIGRATION_PHOTO_PATH");
  }
  await assertDirectoryChain(root);
  const path = join(root, sourceRelativePath);
  await assertDirectoryChain(join(path, ".."));
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > 8 * 1024 * 1024) {
    throw new Error("V1_MIGRATION_PHOTO_PATH");
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size) {
      throw new Error("V1_MIGRATION_PHOTO_CHANGED");
    }
    const bytes = await handle.readFile();
    const after = await lstat(path);
    const resolved = await realpath(path);
    if (
      after.ino !== opened.ino ||
      after.dev !== opened.dev ||
      after.size !== bytes.length ||
      after.isSymbolicLink() ||
      relative(await realpath(root), resolved).startsWith("..")
    ) {
      throw new Error("V1_MIGRATION_PHOTO_CHANGED");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function contentType(path: string): string {
  if (/\.jpe?g$/iu.test(path)) return "image/jpeg";
  if (/\.png$/iu.test(path)) return "image/png";
  if (/\.webp$/iu.test(path)) return "image/webp";
  throw new Error("V1_MIGRATION_PHOTO_TYPE");
}

function verifySignature(bytes: Buffer, type: string): void {
  const valid =
    type === "image/jpeg"
      ? bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      : type === "image/png"
        ? bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
        : bytes.length >= 12 &&
          bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
          bytes.subarray(8, 12).toString("ascii") === "WEBP";
  if (!valid) throw new Error("V1_MIGRATION_PHOTO_TYPE");
}

async function readSources(plan: V2MigrationPlan, root: string) {
  if (plan.photos.length > 1000) throw new Error("V1_MIGRATION_PHOTO_LIMIT");
  const sources: Array<Readonly<{ id: string; bytes: Buffer; type: string }>> = [];
  let totalBytes = 0;
  for (const photo of plan.photos) {
    const bytes = await readSource(root, photo.sourceRelativePath);
    totalBytes += bytes.byteLength;
    if (totalBytes > 128 * 1024 * 1024) throw new Error("V1_MIGRATION_PHOTO_LIMIT");
    const type = contentType(photo.sourceRelativePath);
    verifySignature(bytes, type);
    sources.push({ id: photo.id, bytes, type });
  }
  const manifest = sources.map((source) => ({
    photo_id: source.id,
    byte_size: source.bytes.length,
    content_type: source.type,
    content_sha256: createHash("sha256").update(source.bytes).digest("hex"),
  }));
  const sha256 = createHash("sha256").update(canonicalMigrationJson(manifest)).digest("hex");
  return { sources, manifest, sha256 };
}

/** Read-only preview: operator approval binds these exact assets and associations. */
export async function reviewMigrationPhotos(plan: V2MigrationPlan, root: string) {
  const { manifest, sha256 } = await readSources(plan, root);
  return Object.freeze({ manifest: Object.freeze(manifest), sha256 });
}

/** Files are immutable/no-replace. On SQL rollback retain verified orphan files
 * for retry; never delete possibly committed files after an uncertain COMMIT. */
export async function prepareMigrationPhotos(
  plan: V2MigrationPlan,
  root: string,
  files: PhotoFileStore,
  approvedSha256: string,
): Promise<ReadonlyMap<string, StoredPhoto>> {
  const { sources, sha256 } = await readSources(plan, root);
  if (sha256 !== approvedSha256) throw new Error("V1_MIGRATION_PHOTO_APPROVAL_MISMATCH");
  const prepared = new Map<string, StoredPhoto>();
  for (const source of sources) {
    const stored = await files.write(source.bytes, source.type, source.id);
    await files.read(stored);
    prepared.set(source.id, stored);
  }
  return prepared;
}
