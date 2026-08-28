import { constants } from "node:fs";
import { lstat, open, realpath, rename } from "node:fs/promises";
import { dirname, join } from "node:path";

import { HK_VPS_CLOUD_TEST as PROFILE } from "./cloud-environment-profile.mjs";
import { PUBLIC_ORIGIN, fail, requireSha } from "./hk-vps-release-core.mjs";
import { runCloudCommand } from "./hk-vps-release-process.mjs";
import {
  probeLoopbackWithReadiness,
  probePublicWithReadiness,
} from "./hk-vps-release-readiness.mjs";
import { parseCaddyCustomerSourceAuthority } from "./caddy-customer-source-contract.mjs";
import {
  assertLoopbackBindings,
  assertSharedInfrastructure,
} from "./hk-vps-release-host-guard.mjs";
import {
  ENV_FILE,
  LIVE_ROOT,
  RELEASE_ENVIRONMENT,
  SERVICE_NAME,
  assertOrdinaryDirectory,
  readReleaseMarker,
} from "./hk-vps-release-remote-support.mjs";

export { assertReleasePreflight, removeOrphanStaging } from "./hk-vps-release-host-guard.mjs";
export { assertSharedInfrastructure };

const COMMAND_ENVIRONMENT = Object.freeze({
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
});
const BUILD_ENVIRONMENT = Object.freeze([
  "CI=true",
  "COREPACK_HOME=/var/lib/laundry/.cache/corepack",
  "HOME=/var/lib/laundry",
  "LANG=C.UTF-8",
  "LC_ALL=C.UTF-8",
  `PATH=${dirname(PROFILE.paths.nodeExecutable)}:/usr/bin:/bin`,
  "TMPDIR=/var/lib/laundry",
  "XDG_CACHE_HOME=/var/lib/laundry/.cache",
]);
const HEALTH_ENVELOPE = Object.freeze({ ok: true, data: Object.freeze({ status: "ready" }) });
const DESK_PORT = PROFILE.services.deskPort;
function commandOptions(label, signal, timeoutMs = 2 * 60_000) {
  return Object.freeze({
    cwd: "/",
    environment: COMMAND_ENVIRONMENT,
    label,
    signal,
    timeoutMs,
  });
}

async function command(file, arguments_, label, signal, timeoutMs) {
  return await runCloudCommand(file, arguments_, commandOptions(label, signal, timeoutMs));
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function assertOrdinaryFile(path, ownerUid, maximumBytes = 64 * 1024 * 1024) {
  const metadata = await lstat(path).catch(() => null);
  const parent = metadata === null ? null : await realpath(dirname(path)).catch(() => null);
  if (
    metadata === null ||
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== ownerUid ||
    metadata.size < 1 ||
    metadata.size > maximumBytes ||
    parent === null
  ) {
    fail("CLOUD_RELEASE_FILE_INVALID");
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

async function runAsLaundry(stagingRoot, pnpmArguments, label, signal) {
  await runCloudCommand(
    "/usr/bin/sudo",
    [
      "-u",
      "laundry",
      "--",
      "/usr/bin/env",
      "-i",
      ...BUILD_ENVIRONMENT,
      join(dirname(PROFILE.paths.nodeExecutable), "corepack"),
      "pnpm",
      ...pnpmArguments,
    ],
    Object.freeze({
      ...commandOptions(label, signal, 20 * 60_000),
      cwd: stagingRoot,
    }),
  );
}

async function writeReleaseMarker(root, candidateSha) {
  const path = join(root, PROFILE.markers.releaseFile);
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o644,
  );
  try {
    await handle.writeFile(
      `${JSON.stringify({ git_sha: requireSha(candidateSha), environment: RELEASE_ENVIRONMENT })}\n`,
      "utf8",
    );
    await handle.chmod(0o644);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function assertSystemContract(signal) {
  const result = await command(
    "/usr/bin/systemctl",
    [
      "show",
      SERVICE_NAME,
      "--property=User",
      "--property=Group",
      "--property=WorkingDirectory",
      "--property=ExecStart",
      "--property=EnvironmentFiles",
      "--property=FragmentPath",
      "--no-pager",
    ],
    "CLOUD_RELEASE_SYSTEM_CONTRACT",
    signal,
  );
  const properties = new Map(
    result.stdout
      .trim()
      .split("\n")
      .map((line) => {
        const separator = line.indexOf("=");
        return separator < 1 ? [line, ""] : [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
  if (
    properties.get("User") !== "laundry" ||
    properties.get("Group") !== "laundry" ||
    properties.get("WorkingDirectory") !== LIVE_ROOT ||
    properties.get("FragmentPath") !== `/etc/systemd/system/${PROFILE.services.desk}` ||
    properties.get("EnvironmentFiles") !== `${ENV_FILE} (ignore_errors=no)` ||
    !properties
      .get("ExecStart")
      ?.startsWith(
        `{ path=${PROFILE.paths.nodeExecutable} ; argv[]=${PROFILE.paths.nodeExecutable} apps/server/dist/http/main.js ;`,
      )
  ) {
    fail("CLOUD_RELEASE_SYSTEM_CONTRACT_INVALID");
  }
  const caddy = await command(
    "/usr/bin/caddy",
    ["adapt", "--config", "/etc/caddy/Caddyfile", "--pretty"],
    "CLOUD_RELEASE_CADDY_VALIDATE",
    signal,
  );
  if (!parseCaddyCustomerSourceAuthority(caddy.stdout)) {
    fail("CLOUD_RELEASE_SYSTEM_CONTRACT_INVALID");
  }
}

export async function prepareStaging(stagingRoot, candidateSha, migrationHead, signal) {
  await assertOrdinaryDirectory(stagingRoot);
  for (const path of [
    join(stagingRoot, "package.json"),
    join(stagingRoot, "pnpm-lock.yaml"),
    join(stagingRoot, "tools/cloud/hk-vps-release-remote.mjs"),
    join(stagingRoot, "packages/db/src/migrations", migrationHead),
  ]) {
    await assertOrdinaryFile(path, 0);
  }
  if (await pathExists(join(stagingRoot, PROFILE.markers.releaseFile))) {
    fail("CLOUD_RELEASE_STAGING_MARKER_PRESENT");
  }
  await command(
    "/usr/bin/chown",
    ["-R", "laundry:laundry", stagingRoot],
    "CLOUD_RELEASE_STAGING_CHOWN_BUILD",
    signal,
  );
  await runAsLaundry(
    stagingRoot,
    ["install", "--frozen-lockfile"],
    "CLOUD_RELEASE_INSTALL",
    signal,
  );
  await runAsLaundry(
    stagingRoot,
    ["--filter", "@laundry/server...", "build"],
    "CLOUD_RELEASE_SERVER_BUILD",
    signal,
  );
  await runAsLaundry(
    stagingRoot,
    ["--filter", "@laundry/web...", "build"],
    "CLOUD_RELEASE_WEB_BUILD",
    signal,
  );
  await command(
    "/usr/bin/chown",
    ["-R", "root:root", stagingRoot],
    "CLOUD_RELEASE_STAGING_CHOWN_RUNTIME",
    signal,
  );
  const runtimeNodes = [stagingRoot, "-xdev", "(", "-type", "f", "-o", "-type", "d", ")"];
  await command(
    "/usr/bin/find",
    [...runtimeNodes, "-perm", "/022", "-exec", "/usr/bin/chmod", "go-w", "--", "{}", "+"],
    "CLOUD_RELEASE_STAGING_PERMISSIONS",
    signal,
  );
  const writable = await command(
    "/usr/bin/find",
    [...runtimeNodes, "-perm", "/022", "-print", "-quit"],
    "CLOUD_RELEASE_STAGING_PERMISSIONS",
    signal,
  );
  if (writable.stdout.trim() !== "") fail("CLOUD_RELEASE_STAGING_WRITABLE");
  for (const path of [
    join(stagingRoot, "apps/server/dist/http/main.js"),
    join(stagingRoot, "apps/web/dist-spa/index.html"),
  ]) {
    await assertOrdinaryFile(path, 0);
  }
  await writeReleaseMarker(stagingRoot, candidateSha);
  await command(
    "/usr/bin/caddy",
    ["validate", "--config", "/etc/caddy/Caddyfile"],
    "CLOUD_RELEASE_CADDY_VALIDATE",
    signal,
  );
}

export async function stopDesk(signal) {
  await command("/usr/bin/systemctl", ["stop", SERVICE_NAME], "CLOUD_RELEASE_SERVICE_STOP", signal);
  await runCloudCommand(
    "/usr/bin/systemctl",
    ["is-active", "--quiet", SERVICE_NAME],
    Object.freeze({
      ...commandOptions("CLOUD_RELEASE_SERVICE_INACTIVE", signal),
      accepting: [3],
    }),
  );
}

export async function startDesk(signal) {
  await command(
    "/usr/bin/systemctl",
    ["start", SERVICE_NAME],
    "CLOUD_RELEASE_SERVICE_START",
    signal,
  );
  await command(
    "/usr/bin/systemctl",
    ["is-active", "--quiet", SERVICE_NAME],
    "CLOUD_RELEASE_SERVICE_ACTIVE",
    signal,
  );
}

async function curl(url, label, signal, discard = false, maxTime = "15", timeoutMs) {
  return await command(
    "/usr/bin/curl",
    [
      "--fail",
      "--silent",
      "--show-error",
      "--max-time",
      maxTime,
      ...(discard ? ["--output", "/dev/null"] : []),
      url,
    ],
    label,
    signal,
    timeoutMs,
  );
}

export async function assertDeskHealth(expectedSha, signal, dependencies = {}) {
  const executeCurl = dependencies.curl ?? curl;
  const loopback = await probeLoopbackWithReadiness(
    executeCurl,
    signal,
    dependencies.waitForReadiness,
  );
  const probePublic = (url, label, discard) =>
    probePublicWithReadiness(
      executeCurl,
      url,
      label,
      signal,
      discard,
      dependencies.waitForReadiness,
    );
  const publicHealth = await probePublic(
    `${PUBLIC_ORIGIN}/health`,
    "CLOUD_RELEASE_PUBLIC_HEALTH",
    false,
  );
  for (const source of [loopback.stdout, publicHealth.stdout]) {
    let parsed;
    try {
      parsed = JSON.parse(source);
    } catch (error) {
      fail("CLOUD_RELEASE_HEALTH_INVALID", error);
    }
    if (JSON.stringify(parsed) !== JSON.stringify(HEALTH_ENVELOPE)) {
      fail("CLOUD_RELEASE_HEALTH_INVALID");
    }
  }
  await probePublic(`${PUBLIC_ORIGIN}/`, "CLOUD_RELEASE_PUBLIC_SPA", true);
  const sockets = await (dependencies.command ?? command)(
    "/usr/bin/ss",
    ["-H", "-ltn", "sport", "=", `:${DESK_PORT}`],
    "CLOUD_RELEASE_DESK_BINDING",
    signal,
  );
  assertLoopbackBindings(sockets.stdout, DESK_PORT, "CLOUD_RELEASE_DESK_BINDING_INVALID");
  const marker = await (dependencies.readReleaseMarker ?? readReleaseMarker)(LIVE_ROOT);
  if (marker.git_sha !== requireSha(expectedSha)) fail("CLOUD_RELEASE_MARKER_MISMATCH");
}

export async function switchToCandidate(record) {
  await assertOrdinaryDirectory(LIVE_ROOT);
  await assertOrdinaryDirectory(record.staging_path);
  if ((await pathExists(record.rollback_path)) || (await pathExists(record.failed_path))) {
    fail("CLOUD_RELEASE_SWITCH_PATH_COLLISION");
  }
  await rename(LIVE_ROOT, record.rollback_path);
  await syncDirectory(dirname(LIVE_ROOT));
  await rename(record.staging_path, LIVE_ROOT);
  await syncDirectory(dirname(LIVE_ROOT));
}

export async function assertRollbackEvidence(record) {
  await assertOrdinaryDirectory(record.rollback_path);
  const marker = await readReleaseMarker(record.rollback_path);
  if (marker.git_sha !== record.expected_sha) {
    fail("CLOUD_RELEASE_ROLLBACK_EVIDENCE_INVALID");
  }
}

export async function restorePreviousCode(record, dependencies = {}) {
  const use = (name, fallback) => dependencies[name] ?? fallback;
  const startRestoredCode = async () => {
    await use("beforeStart", async () => undefined)(record);
    await use("startDesk", startDesk)(undefined);
    await use("assertDeskHealth", assertDeskHealth)(record.expected_sha, undefined);
    await use("assertSharedInfrastructure", assertSharedInfrastructure)(undefined);
  };
  await use("command", command)(
    "/usr/bin/systemctl",
    ["stop", SERVICE_NAME],
    "CLOUD_RELEASE_ROLLBACK_STOP",
    undefined,
  );
  if (await use("pathExists", pathExists)(LIVE_ROOT)) {
    const marker = await use("readReleaseMarker", readReleaseMarker)(LIVE_ROOT);
    if (marker.git_sha === record.expected_sha) {
      await startRestoredCode();
      return;
    }
    if (
      marker.git_sha !== record.candidate_sha ||
      (await use("pathExists", pathExists)(record.failed_path))
    ) {
      fail("CLOUD_RELEASE_ROLLBACK_LIVE_INVALID");
    }
    await use("rename", rename)(LIVE_ROOT, record.failed_path);
    await use("syncDirectory", syncDirectory)(dirname(LIVE_ROOT));
  }
  await use("assertOrdinaryDirectory", assertOrdinaryDirectory)(record.rollback_path);
  await use("rename", rename)(record.rollback_path, LIVE_ROOT);
  await use("syncDirectory", syncDirectory)(dirname(LIVE_ROOT));
  await startRestoredCode();
}
