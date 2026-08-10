import { constants } from "node:fs";
import { chmod, lstat, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HK_VPS_ED25519_FINGERPRINT,
  HK_VPS_HOST,
  HK_VPS_PORT,
  assertPinnedSshConfig,
  fail,
  sha256File,
} from "./hk-vps-release-core.mjs";

const GIT = "/usr/bin/git";
const SSH = "/usr/bin/ssh";
const SSH_KEYSCAN = "/usr/bin/ssh-keyscan";
const SSH_KEYGEN = "/usr/bin/ssh-keygen";

export function parseScannedHostKey(source) {
  if (typeof source !== "string" || source.length > 16_384) {
    fail("CLOUD_RELEASE_SSH_HOST_KEY_INVALID");
  }
  const lines = source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  if (
    lines.length !== 1 ||
    !/^(?:103\.233\.252\.201|\[103\.233\.252\.201\]:22) ssh-ed25519 [A-Za-z0-9+/=]+$/u.test(
      lines[0],
    )
  ) {
    fail("CLOUD_RELEASE_SSH_HOST_KEY_INVALID");
  }
  return lines[0];
}

export async function createPinnedSshAuthority(execute) {
  const config = await execute(SSH, ["-G", "hk-vps"], "CLOUD_RELEASE_SSH_CONFIG");
  assertPinnedSshConfig(config.stdout);
  const scan = await execute(
    SSH_KEYSCAN,
    ["-T", "10", "-t", "ed25519", "-p", HK_VPS_PORT, HK_VPS_HOST],
    "CLOUD_RELEASE_SSH_KEYSCAN",
  );
  const fingerprint = await execute(
    SSH_KEYGEN,
    ["-lf", "-", "-E", "sha256"],
    "CLOUD_RELEASE_SSH_FINGERPRINT",
    undefined,
    { input: scan.stdout },
  );
  const matches = [...fingerprint.stdout.matchAll(/SHA256:[A-Za-z0-9+/]+/gu)].map(
    (match) => match[0],
  );
  if (matches.length !== 1 || matches[0] !== HK_VPS_ED25519_FINGERPRINT) {
    fail("CLOUD_RELEASE_SSH_FINGERPRINT_MISMATCH");
  }
  const hostKey = parseScannedHostKey(scan.stdout);
  const temporaryRoot = await mkdtemp(
    join(await realpath(tmpdir()), "laundry-cloud-release-known-host-"),
  );
  try {
    await chmod(temporaryRoot, 0o700);
    const path = join(temporaryRoot, "known_hosts");
    const handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(`${hostKey}\n`, "utf8");
      await handle.chmod(0o600);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const metadata = await lstat(path);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      (metadata.mode & 0o7777) !== 0o600 ||
      (await realpath(path)) !== path
    ) {
      fail("CLOUD_RELEASE_KNOWN_HOSTS_INVALID");
    }
    return Object.freeze({ path, temporaryRoot });
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function withPinnedSshAuthority(execute, operation, dependencies = {}) {
  const authority = await (dependencies.createPinnedSshAuthority ?? createPinnedSshAuthority)(
    execute,
  );
  let operationFailed = false;
  let operationError;
  let result;
  try {
    result = await operation(authority);
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  let cleanupFailed = false;
  let cleanupError;
  try {
    await (dependencies.rm ?? rm)(authority.temporaryRoot, { recursive: true, force: true });
  } catch (error) {
    cleanupFailed = true;
    cleanupError = error;
  }
  if (operationFailed) throw operationError;
  if (cleanupFailed) throw cleanupError;
  return result;
}

export async function createArchive(candidateSha, execute) {
  const temporaryRoot = await mkdtemp(join(await realpath(tmpdir()), "laundry-cloud-release-"));
  try {
    await chmod(temporaryRoot, 0o700);
    const archivePath = join(temporaryRoot, `${candidateSha}.tar`);
    await execute(
      GIT,
      ["archive", "--format=tar", `--output=${archivePath}`, candidateSha],
      "CLOUD_RELEASE_GIT_ARCHIVE",
      5 * 60_000,
    );
    await chmod(archivePath, 0o600);
    const metadata = await lstat(archivePath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1) {
      fail("CLOUD_RELEASE_ARCHIVE_INVALID");
    }
    return Object.freeze({
      archivePath,
      temporaryRoot,
      digest: await sha256File(archivePath),
    });
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}
