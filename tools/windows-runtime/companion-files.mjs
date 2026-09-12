import { lstat, open, readdir, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import {
  fail,
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_PAYLOAD_BYTES,
  requirePayloadPath,
} from "./companion-contract.mjs";

export async function requireRealDirectory(directory) {
  const root = resolve(directory);
  let cursor = root;
  while (true) {
    const info = await lstat(cursor);
    if (!info.isDirectory() || info.isSymbolicLink()) fail("DIRECTORY_INVALID");
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  const actual = await realpath(root);
  if (
    process.platform === "win32" ? actual.toLowerCase() !== root.toLowerCase() : actual !== root
  ) {
    fail("DIRECTORY_INVALID");
  }
  return root;
}

function sameFile(a, b) {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs &&
    b.nlink === 1 &&
    b.isFile()
  );
}

export async function hashFile(path) {
  const before = await lstat(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    before.size > MAX_FILE_BYTES
  ) {
    fail("FILE_INVALID");
  }
  const file = await open(path, "r");
  try {
    if (!sameFile(before, await file.stat())) fail("FILE_CHANGED");
    const hash = createHash("sha256");
    for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk);
    if (!sameFile(before, await file.stat()) || !sameFile(before, await lstat(path)))
      fail("FILE_CHANGED");
    return { size: before.size, sha256: hash.digest("hex") };
  } finally {
    await file.close();
  }
}

export async function inventory(root, excluded = []) {
  root = await requireRealDirectory(root);
  const files = [];
  const directories = [];
  const names = new Set();
  let total = 0;
  async function visit(relative) {
    for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      requirePayloadPath(path);
      if (excluded.includes(path)) continue;
      const lower = path.toLowerCase();
      if (names.has(lower)) fail("CASE_COLLISION");
      names.add(lower);
      if (entry.isSymbolicLink()) fail("LINK_FORBIDDEN");
      if (entry.isDirectory()) {
        directories.push(path);
        if (directories.length > MAX_FILES) fail("PAYLOAD_TOO_LARGE");
        await visit(path);
      } else {
        const metadata = await hashFile(join(root, path));
        total += metadata.size;
        if (files.length >= MAX_FILES || total > MAX_PAYLOAD_BYTES) fail("PAYLOAD_TOO_LARGE");
        files.push({ path, ...metadata });
      }
    }
  }
  await visit("");
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, directories };
}
