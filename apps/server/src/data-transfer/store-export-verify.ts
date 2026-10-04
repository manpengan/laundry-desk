import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { STORE_EXPORT_MAX_BYTES } from "./store-export-files.js";
const file = z.strictObject({
  path: z.string().regex(/^(?:(?:tables|photos)\/[a-z0-9_.-]+|data-dictionary\.json|README\.md)$/u),
  bytes: z.number().int().nonnegative().max(STORE_EXPORT_MAX_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
});
export const StoreExportManifestSchema = z.strictObject({
  format: z.literal("laundry-store-export"),
  version: z.literal(1),
  policy_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  request_id: z.uuid(),
  org_id: z.uuid(),
  store_id: z.uuid(),
  actor_id: z.uuid(),
  created_at: z.iso.datetime(),
  assurance: z.literal("development_only"),
  scope: z.literal("current_store_and_shared_org_resources"),
  tables: z
    .array(
      z.strictObject({
        name: z.string().regex(/^[a-z][a-z0-9_]*$/u),
        rows: z.number().int().nonnegative(),
        path: file.shape.path,
      }),
    )
    .max(256),
  photos: z
    .array(
      z.strictObject({
        table: z.enum(["garment_photos", "delivery_evidence_attachments"]),
        id: z.uuid(),
        storage_key: z.string(),
        path: file.shape.path,
      }),
    )
    .max(20_000),
  files: z.array(file).max(20_300),
});
export type StoreExportManifest = z.infer<typeof StoreExportManifestSchema>;
async function digestRegular(path: string) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > STORE_EXPORT_MAX_BYTES)
    throw new Error("STORE_EXPORT_INTEGRITY_FAILED");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size !== stat.size)
      throw new Error("STORE_EXPORT_INTEGRITY_FAILED");
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false }))
      hash.update(chunk as Buffer);
    const after = await handle.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs)
      throw new Error("STORE_EXPORT_INTEGRITY_FAILED");
    return { bytes: stat.size, sha256: hash.digest("hex") };
  } finally {
    await handle.close();
  }
}
export async function verifyStoreExport(
  directory: string,
  expectedManifestSha256?: string,
): Promise<StoreExportManifest> {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("STORE_EXPORT_INTEGRITY_FAILED");
  const manifestPath = join(directory, "manifest.json");
  const mstat = await lstat(manifestPath);
  if (!mstat.isFile() || mstat.isSymbolicLink() || mstat.size > 8 * 1024 * 1024)
    throw new Error("STORE_EXPORT_INTEGRITY_FAILED");
  if (
    expectedManifestSha256 !== undefined &&
    (await digestRegular(manifestPath)).sha256 !== expectedManifestSha256
  )
    throw new Error("STORE_EXPORT_INTEGRITY_FAILED");
  const manifest = StoreExportManifestSchema.parse(
    JSON.parse(await readFile(manifestPath, "utf8")),
  );
  const expected = new Set(manifest.files.map((entry) => entry.path));
  if (expected.size !== manifest.files.length) throw new Error("STORE_EXPORT_INTEGRITY_FAILED");
  const actual: string[] = [];
  for (const name of await readdir(directory)) {
    if (name === "manifest.json") continue;
    if (["tables", "photos"].includes(name)) {
      const child = await lstat(join(directory, name));
      if (!child.isDirectory() || child.isSymbolicLink())
        throw new Error("STORE_EXPORT_INTEGRITY_FAILED");
      for (const entry of await readdir(join(directory, name))) actual.push(`${name}/${entry}`);
    } else actual.push(name);
  }
  if (actual.length !== expected.size || actual.some((name) => !expected.has(name)))
    throw new Error("STORE_EXPORT_INTEGRITY_FAILED");
  let total = 0;
  for (const entry of manifest.files) {
    total += entry.bytes;
    if (total > STORE_EXPORT_MAX_BYTES) throw new Error("STORE_EXPORT_SIZE_LIMIT");
    const actualFile = await digestRegular(join(directory, entry.path));
    if (actualFile.bytes !== entry.bytes || actualFile.sha256 !== entry.sha256)
      throw new Error("STORE_EXPORT_INTEGRITY_FAILED");
  }
  if (
    manifest.tables.some((table) => !expected.has(table.path)) ||
    manifest.photos.some((photo) => !expected.has(photo.path))
  )
    throw new Error("STORE_EXPORT_INTEGRITY_FAILED");
  return manifest;
}
