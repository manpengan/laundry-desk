import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { inspectPrivateFile, securePrivateFile, flushDirectoryDurably } from "@laundry/platform-fs";
import { z } from "zod";

const BASELINE = "original-executable.json";
const FileSchema = z.strictObject({
  path: z.string().min(1).max(240),
  size: z.number().int().nonnegative().safe(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
});
const BaselineSchema = z.strictObject({
  version: z.literal(1),
  executable: z.string().refine(isAbsolute),
  files: z.array(FileSchema).min(1).max(20000),
});
type Baseline = z.infer<typeof BaselineSchema>;

async function inventory(root: string): Promise<Baseline["files"]> {
  const pending = [root];
  const files: Baseline["files"] = [];
  let count = 0,
    bytes = 0;
  while (pending.length > 0) {
    const path = pending.pop()!;
    const info = await lstat(path);
    if (++count > 20000 || info.isSymbolicLink() || (await realpath(path)) !== path)
      throw new Error("UPDATE_BASELINE_PATH_INVALID");
    if (info.isDirectory()) {
      for (const entry of await readdir(path)) pending.push(join(path, entry));
      continue;
    }
    bytes += info.size;
    if (!info.isFile() || info.nlink !== 1 || bytes > 2 * 1024 ** 3)
      throw new Error("UPDATE_BASELINE_FILE_INVALID");
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    const after = await lstat(path);
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ino !== info.ino)
      throw new Error("UPDATE_BASELINE_CHANGED");
    files.push({
      path: relative(root, path).replaceAll("\\", "/"),
      size: info.size,
      sha256: hash.digest("hex"),
    });
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

async function readBaseline(root: string): Promise<Baseline> {
  const path = join(root, BASELINE);
  await inspectPrivateFile(path);
  const handle = await open(path, "r");
  try {
    if ((await handle.stat()).size > 8 * 1024 * 1024) throw new Error("UPDATE_BASELINE_TOO_LARGE");
    return BaselineSchema.parse(JSON.parse((await handle.readFile()).toString("utf8")));
  } finally {
    await handle.close();
  }
}

export async function initializeWindowsBaseline(
  root: string,
  executable: string,
  newState: boolean,
): Promise<string> {
  if (newState) {
    const value = BaselineSchema.parse({
      version: 1,
      executable,
      files: await inventory(dirname(executable)),
    });
    const path = join(root, BASELINE);
    const handle = await open(path, "wx", 0o600);
    try {
      await securePrivateFile(path);
      await handle.writeFile(JSON.stringify(value));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await flushDirectoryDurably(root);
  }
  // Missing proof after first initialization never enrolls an already-updated or modified tree.
  return (await readBaseline(root)).executable;
}

export async function verifyWindowsBaseline(root: string, executable: string): Promise<void> {
  const proof = await readBaseline(root);
  if (
    proof.executable !== executable ||
    JSON.stringify(await inventory(dirname(executable))) !== JSON.stringify(proof.files)
  )
    throw new Error("UPDATE_BASELINE_INTEGRITY_FAILED");
}
