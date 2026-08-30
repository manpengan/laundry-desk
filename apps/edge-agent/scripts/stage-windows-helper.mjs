import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
const workspaceRoot = resolve(packageRoot, "..", "..");
const DEFAULT_SOURCE_ROOT = join(workspaceRoot, "packages", "platform-fs", "native", "windows");
const DEFAULT_TARGET_ROOT = join(packageRoot, "resources", "windows-helper");
const HELPER_FILE_NAME = "laundry-windows-helper.exe";
const DIGEST_FILE_NAME = `${HELPER_FILE_NAME}.sha256`;
const SHA256 = /^[0-9a-f]{64}$/u;

async function assertDirectory(path) {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("WINDOWS_HELPER_STAGING_DIRECTORY_INVALID");
  }
}

async function assertRegularUniqueFile(path) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new Error("WINDOWS_HELPER_STAGING_FILE_INVALID");
  }
}

function parseDigest(bytes) {
  const digest = bytes.toString("ascii").trim();
  if (!SHA256.test(digest)) throw new Error("WINDOWS_HELPER_STAGING_DIGEST_INVALID");
  return digest;
}

async function verifyHelperBundle(root) {
  const helperPath = join(root, HELPER_FILE_NAME);
  const digestPath = join(root, DIGEST_FILE_NAME);
  await Promise.all([
    assertDirectory(root),
    assertRegularUniqueFile(helperPath),
    assertRegularUniqueFile(digestPath),
  ]);
  const [helper, digestBytes] = await Promise.all([readFile(helperPath), readFile(digestPath)]);
  const digest = parseDigest(digestBytes);
  if (createHash("sha256").update(helper).digest("hex") !== digest) {
    throw new Error("WINDOWS_HELPER_STAGING_INTEGRITY_FAILED");
  }
  return digest;
}

export async function stageWindowsHelper({
  sourceRoot = DEFAULT_SOURCE_ROOT,
  targetRoot = DEFAULT_TARGET_ROOT,
} = {}) {
  if (
    !isAbsolute(sourceRoot) ||
    !isAbsolute(targetRoot) ||
    basename(targetRoot) !== "windows-helper"
  ) {
    throw new Error("WINDOWS_HELPER_STAGING_PATH_INVALID");
  }
  await assertDirectory(dirname(targetRoot));
  const sourceDigest = await verifyHelperBundle(sourceRoot);
  const temporaryRoot = `${targetRoot}.${process.pid}.tmp`;
  await rm(temporaryRoot, { force: true, recursive: true });
  await mkdir(temporaryRoot);
  try {
    await Promise.all([
      copyFile(join(sourceRoot, HELPER_FILE_NAME), join(temporaryRoot, HELPER_FILE_NAME)),
      copyFile(join(sourceRoot, DIGEST_FILE_NAME), join(temporaryRoot, DIGEST_FILE_NAME)),
    ]);
    const stagedDigest = await verifyHelperBundle(temporaryRoot);
    if (stagedDigest !== sourceDigest) {
      throw new Error("WINDOWS_HELPER_STAGING_INTEGRITY_FAILED");
    }
    await rm(targetRoot, { force: true, recursive: true });
    await rename(temporaryRoot, targetRoot);
    return Object.freeze({ digest: stagedDigest, targetRoot });
  } catch (error) {
    await rm(temporaryRoot, { force: true, recursive: true });
    throw error;
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && pathToFileURL(resolve(invokedPath)).href === import.meta.url) {
  if (process.platform !== "win32") {
    process.stderr.write("WINDOWS_HELPER_STAGING_REQUIRES_WINDOWS\n");
    process.exitCode = 1;
  } else {
    stageWindowsHelper()
      .then(({ digest }) => process.stdout.write(`${digest}\n`))
      .catch(() => {
        process.stderr.write("WINDOWS_HELPER_STAGING_FAILED\n");
        process.exitCode = 1;
      });
  }
}
