import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  fail,
  requireDigest,
  requireMigrationHead,
  requireSha,
  requireToken,
} from "./hk-vps-release-core.mjs";
import { CONTROLLER_ROOT, releaseControllerPath } from "./hk-vps-release-controller-contract.mjs";
import { validateController } from "./hk-vps-release-controller-launcher.mjs";

const MAX_FILE_BYTES = 2 * 1024 * 1024;

function request(input) {
  const candidateSha = requireSha(input.candidateSha);
  const expectedSha = requireSha(input.expectedSha);
  const migrationHead = requireMigrationHead(input.migrationHead);
  const token = requireToken(input.token);
  return Object.freeze({
    candidate_sha: candidateSha,
    expected_sha: expectedSha,
    migration_head: migrationHead,
    schema: "laundry.cloud-release.rollback-request",
    token,
    version: 1,
  });
}

async function assertDirectory(path, uid, gid, mode) {
  const metadata = await lstat(path).catch(() => null);
  if (
    metadata === null ||
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== uid ||
    metadata.gid !== gid ||
    (metadata.mode & 0o7777) !== mode ||
    (await realpath(path).catch(() => null)) !== path
  ) {
    fail("CLOUD_RELEASE_CONTROLLER_ROOT_INVALID");
  }
}

async function syncDirectory(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensureRoot(root, uid, gid) {
  await mkdir(root, { mode: 0o700, recursive: true });
  await assertDirectory(root, uid, gid, 0o700);
  if (root === CONTROLLER_ROOT) {
    for (const parent of ["/var", "/var/lib"]) {
      const metadata = await lstat(parent).catch(() => null);
      if (
        metadata === null ||
        !metadata.isDirectory() ||
        metadata.isSymbolicLink() ||
        metadata.uid !== 0 ||
        metadata.gid !== 0 ||
        (metadata.mode & 0o022) !== 0 ||
        (await realpath(parent).catch(() => null)) !== parent
      ) {
        fail("CLOUD_RELEASE_CONTROLLER_ROOT_INVALID");
      }
    }
  }
}

async function readSource(path, uid, gid) {
  let handle;
  let buffer;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.uid !== uid ||
      metadata.gid !== gid ||
      metadata.nlink !== 1 ||
      (metadata.mode & 0o022) !== 0 ||
      metadata.size < 1 ||
      metadata.size > MAX_FILE_BYTES ||
      (await realpath(path).catch(() => null)) !== path
    ) {
      fail("CLOUD_RELEASE_CONTROLLER_SOURCE_INVALID");
    }
    buffer = await handle.readFile();
    if (buffer.byteLength !== metadata.size) fail("CLOUD_RELEASE_CONTROLLER_SOURCE_INVALID");
    return Buffer.from(buffer);
  } catch (error) {
    if (error?.code?.startsWith?.("CLOUD_RELEASE_")) throw error;
    fail("CLOUD_RELEASE_CONTROLLER_SOURCE_INVALID", error);
  } finally {
    buffer?.fill(0);
    await handle?.close().catch(() => undefined);
  }
}

async function writePrivate(path, buffer) {
  let handle;
  try {
    handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(buffer);
    await handle.chmod(0o600);
    await handle.sync();
  } catch (error) {
    fail("CLOUD_RELEASE_CONTROLLER_WRITE_FAILED", error);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function copyCloudDirectory(source, target, relative, uid, gid, inventory) {
  await assertDirectory(source, uid, gid, 0o755);
  await mkdir(target, { mode: 0o700, recursive: true });
  await assertDirectory(target, uid, gid, 0o700);
  const names = (await readdir(source)).sort();
  for (const name of names) {
    if (!/^[a-z0-9][a-z0-9.-]*$/u.test(name)) fail("CLOUD_RELEASE_CONTROLLER_SOURCE_INVALID");
    const sourcePath = join(source, name);
    const targetPath = join(target, name);
    const relativePath = `${relative}/${name}`;
    const metadata = await lstat(sourcePath).catch((error) => {
      fail("CLOUD_RELEASE_CONTROLLER_SOURCE_INVALID", error);
    });
    if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
      await copyCloudDirectory(sourcePath, targetPath, relativePath, uid, gid, inventory);
      continue;
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      fail("CLOUD_RELEASE_CONTROLLER_SOURCE_INVALID");
    }
    const buffer = await readSource(sourcePath, uid, gid);
    try {
      await writePrivate(targetPath, buffer);
      inventory.push(
        Object.freeze({
          path: relativePath,
          sha256: createHash("sha256").update(buffer).digest("hex"),
          size: buffer.byteLength,
        }),
      );
    } finally {
      buffer.fill(0);
    }
  }
  await syncDirectory(target);
}

async function copyCloudFiles(sourceRoot, temporary, uid, gid) {
  const source = join(sourceRoot, "tools/cloud");
  const target = join(temporary, "tools/cloud");
  const inventory = [];
  await copyCloudDirectory(source, target, "tools/cloud", uid, gid, inventory);
  inventory.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  for (const path of [target, dirname(target), temporary]) {
    await assertDirectory(path, uid, gid, 0o700);
    await syncDirectory(path);
  }
  return Object.freeze(inventory);
}

async function publishController(temporary, path, validation) {
  try {
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } catch (error) {
    if (!(error instanceof Error && ["EEXIST", "ENOTEMPTY"].includes(error.code))) {
      fail("CLOUD_RELEASE_CONTROLLER_PUBLISH_FAILED", error);
    }
    await validation();
  }
}

export async function installReleaseController(sourceRoot, input, options = {}) {
  const uid = options.uid ?? 0;
  const gid = options.gid ?? 0;
  const root = options.root ?? CONTROLLER_ROOT;
  const identity = request(input);
  const archiveDigest = requireDigest(input.archiveDigest);
  const defaultPath = releaseControllerPath(input.candidateSha, input.token);
  const path = options.root === undefined ? defaultPath : join(root, basename(defaultPath));
  const temporary = join(root, `.controller-${randomBytes(16).toString("hex")}.tmp`);
  const validate = async () => await validateController(identity, { gid, root, uid });
  await ensureRoot(root, uid, gid);
  const existing = await lstat(path).catch((error) => {
    if (error instanceof Error && error.code === "ENOENT") return null;
    throw error;
  });
  if (existing !== null) {
    const installed = await validate();
    if (installed.metadata.archive_sha256 !== archiveDigest) {
      fail("CLOUD_RELEASE_CONTROLLER_ARCHIVE_MISMATCH");
    }
    return Object.freeze({ digest: installed.digest, path: defaultPath });
  }
  try {
    await mkdir(temporary, { mode: 0o700 });
    const inventory = await copyCloudFiles(sourceRoot, temporary, uid, gid);
    const manifest = JSON.stringify(inventory);
    const digest = createHash("sha256").update(manifest, "utf8").digest("hex");
    await writePrivate(join(temporary, "files.json"), Buffer.from(manifest, "utf8"));
    const metadata = JSON.stringify({
      archive_sha256: archiveDigest,
      candidate_sha: identity.candidate_sha,
      controller_sha256: digest,
      expected_sha: identity.expected_sha,
      migration_head: identity.migration_head,
      schema: "laundry.cloud-release.controller",
      token_sha256: createHash("sha256").update(identity.token, "utf8").digest("hex"),
      version: 1,
    });
    await writePrivate(join(temporary, "controller.json"), Buffer.from(metadata, "utf8"));
    await syncDirectory(temporary);
    await publishController(temporary, path, validate);
    const installed = await validate();
    if (installed.digest !== digest || installed.metadata.archive_sha256 !== archiveDigest) {
      fail("CLOUD_RELEASE_CONTROLLER_DIGEST_MISMATCH");
    }
    return Object.freeze({ digest, path: defaultPath });
  } finally {
    await rm(temporary, { force: true, recursive: true }).catch(() => undefined);
  }
}
