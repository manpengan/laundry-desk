import assert from "node:assert/strict";
import { link, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  configureWindowsHelperDirectory,
  flushDirectoryDurably,
  inspectPrivateDirectory,
  inspectPrivateFile,
  inspectPrivateFileLinks,
  replaceFileWriteThrough,
  securePrivateDirectory,
  securePrivateFile,
} from "./index.js";

test("private files and atomic replacement use the active platform security contract", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "laundry-platform-fs-"));
  t.after(async () => await rm(root, { force: true, recursive: true }));
  await securePrivateDirectory(root);
  assert.equal(
    (await inspectPrivateDirectory(root)).scheme,
    process.platform === "win32" ? "windows-dacl-v1" : "posix-mode-v1",
  );
  const current = join(root, "current.json");
  const next = join(root, "next.tmp");
  await writeFile(current, "old\n", { mode: 0o600 });
  await writeFile(next, "new\n", { mode: 0o600 });

  await securePrivateFile(current);
  await securePrivateFile(next);
  const before = await inspectPrivateFile(next);
  assert.equal(before.scheme, process.platform === "win32" ? "windows-dacl-v1" : "posix-mode-v1");

  await replaceFileWriteThrough(next, current);
  await flushDirectoryDurably(root);

  assert.equal(await readFile(current, "utf8"), "new\n");
  assert.equal((await stat(current)).isFile(), true);
  assert.equal((await inspectPrivateFile(current)).scheme, before.scheme);

  const linked = join(root, "linked.json");
  await link(current, linked);
  await assert.rejects(() => inspectPrivateFile(current));
  assert.equal((await inspectPrivateFileLinks(current, 2)).scheme, before.scheme);
});

test("private-file inspection rejects a broad POSIX mode", async (t) => {
  if (process.platform === "win32") return;
  const root = await mkdtemp(join(tmpdir(), "laundry-platform-fs-mode-"));
  t.after(async () => await rm(root, { force: true, recursive: true }));
  const path = join(root, "broad.txt");
  await writeFile(path, "unsafe\n", { mode: 0o644 });
  await assert.rejects(() => inspectPrivateFile(path), /PRIVATE_FILE_SECURITY_INVALID/u);
});

test("packaged helper directory configuration is absolute, fixed, and idempotent", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "laundry-platform-fs-helper-"));
  const other = await mkdtemp(join(tmpdir(), "laundry-platform-fs-helper-other-"));
  t.after(async () => {
    await Promise.all([
      rm(root, { force: true, recursive: true }),
      rm(other, { force: true, recursive: true }),
    ]);
  });

  assert.throws(
    () => configureWindowsHelperDirectory("relative/windows-helper"),
    /WINDOWS_HELPER_DIRECTORY_INVALID/u,
  );
  configureWindowsHelperDirectory(root);
  configureWindowsHelperDirectory(root);
  assert.throws(
    () => configureWindowsHelperDirectory(other),
    /WINDOWS_HELPER_DIRECTORY_ALREADY_CONFIGURED/u,
  );
});
