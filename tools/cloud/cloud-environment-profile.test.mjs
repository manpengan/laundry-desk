import assert from "node:assert/strict";
import test from "node:test";

import { ADR36_PUBLIC_ORIGIN } from "./adr36-web-core.mjs";
import {
  CLOUD_ENVIRONMENT_PROFILE_NAMES,
  DEFAULT_CLOUD_ENVIRONMENT_PROFILE,
  requireCloudEnvironmentProfile,
  resolveCloudEnvironmentProfile,
} from "./cloud-environment-profile.mjs";
import { assertPinnedSshConfig, scpArguments, sshArguments } from "./cloud-environment-ssh.mjs";
import {
  DATA_PROTECTION_ENVIRONMENT,
  DATA_PROTECTION_OFFSITE_MARKER,
  DATA_PROTECTION_OFFSITE_ROOT,
  DATA_PROTECTION_PHOTO_MARKER,
  DATA_PROTECTION_PHOTO_MARKER_CONTENT,
  DATA_PROTECTION_PHOTO_ROOT,
  DATA_PROTECTION_ROOT,
} from "./hk-vps-data-protection-contract.mjs";
import { DATA_PROTECTION_OFFSITE_AUTHORITY_PATH } from "./hk-vps-data-protection-offsite-authority.mjs";
import {
  ACCEPTANCE_ENV_PATH,
  ACCEPTANCE_SECRET_ROOT,
  SERVER_ENV_PATH,
} from "./hk-vps-release-acceptance-secrets.mjs";
import { ARCHIVE_ROOT } from "./hk-vps-release-artifact-archive.mjs";
import { CONTROLLER_ROOT } from "./hk-vps-release-controller-contract.mjs";
import {
  KB_HEALTH_URL,
  PUBLIC_ORIGIN,
  REMOTE_RELEASE_LOCK,
  incomingArchivePath,
  releaseBootstrapScript,
} from "./hk-vps-release-core.mjs";
import { FINALIZE_EVIDENCE_ROOT } from "./hk-vps-release-finalize-evidence.mjs";
import { parseScannedHostKey } from "./hk-vps-release-local-files.mjs";
import { assertProfileExternalHealth } from "./hk-vps-release-local-health.mjs";
import {
  MAINTENANCE_ROOT,
  maintenanceIncomingPath,
  maintenanceInstallScript,
  maintenancePrepareScript,
  maintenanceTreePath,
  parseMaintenanceArguments,
} from "./hk-vps-release-maintenance.mjs";
import {
  BACKUP_ROOT,
  ENV_FILE,
  LIVE_ROOT,
  RELEASE_ENVIRONMENT,
  SERVICE_NAME,
  STATE_ROOT,
} from "./hk-vps-release-remote-support.mjs";
import { runPinnedSshReleaseCommand } from "./hk-vps-release-process.mjs";
import { parseArguments as parseReleaseArguments } from "./hk-vps-release.mjs";

const CANDIDATE = "a".repeat(40);
const TOKEN = "b".repeat(32);
const KNOWN_HOSTS = "/private/tmp/laundry-known-hosts";

function sshConfig(profile, overrides = {}) {
  return `${Object.entries({
    hostname: profile.ssh.host,
    user: profile.ssh.user,
    port: profile.ssh.port,
    passwordauthentication: "no",
    kbdinteractiveauthentication: "no",
    identityfile: `/Users/test${profile.ssh.identitySuffix}`,
    ...overrides,
  })
    .map(([key, value]) => `${key} ${value}`)
    .join("\n")}\n`;
}

test("environment allowlist exposes one deeply frozen synthetic hk-vps profile", () => {
  const profile = DEFAULT_CLOUD_ENVIRONMENT_PROFILE;
  assert.deepEqual(CLOUD_ENVIRONMENT_PROFILE_NAMES, ["hk-vps-cloud-test"]);
  assert.equal(resolveCloudEnvironmentProfile(), profile);
  assert.equal(resolveCloudEnvironmentProfile(profile.name), profile);
  assert.equal(requireCloudEnvironmentProfile(profile), profile);
  assert.equal(profile.environmentMarker, profile.name);
  assert.equal(profile.dataPolicy, "synthetic-only");
  for (const value of [
    profile,
    profile.endpoints,
    profile.markers,
    profile.paths,
    profile.services,
    profile.ssh,
  ]) {
    assert.equal(Object.isFrozen(value), true);
  }
});

test("unknown names and forged profile objects fail before a boundary can use them", async () => {
  const profile = DEFAULT_CLOUD_ENVIRONMENT_PROFILE;
  const forged = Object.freeze({ ...profile });
  for (const value of ["production", "../hk-vps-cloud-test", forged, null, {}]) {
    assert.throws(() => requireCloudEnvironmentProfile(value), {
      code: "CLOUD_ENVIRONMENT_PROFILE_INVALID",
    });
  }
  assert.throws(() => sshArguments([], KNOWN_HOSTS, forged), {
    code: "CLOUD_ENVIRONMENT_PROFILE_INVALID",
  });
  assert.throws(
    () =>
      runPinnedSshReleaseCommand(
        "/usr/bin/ssh",
        sshArguments(["/usr/bin/true"], KNOWN_HOSTS, profile),
        { label: "CLOUD_RELEASE_REMOTE_DEPLOY", profile: forged },
      ),
    { code: "CLOUD_ENVIRONMENT_PROFILE_INVALID" },
  );
  let commands = 0;
  await assert.rejects(
    () =>
      assertProfileExternalHealth({ profile: forged }, async () => {
        commands += 1;
      }),
    { code: "CLOUD_ENVIRONMENT_PROFILE_INVALID" },
  );
  assert.equal(commands, 0);
});

test("release and maintenance CLIs accept only an allowlisted profile, never host or path input", () => {
  const name = DEFAULT_CLOUD_ENVIRONMENT_PROFILE.name;
  assert.deepEqual(parseReleaseArguments(["--action", "status"]), { action: "status" });
  assert.deepEqual(parseReleaseArguments(["--action", "status", "--profile", name]), {
    action: "status",
    profileName: name,
  });
  assert.deepEqual(parseMaintenanceArguments(["--profile", name, "--candidate-sha", CANDIDATE]), {
    candidateSha: CANDIDATE,
    profileName: name,
  });
  for (const arguments_ of [
    ["--action", "status", "--profile", "production"],
    ["--action", "status", "--host", "attacker.invalid"],
    ["--action", "status", "--user", "root"],
    ["--action", "status", "--path", "/opt/laundry-desk"],
  ]) {
    assert.throws(() => parseReleaseArguments(arguments_));
  }
  assert.throws(
    () => parseMaintenanceArguments(["--candidate-sha", CANDIDATE, "--profile", "production"]),
    { code: "CLOUD_ENVIRONMENT_PROFILE_INVALID" },
  );
});

test("profile-aware SSH, archive paths, and host records preserve the pinned hk-vps boundary", () => {
  const profile = DEFAULT_CLOUD_ENVIRONMENT_PROFILE;
  const remote = incomingArchivePath(CANDIDATE, TOKEN, profile);
  assert.equal(sshArguments(["/usr/bin/true"], KNOWN_HOSTS, profile).at(-2), profile.ssh.alias);
  assert.deepEqual(
    scpArguments("/private/tmp/release.tar", remote, KNOWN_HOSTS, profile).slice(-2),
    ["/private/tmp/release.tar", `${profile.ssh.alias}:${remote}`],
  );
  assert.doesNotThrow(() => assertPinnedSshConfig(sshConfig(profile), profile));
  assert.throws(
    () => assertPinnedSshConfig(sshConfig(profile, { hostname: "attacker.invalid" }), profile),
    { code: "CLOUD_RELEASE_SSH_CONFIG_INVALID" },
  );
  const key = "AAAAC3NzaC1lZDI1NTE5AAAAITestOnly";
  assert.equal(
    parseScannedHostKey(`${profile.ssh.host} ssh-ed25519 ${key}\n`, profile),
    `${profile.ssh.host} ssh-ed25519 ${key}`,
  );
});

test("legacy release and data-protection constants are exact projections of the default profile", () => {
  const profile = DEFAULT_CLOUD_ENVIRONMENT_PROFILE;
  assert.equal(PUBLIC_ORIGIN, profile.endpoints.deskPublicOrigin);
  assert.equal(ADR36_PUBLIC_ORIGIN, profile.endpoints.deskPublicOrigin);
  assert.equal(KB_HEALTH_URL, profile.endpoints.kbPublicHealthUrl);
  assert.equal(REMOTE_RELEASE_LOCK, profile.paths.releaseLock);
  assert.equal(LIVE_ROOT, profile.paths.liveRoot);
  assert.equal(STATE_ROOT, profile.paths.releaseStateRoot);
  assert.equal(BACKUP_ROOT, profile.paths.releaseBackupRoot);
  assert.equal(CONTROLLER_ROOT, profile.paths.controllerRoot);
  assert.equal(ARCHIVE_ROOT, profile.paths.archiveRoot);
  assert.equal(FINALIZE_EVIDENCE_ROOT, profile.paths.releaseStateRoot);
  assert.equal(MAINTENANCE_ROOT, profile.paths.maintenanceRoot);
  assert.equal(ACCEPTANCE_SECRET_ROOT, profile.paths.acceptanceSecretRoot);
  assert.equal(ACCEPTANCE_ENV_PATH, profile.paths.acceptanceEnvironmentFile);
  assert.equal(SERVER_ENV_PATH, profile.paths.serverEnvironmentFile);
  assert.equal(ENV_FILE, profile.paths.serverEnvironmentFile);
  assert.equal(SERVICE_NAME, profile.services.desk);
  assert.equal(RELEASE_ENVIRONMENT, profile.environmentMarker);
  assert.equal(DATA_PROTECTION_ENVIRONMENT, profile.environmentMarker);
  assert.equal(DATA_PROTECTION_ROOT, profile.paths.dataProtectionRoot);
  assert.equal(DATA_PROTECTION_PHOTO_ROOT, profile.paths.dataProtectionPhotoRoot);
  assert.equal(DATA_PROTECTION_OFFSITE_ROOT, profile.paths.dataProtectionOffsiteRoot);
  assert.equal(DATA_PROTECTION_OFFSITE_AUTHORITY_PATH, profile.paths.dataProtectionAuthorityFile);
  assert.equal(DATA_PROTECTION_OFFSITE_MARKER, profile.markers.offsiteStoreFile);
  assert.equal(DATA_PROTECTION_PHOTO_MARKER, profile.markers.photoStoreFile);
  assert.equal(DATA_PROTECTION_PHOTO_MARKER_CONTENT, profile.markers.photoStoreContent);
});

test("bootstrap, maintenance, and external probes consume the selected profile exactly", async () => {
  const profile = DEFAULT_CLOUD_ENVIRONMENT_PROFILE;
  const bootstrap = releaseBootstrapScript(profile);
  assert.match(bootstrap, new RegExp(`lock="${profile.paths.releaseLock}"`, "u"));
  assert.ok(bootstrap.includes(`${profile.paths.liveRoot}.incoming-`));
  assert.ok(bootstrap.includes(profile.paths.nodeExecutable));
  assert.equal(
    maintenanceIncomingPath(CANDIDATE, TOKEN, profile),
    `${profile.paths.maintenanceRoot}/incoming-${CANDIDATE}-${TOKEN}.tar`,
  );
  assert.equal(
    maintenanceTreePath(CANDIDATE, profile),
    `${profile.paths.maintenanceRoot}/trees/${CANDIDATE}`,
  );
  assert.ok(maintenancePrepareScript(profile).includes(`root=${profile.paths.maintenanceRoot}`));
  assert.ok(maintenanceInstallScript(profile).includes(`lock=${profile.paths.releaseLock}`));

  const calls = [];
  await assertProfileExternalHealth({ profile }, async (_context, file, arguments_, label) => {
    calls.push({ arguments_, file, label });
    if (label === "CLOUD_RELEASE_EXTERNAL_HEALTH") {
      return { stdout: '{"ok":true,"data":{"status":"ready"}}' };
    }
    if (label === "CLOUD_RELEASE_EXTERNAL_KB") return { stdout: "ok\n" };
    return { stdout: "" };
  });
  assert.deepEqual(
    calls.map(({ arguments_ }) => arguments_.at(-1)),
    [
      `${profile.endpoints.deskPublicOrigin}/health`,
      profile.endpoints.deskPublicOrigin,
      profile.endpoints.kbPublicHealthUrl,
    ],
  );
  assert.ok(calls.every(({ file }) => file === "/usr/bin/curl"));
});
