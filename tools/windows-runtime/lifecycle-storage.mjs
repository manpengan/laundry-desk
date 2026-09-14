import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { digest, exactKeys, fail } from "./companion-contract.mjs";
import { requireRealDirectory } from "./companion-files.mjs";

export async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export async function withOperationLock(root, action) {
  // The kernel releases the pipe on process death. There is no stale PID lock to steal.
  const name = `laundry-runtime-${digest(root.toLowerCase())}`;
  const address =
    process.platform === "win32" ? `\\\\.\\pipe\\${name}` : join(root, `${name}.sock`);
  const server = createServer((socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once("error", () => reject(new Error("WINDOWS_COMPANION_OPERATION_BUSY")));
    server.listen(address, resolve);
  });
  try {
    return await action();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

export function storage(platform, fault = async () => {}) {
  async function directory(path) {
    if (await exists(path)) {
      await requireRealDirectory(path);
      await platform.inspectPrivateDirectory(path);
    } else {
      await requireRealDirectory(dirname(path));
      await mkdir(path, { mode: 0o700 });
      await platform.securePrivateDirectory(path);
      await platform.inspectPrivateDirectory(path);
      await platform.flushDirectoryDurably(dirname(path));
    }
  }
  async function read(path) {
    await platform.inspectPrivateFile(path);
    const before = await lstat(path);
    if (before.size > 65536) fail("STATE_TOO_LARGE");
    const file = await open(path, "r");
    try {
      const opened = await file.stat();
      if (opened.ino !== before.ino || opened.dev !== before.dev) fail("STATE_CHANGED");
      const buffer = Buffer.alloc(65537);
      let length = 0;
      while (length < buffer.length) {
        const chunk = await file.read(buffer, length, buffer.length - length, length);
        if (!chunk.bytesRead) break;
        length += chunk.bytesRead;
      }
      if (length > 65536) fail("STATE_TOO_LARGE");
      const bytes = buffer.subarray(0, length);
      const after = await lstat(path);
      await platform.inspectPrivateFile(path);
      const finished = await file.stat();
      if (
        after.ino !== before.ino ||
        after.dev !== before.dev ||
        after.ctimeMs !== before.ctimeMs ||
        finished.ino !== before.ino ||
        finished.dev !== before.dev ||
        finished.nlink !== 1 ||
        after.mtimeMs !== before.mtimeMs ||
        finished.mtimeMs !== before.mtimeMs ||
        after.size !== bytes.length ||
        finished.size !== bytes.length
      )
        fail("STATE_CHANGED");
      return bytes.toString("utf8");
    } finally {
      await file.close();
    }
  }
  async function write(path, value) {
    await platform.inspectPrivateDirectory(dirname(path));
    if (await exists(path)) await platform.inspectPrivateFile(path);
    const temporary = join(dirname(path), `.commit-${randomUUID()}`);
    const file = await open(temporary, "wx", 0o600);
    try {
      await platform.securePrivateFile(temporary);
      await file.writeFile(value);
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await platform.inspectPrivateFile(temporary);
      await fault("before-replace");
      await platform.replaceFileWriteThrough(temporary, path);
      await fault("after-replace");
      await platform.inspectPrivateFile(path);
      await platform.flushDirectoryDurably(dirname(path));
      await fault("after-flush");
    } finally {
      if (await exists(temporary)) {
        await unlink(temporary);
        await platform.flushDirectoryDurably(dirname(path));
      }
    }
  }
  return { directory, read, write };
}

export function requireState(value) {
  if (
    !exactKeys(value, [
      "schema",
      "assurance",
      "phase",
      "current",
      "previous",
      "controller",
      "pending",
    ]) ||
    value.schema !== 1 ||
    value.assurance !== "development_only" ||
    !["staged", "initialized", "stopped", "running", "uninstalled"].includes(value.phase)
  )
    fail("STATE_INVALID");
  for (const entry of [value.current, value.previous, value.controller, value.pending]) {
    if (entry === null) continue;
    if (
      !exactKeys(entry, ["digest", "release", "source", "migrationHead", "migrations"]) ||
      !/^[a-f0-9]{64}$/u.test(entry.digest) ||
      !/^[a-f0-9]{40}$/u.test(entry.source) ||
      !/^[a-f0-9]{64}$/u.test(entry.migrations) ||
      !/^\d{4}_[a-z0-9_]+\.sql$/u.test(entry.migrationHead) ||
      !/^\d+\.\d+\.\d+-win-dev(?:\.\d+)?$/u.test(entry.release)
    )
      fail("STATE_INVALID");
  }
  if (!value.current || !value.controller) fail("STATE_INVALID");
  return value;
}

export function reference(manifest, expectedDigest) {
  return {
    digest: expectedDigest,
    release: manifest.runtime_release,
    source: manifest.source_git_sha,
    migrationHead: manifest.migration_head,
    migrations: manifest.migrations_sha256,
  };
}

export function requireCompatible(current, next) {
  if (current.migrationHead !== next.migrationHead || current.migrations !== next.migrations)
    fail("MIGRATION_CHANGE_REQUIRES_RESTORE");
}

export async function readState(io, root) {
  const path = join(root, "state.json");
  if (!(await exists(path))) return null;
  return requireState(JSON.parse(await io.read(path)));
}

export async function loadPlatform(payload) {
  const { pathToFileURL } = await import("node:url");
  const base = join(payload, "server/node_modules/@laundry/platform-fs");
  const platform = await import(pathToFileURL(join(base, "dist/index.js")).href);
  platform.configureWindowsHelperDirectory(join(base, "native/windows"));
  return platform;
}
