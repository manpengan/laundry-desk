import { execFile } from "node:child_process";
import { open } from "node:fs/promises";
import { chmod, lstat, mkdir, mkdtemp, rename, rm, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

import { assertReleaseTreeVersion } from "./release-tree.mjs";

const execFileAsync = promisify(execFile);
const DARWIN_EXCLUSIVE_RENAME = `
import Darwin
guard CommandLine.arguments.count == 3 else { exit(64) }
if renamex_np(CommandLine.arguments[1], CommandLine.arguments[2], UInt32(RENAME_EXCL)) != 0 {
  exit(errno == EEXIST ? 73 : 74)
}
`;

async function requireMissing(path, label) {
  try {
    await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`${label} already exists; archive or remove it explicitly`);
}

function sameVersion(left, right) {
  return ["dev", "ino", "size", "mode", "nlink", "mtimeNs", "ctimeNs"].every(
    (key) => left[key] === right[key],
  );
}

async function prepareExclusiveRename(stagingRoot) {
  if (process.platform !== "darwin") return rename;
  const sourcePath = join(stagingRoot, "rename-exclusive.swift");
  const executablePath = join(stagingRoot, "rename-exclusive");
  await writeFile(sourcePath, DARWIN_EXCLUSIVE_RENAME, { flag: "wx", mode: 0o600 });
  await execFileAsync("/usr/bin/xcrun", ["swiftc", "-O", "-o", executablePath, sourcePath], {
    encoding: "utf8",
    maxBuffer: 64 * 1024,
  });
  await chmod(executablePath, 0o500);
  await unlink(sourcePath);
  const expected = await lstat(executablePath, { bigint: true });
  if (!expected.isFile() || expected.isSymbolicLink() || expected.nlink !== 1n) {
    throw new Error("exclusive release commit helper is unsafe");
  }
  return async (source, destination) => {
    const current = await lstat(executablePath, { bigint: true });
    if (!sameVersion(expected, current)) {
      throw new Error("exclusive release commit helper changed before execution");
    }
    await execFileAsync(executablePath, [source, destination], {
      encoding: "utf8",
      maxBuffer: 64 * 1024,
    });
  };
}

async function sameDirectoryObject(path, expected) {
  try {
    const current = await lstat(path, { bigint: true });
    return current.isDirectory() && current.dev === expected.dev && current.ino === expected.ino;
  } catch {
    return false;
  }
}

async function commitDirectory(source, destination, dependency) {
  const sourceObject = await lstat(source, { bigint: true });
  if (!sourceObject.isDirectory() || sourceObject.isSymbolicLink()) {
    throw new Error("release commit source must be a real directory");
  }
  try {
    await (dependency ?? renameExclusive)(source, destination);
  } catch (error) {
    if (await sameDirectoryObject(destination, sourceObject)) return;
    throw error;
  }
  if (!(await sameDirectoryObject(destination, sourceObject))) {
    throw new Error("published release is not the verified staging directory");
  }
}

export async function withAtomicReleaseDirectory(root, operation, cleanup = {}) {
  if (!isAbsolute(root) || resolve(root) !== root) {
    throw new Error("release root must be a canonical absolute path");
  }
  const buildDirectory = join(root, "build");
  const lockPath = join(buildDirectory, ".mac-release.lock");
  const finalDirectory = join(root, "release");
  await mkdir(buildDirectory, { recursive: true, mode: 0o700 });
  const lock = await open(lockPath, "wx", 0o600).catch((error) => {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new Error("another macOS release transaction is active");
    }
    throw error;
  });
  let stagingRoot;
  let beforeCommit = null;
  let committed = false;
  try {
    await requireMissing(finalDirectory, "final release directory");
    stagingRoot = await mkdtemp(join(buildDirectory, "mac-release-"));
    const stagingDirectory = join(stagingRoot, "release");
    await mkdir(stagingDirectory, { mode: 0o700 });
    const result = await operation(
      Object.freeze({
        stagingRoot,
        stagingDirectory,
        setBeforeCommit: (gate) => {
          if (typeof gate !== "function" || beforeCommit !== null) {
            throw new Error("release before-commit gate must be registered exactly once");
          }
          beforeCommit = gate;
        },
      }),
    );
    await requireMissing(finalDirectory, "final release directory");
    const exclusiveRename = cleanup.renameExclusive ?? (await prepareExclusiveRename(stagingRoot));
    const verifiedSeal = beforeCommit === null ? null : await beforeCommit();
    if (verifiedSeal !== null) await assertReleaseTreeVersion(stagingDirectory, verifiedSeal);
    await commitDirectory(stagingDirectory, finalDirectory, exclusiveRename);
    committed = true;
    return Object.freeze({ finalDirectory, result });
  } finally {
    const cleanupFailures = [];
    try {
      if (stagingRoot !== undefined) {
        await (cleanup.remove ?? rm)(stagingRoot, { recursive: true, force: true });
      }
    } catch (error) {
      cleanupFailures.push(error);
    }
    try {
      await (cleanup.close ?? ((handle) => handle.close()))(lock);
    } catch (error) {
      cleanupFailures.push(error);
    }
    try {
      await (cleanup.unlink ?? unlink)(lockPath);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
        cleanupFailures.push(error);
      }
    }
    if (cleanupFailures.length > 0) {
      if (!committed) throw cleanupFailures[0];
      console.error("[release:mac] post-commit cleanup incomplete", cleanupFailures.length);
    }
  }
}
