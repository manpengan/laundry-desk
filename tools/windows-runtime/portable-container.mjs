import { createHash, randomUUID } from "node:crypto";
import { lstat, open, rm, statfs } from "node:fs/promises";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { digest, exactKeys, fail } from "./companion-contract.mjs";
import { requireRealDirectory } from "./companion-files.mjs";
import { requireRelease } from "./backup-contract.mjs";
import { requirePhotoIndex } from "./backup-photo-contract.mjs";
import { requirePortableInventory } from "./portable-schema.mjs";
import {
  decryptPortable,
  encryptPortable,
  handleSource,
  MAX_PORTABLE_PLAIN_BYTES,
} from "./portable-crypto.mjs";

const MAX_MANIFEST = 2 * 1024 * 1024;
const same = (a, b) =>
  b.isFile() &&
  b.nlink === 1 &&
  a.ino === b.ino &&
  a.dev === b.dev &&
  a.size === b.size &&
  a.mtimeMs === b.mtimeMs &&
  a.ctimeMs === b.ctimeMs;

export function requirePortableManifest(value) {
  if (
    !exactKeys(value, [
      "version",
      "created_at",
      "release",
      "postgres_version",
      "database",
      "photos",
    ]) ||
    value.version !== 1 ||
    typeof value.created_at !== "string" ||
    !Number.isFinite(Date.parse(value.created_at)) ||
    typeof value.postgres_version !== "string" ||
    !/^16\.\d+$/u.test(value.postgres_version)
  )
    fail("PORTABLE_MANIFEST_INVALID");
  requireRelease(value.release);
  requirePortableInventory(value.database);
  requirePhotoIndex(value.photos);
  const length =
    4 +
    Buffer.byteLength(JSON.stringify(value)) +
    value.database.size +
    value.photos.reduce((sum, p) => sum + p.size, 0);
  if (length > MAX_PORTABLE_PLAIN_BYTES) fail("PORTABLE_INVALID");
  return value;
}

export async function withPortableStage(context, action) {
  const directory = join(context.root, `portable-${randomUUID()}`);
  await context.io.directory(directory);
  try {
    return await action(directory);
  } finally {
    await context.platform.inspectPrivateDirectory(directory);
    await rm(directory, { recursive: true });
    await context.platform.flushDirectoryDurably(context.root);
  }
}

export async function privateOutput(context, path, action) {
  const handle = await open(path, "wx", 0o600);
  try {
    await context.platform.securePrivateFile(path);
    await context.platform.inspectPrivateFile(path);
    const result = await action(handle);
    await handle.sync();
    return result;
  } finally {
    await handle.close();
  }
}

async function externalFile(path, writing, action) {
  if (
    typeof path !== "string" ||
    !isAbsolute(path) ||
    path !== resolve(path) ||
    path.length > 240 ||
    /[\r\n\0]/u.test(path) ||
    !/\.ldbackup$/iu.test(path)
  )
    fail("PORTABLE_PATH_INVALID");
  await requireRealDirectory(dirname(path));
  const before = writing ? null : await lstat(path);
  if (
    before &&
    (!before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1 ||
      before.size > MAX_PORTABLE_PLAIN_BYTES + 1024 * 1024)
  )
    fail("PORTABLE_FILE_INVALID");
  const handle = await open(path, writing ? "wx" : "r", 0o600);
  try {
    if (before && !same(before, await handle.stat())) fail("PORTABLE_FILE_CHANGED");
    const result = await action(handle);
    if (before && (!same(before, await handle.stat()) || !same(before, await lstat(path))))
      fail("PORTABLE_FILE_CHANGED");
    await requireRealDirectory(dirname(path));
    return result;
  } finally {
    await handle.close();
  }
}

async function copyBytes(input, output, size, expected, position = 0) {
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(128 * 1024);
  let read = 0;
  while (read < size) {
    const { bytesRead } = await input.read(
      buffer,
      0,
      Math.min(buffer.length, size - read),
      position + read,
    );
    if (!bytesRead) fail("PORTABLE_FILE_CHANGED");
    const bytes = buffer.subarray(0, bytesRead);
    await output.writeFile(bytes);
    hash.update(bytes);
    read += bytesRead;
  }
  if (hash.digest("hex") !== expected) fail("PORTABLE_CONTENT_MISMATCH");
}

const entries = (manifest) => [
  { path: "database.ndjson", size: manifest.database.size, sha256: manifest.database.sha256 },
  ...manifest.photos.map((p) => ({ path: `photos/${p.key}`, size: p.size, sha256: p.sha256 })),
];

export async function exportPortableContainer(context, directory, manifest, destination, password) {
  requirePortableManifest(manifest);
  const header = Buffer.from(JSON.stringify(manifest));
  if (header.length > MAX_MANIFEST) fail("PORTABLE_MANIFEST_INVALID");
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(header.length);
  const plainPath = join(directory, "payload.bin");
  await privateOutput(context, plainPath, async (output) => {
    await output.writeFile(prefix);
    await output.writeFile(header);
    for (const entry of entries(manifest)) {
      const path = join(directory, entry.path);
      await context.platform.inspectPrivateFile(path);
      const before = await lstat(path),
        input = await open(path, "r");
      try {
        if (before.size !== entry.size || !same(before, await input.stat()))
          fail("PORTABLE_FILE_CHANGED");
        await copyBytes(input, output, entry.size, entry.sha256);
        if (!same(before, await input.stat()) || !same(before, await lstat(path)))
          fail("PORTABLE_FILE_CHANGED");
      } finally {
        await input.close();
      }
    }
  });
  const input = await open(plainPath, "r");
  try {
    return await externalFile(destination, true, (output) =>
      encryptPortable(
        handleSource(input),
        prefix.length + header.length + entries(manifest).reduce((sum, e) => sum + e.size, 0),
        password,
        output,
      ),
    );
  } finally {
    await input.close();
  }
}

export async function importPortableContainer(context, directory, source, password, confirmation) {
  const plainPath = join(directory, "payload.bin");
  const metadata = await privateOutput(context, plainPath, (output) =>
    externalFile(source, false, (input) =>
      decryptPortable(
        handleSource(input),
        password,
        (bytes) => output.writeFile(bytes),
        async ({ plaintext_bytes, archive_bytes }) => {
          if ((await input.stat()).size !== archive_bytes) fail("PORTABLE_INVALID");
          const space = await statfs(directory, { bigint: true });
          if (space.bavail * space.bsize < BigInt(plaintext_bytes * 2 + 1024 * 1024 * 1024))
            fail("BACKUP_SPACE_INSUFFICIENT");
        },
      ),
    ),
  );
  if (confirmation !== undefined && metadata.sha256 !== confirmation)
    fail("PORTABLE_CONFIRMATION_MISMATCH");
  const input = await open(plainPath, "r");
  try {
    const prefix = Buffer.alloc(4);
    if ((await input.read(prefix, 0, 4, 0)).bytesRead !== 4) fail("PORTABLE_INVALID");
    const length = prefix.readUInt32BE();
    if (length < 2 || length > MAX_MANIFEST) fail("PORTABLE_MANIFEST_INVALID");
    const bytes = Buffer.alloc(length);
    if ((await input.read(bytes, 0, length, 4)).bytesRead !== length) fail("PORTABLE_INVALID");
    let manifest;
    try {
      manifest = requirePortableManifest(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      );
    } catch {
      fail("PORTABLE_MANIFEST_INVALID");
    }
    let position = 4 + length;
    if (
      (await input.stat()).size !==
      position + entries(manifest).reduce((sum, e) => sum + e.size, 0)
    )
      fail("PORTABLE_CONTENT_MISMATCH");
    await context.io.directory(join(directory, "photos"));
    for (const entry of entries(manifest)) {
      await privateOutput(context, join(directory, entry.path), (output) =>
        copyBytes(input, output, entry.size, entry.sha256, position),
      );
      position += entry.size;
    }
    const photoBytes = Buffer.from(JSON.stringify(manifest.photos));
    await context.io.write(join(directory, "photos.json"), photoBytes);
    return {
      manifest,
      ...metadata,
      photoManifest: {
        index: { size: photoBytes.length, sha256: digest(photoBytes) },
        count: manifest.photos.length,
        total_bytes: manifest.photos.reduce((sum, p) => sum + p.size, 0),
      },
    };
  } finally {
    await input.close();
  }
}
