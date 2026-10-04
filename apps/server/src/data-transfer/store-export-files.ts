import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, resolve } from "node:path";
import {
  flushDirectoryDurably,
  inspectPrivateDirectory,
  securePrivateDirectory,
  securePrivateFile,
} from "@laundry/platform-fs";

export const STORE_EXPORT_MAX_BYTES = 3 * 1024 * 1024 * 1024;
export type ExportFile = Readonly<{ path: string; bytes: number; sha256: string }>;
export const exportSha256 = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
export async function exportPrivateFile(
  path: string,
  content: Buffer | string,
): Promise<ExportFile> {
  const writer = await createExportWriter(path);
  try {
    await writer.append(content);
    return await writer.finish();
  } catch (error) {
    await writer.close();
    throw error;
  }
}
export async function createExportWriter(path: string) {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    await securePrivateFile(path);
  } catch (error) {
    await handle.close();
    throw error;
  }
  let closed = false;
  const close = async () => {
    if (!closed) {
      closed = true;
      await handle.close();
    }
  };
  return {
    append: async (value: Buffer | string) => {
      const buffer = typeof value === "string" ? Buffer.from(value, "utf8") : value;
      if (bytes + buffer.length > STORE_EXPORT_MAX_BYTES)
        throw new Error("STORE_EXPORT_SIZE_LIMIT");
      await handle.writeFile(buffer);
      hash.update(buffer);
      bytes += buffer.length;
    },
    finish: async (): Promise<ExportFile> => {
      try {
        await handle.sync();
        return { path: basename(path), bytes, sha256: hash.digest("hex") };
      } finally {
        await close();
      }
    },
    close,
  };
}
async function safeParent(path: string) {
  if (!isAbsolute(path) || resolve(path) !== path || path.length > 220 || /[\0\r\n]/u.test(path))
    throw new Error("STORE_EXPORT_DESTINATION_INVALID");
  const root = parse(path).root;
  if (root.startsWith("\\\\") || basename(path).startsWith("."))
    throw new Error("STORE_EXPORT_DESTINATION_INVALID");
  let parent = dirname(path);
  while (true) {
    const stat = await lstat(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("STORE_EXPORT_DESTINATION_INVALID");
    if (parent === root) break;
    parent = dirname(parent);
  }
  if ((await realpath(dirname(path))).toLowerCase() !== dirname(path).toLowerCase())
    throw new Error("STORE_EXPORT_DESTINATION_INVALID");
}
/** Reserve a new private directory; only a complete verified child is ever named data. */
export async function createExportDirectory(destination: string) {
  await safeParent(destination);
  await mkdir(destination, { mode: 0o700 }); // EEXIST always fails; never replace user files.
  let ready = false;
  const staging = join(destination, `.staging-${randomUUID()}`);
  try {
    await securePrivateDirectory(destination);
    await mkdir(staging, { mode: 0o700 });
    await securePrivateDirectory(staging);
    for (const name of ["tables", "photos"]) {
      await mkdir(join(staging, name), { mode: 0o700 });
      await securePrivateDirectory(join(staging, name));
    }
    ready = true;
  } finally {
    if (!ready) await rm(destination, { recursive: true, force: true });
  }
  return {
    staging,
    publish: async () => {
      await inspectPrivateDirectory(destination);
      await flushDirectoryDurably(staging);
      await rename(staging, join(destination, "data"));
      await flushDirectoryDurably(destination);
    },
    cleanup: async () => {
      await inspectPrivateDirectory(destination);
      await rm(destination, { recursive: true, force: true });
    },
  };
}
