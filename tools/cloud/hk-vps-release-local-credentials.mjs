import { constants } from "node:fs";
import { chmod, lstat, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { TextDecoder } from "node:util";

import {
  DEFAULT_CLOUD_ENVIRONMENT_PROFILE,
  requireCloudEnvironmentProfile,
} from "./cloud-environment-profile.mjs";
import {
  ACCEPTANCE_CREDENTIAL_FILES,
  assertNoDirectAcceptanceSecrets,
} from "./hk-vps-release-acceptance-secrets.mjs";
import { fail, sshArguments } from "./hk-vps-release-core.mjs";

const MAX_SECRET_BYTES = 16 * 1024;
const LOCAL_TEMP_PREFIX = "laundry-cloud-release-credentials-";

export function acceptanceCredentialScpArguments(
  filename,
  destination,
  knownHostsPath,
  profileInput = DEFAULT_CLOUD_ENVIRONMENT_PROFILE,
) {
  const profile = requireCloudEnvironmentProfile(profileInput);
  const item = ACCEPTANCE_CREDENTIAL_FILES.find((candidate) => candidate.filename === filename);
  if (
    item === undefined ||
    typeof destination !== "string" ||
    !isAbsolute(destination) ||
    destination.includes("\0")
  ) {
    fail("CLOUD_RELEASE_CREDENTIAL_DOWNLOAD_PATH_INVALID");
  }
  const ssh = sshArguments([], knownHostsPath, profile);
  return Object.freeze([
    "-q",
    ...ssh.slice(0, -1),
    `${profile.ssh.alias}:${join(profile.paths.acceptanceSecretRoot, item.filename)}`,
    destination,
  ]);
}

async function assertLocalCredential(path, uid) {
  if (
    !Number.isInteger(constants.O_NOFOLLOW) ||
    (await realpath(path).catch(() => null)) !== path
  ) {
    fail("CLOUD_RELEASE_LOCAL_CREDENTIAL_INVALID");
  }
  let handle;
  let buffer;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.uid !== uid ||
      (metadata.mode & 0o7777) !== 0o600 ||
      metadata.size < 1 ||
      metadata.size > MAX_SECRET_BYTES
    ) {
      fail("CLOUD_RELEASE_LOCAL_CREDENTIAL_INVALID");
    }
    buffer = await handle.readFile();
    const value = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    if (value.length === 0 || /[\0\r\n]/u.test(value)) {
      fail("CLOUD_RELEASE_LOCAL_CREDENTIAL_INVALID");
    }
  } catch (error) {
    if (error?.code === "CLOUD_RELEASE_LOCAL_CREDENTIAL_INVALID") throw error;
    fail("CLOUD_RELEASE_LOCAL_CREDENTIAL_INVALID", error);
  } finally {
    buffer?.fill(0);
    await handle?.close().catch(() => undefined);
  }
}

async function assertLocalRoot(path, uid, gid) {
  const metadata = await lstat(path).catch(() => null);
  const canonical = metadata === null ? null : await realpath(path).catch(() => null);
  if (
    metadata === null ||
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== uid ||
    metadata.gid !== gid ||
    (metadata.mode & 0o7777) !== 0o700 ||
    canonical !== path
  ) {
    fail("CLOUD_RELEASE_LOCAL_CREDENTIAL_ROOT_INVALID");
  }
}

function safeLocalRuntimeEnvironment(environment) {
  const allowed = ["HOME", "LANG", "LC_ALL", "PATH", "TMPDIR"];
  return Object.fromEntries(
    allowed.flatMap((name) =>
      typeof environment[name] === "string" ? [[name, environment[name]]] : [],
    ),
  );
}

export async function withDownloadedAcceptanceCredentials(input, operation, dependencies = {}) {
  assertNoDirectAcceptanceSecrets(input.environment);
  const profile = requireCloudEnvironmentProfile(
    input.profile ?? DEFAULT_CLOUD_ENVIRONMENT_PROFILE,
  );
  const uid = dependencies.uid ?? process.getuid?.();
  const gid = dependencies.gid ?? process.getgid?.();
  if (!Number.isSafeInteger(uid) || uid < 0 || !Number.isSafeInteger(gid) || gid < 0) {
    fail("CLOUD_RELEASE_LOCAL_CREDENTIAL_INVALID");
  }
  const temporaryRoot = await (dependencies.mkdtemp ?? mkdtemp)(
    join(await realpath(tmpdir()), LOCAL_TEMP_PREFIX),
  );
  try {
    await (dependencies.chmod ?? chmod)(temporaryRoot, 0o700);
    await assertLocalRoot(temporaryRoot, uid, gid);
    const fileEnvironment = {};
    for (const item of ACCEPTANCE_CREDENTIAL_FILES) {
      const path = join(temporaryRoot, item.filename);
      await input.execute(
        "/usr/bin/scp",
        acceptanceCredentialScpArguments(item.filename, path, input.knownHostsPath, profile),
        `CLOUD_RELEASE_CREDENTIAL_DOWNLOAD_${item.filename.replaceAll("-", "_").toUpperCase()}`,
        2 * 60_000,
      );
      const downloaded = await lstat(path).catch(() => null);
      if (
        downloaded === null ||
        !downloaded.isFile() ||
        downloaded.isSymbolicLink() ||
        downloaded.uid !== uid
      ) {
        fail("CLOUD_RELEASE_LOCAL_CREDENTIAL_INVALID");
      }
      await (dependencies.chmod ?? chmod)(path, 0o600);
      await assertLocalCredential(path, uid);
      fileEnvironment[item.env] = path;
    }
    return await operation(
      Object.freeze({
        ...safeLocalRuntimeEnvironment(input.environment),
        ...fileEnvironment,
        LAUNDRY_CLOUD_WEB_E2E: "1",
        LAUNDRY_CLOUD_WEB_MACHINE_JSON: "1",
      }),
    );
  } finally {
    await (dependencies.rm ?? rm)(temporaryRoot, { force: true, recursive: true });
  }
}
