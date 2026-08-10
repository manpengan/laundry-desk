import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import test from "node:test";

import {
  HK_VPS_ED25519_FINGERPRINT,
  REMOTE_RELEASE_LOCK,
  assertPinnedSshConfig,
  assertRequiredChecks,
  incomingArchivePath,
  releaseBootstrapScript,
  requireDigest,
  requireMigrationHead,
  requireSha,
  requireToken,
  scpArguments,
  sshArguments,
} from "./hk-vps-release-core.mjs";
import {
  deployCandidate,
  parseScannedHostKey,
  remoteStatefulArguments,
  selectCommandEnvironment,
  selectLocalEnvironment,
} from "./hk-vps-release-local.mjs";
import { withPinnedSshAuthority } from "./hk-vps-release-local-files.mjs";
import {
  CANONICAL_ORIGIN_URL,
  assertRepositoryCandidate,
} from "./hk-vps-release-local-repository.mjs";
import { parseArguments as parseLocalArguments } from "./hk-vps-release.mjs";
import { parseArguments as parseRemoteArguments } from "./hk-vps-release-remote.mjs";

const CANDIDATE = "a".repeat(40);
const EXPECTED = "b".repeat(40);
const DIGEST = "c".repeat(64);
const TOKEN = "d".repeat(32);
const MIGRATION = "0046_cloud_primary.sql";
const KNOWN_HOSTS = "/private/tmp/laundry-known-hosts";

function sshConfig(overrides = {}) {
  return {
    hostname: "103.233.252.201",
    user: "root",
    port: "22",
    passwordauthentication: "no",
    kbdinteractiveauthentication: "no",
    identityfile: "/Users/test/.ssh/hk_vps_ed25519",
    ...overrides,
  };
}

function configSource(overrides) {
  return `${Object.entries(sshConfig(overrides))
    .map(([key, value]) => `${key} ${value}`)
    .join("\n")}\n`;
}

function runInvalidBootstrap(arguments_) {
  return spawnSync("/bin/bash", ["-s", "--", ...arguments_], {
    encoding: "utf8",
    env: { LANG: "C", PATH: "/usr/bin:/bin" },
    input: releaseBootstrapScript(),
    timeout: 2_000,
  });
}

test("release identifiers accept only canonical lowercase fixed-width values", () => {
  assert.equal(requireSha(CANDIDATE), CANDIDATE);
  assert.equal(requireDigest(DIGEST), DIGEST);
  assert.equal(requireToken(TOKEN), TOKEN);
  assert.equal(requireMigrationHead(MIGRATION), MIGRATION);

  for (const value of ["A".repeat(40), `${CANDIDATE}/x`, "a".repeat(39)]) {
    assert.throws(() => requireSha(value), { code: "CLOUD_RELEASE_SHA_INVALID" });
  }
  assert.throws(() => requireDigest("c".repeat(63)), {
    code: "CLOUD_RELEASE_ARCHIVE_DIGEST_INVALID",
  });
  assert.throws(() => requireToken("d".repeat(31)), { code: "CLOUD_RELEASE_TOKEN_INVALID" });
  assert.throws(() => requireMigrationHead("0046_cloud-primary.sql"), {
    code: "CLOUD_RELEASE_MIGRATION_HEAD_INVALID",
  });
});

test("SSH and SCP arguments pin non-interactive strict-host-key operation", () => {
  assert.deepEqual(sshArguments(["/usr/bin/true"], KNOWN_HOSTS).slice(0, 10), [
    "-o",
    "BatchMode=yes",
    "-o",
    "PasswordAuthentication=no",
    "-o",
    "KbdInteractiveAuthentication=no",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "StrictHostKeyChecking=yes",
  ]);
  const remote = incomingArchivePath(CANDIDATE, TOKEN);
  const scp = scpArguments("/private/tmp/release.tar", remote, KNOWN_HOSTS);
  assert.deepEqual(scp.slice(-2), ["/private/tmp/release.tar", `hk-vps:${remote}`]);
  assert.ok(scp.includes(`UserKnownHostsFile=${KNOWN_HOSTS}`));
  assert.ok(scp.includes("HostKeyAlgorithms=ssh-ed25519"));
  assert.throws(() => scpArguments("relative.tar", remote, KNOWN_HOSTS), {
    code: "CLOUD_RELEASE_ARCHIVE_PATH_INVALID",
  });
  assert.throws(() => scpArguments("/private/tmp/release.tar", "/opt/../etc/shadow", KNOWN_HOSTS), {
    code: "CLOUD_RELEASE_REMOTE_PATH_INVALID",
  });
  assert.throws(() => sshArguments([], "relative-known-hosts"), {
    code: "CLOUD_RELEASE_KNOWN_HOSTS_INVALID",
  });
});

test("expanded SSH config must resolve exactly to the pinned direct key-only host", () => {
  assert.doesNotThrow(() => assertPinnedSshConfig(configSource()));
  for (const overrides of [
    { hostname: "example.test" },
    { user: "laundry" },
    { passwordauthentication: "yes" },
    { proxyjump: "relay" },
    { hostkeyalias: "hk-vps" },
    { identityfile: "/Users/test/.ssh/id_ed25519" },
  ]) {
    assert.throws(() => assertPinnedSshConfig(configSource(overrides)), {
      code: "CLOUD_RELEASE_SSH_CONFIG_INVALID",
    });
  }
  assert.match(HK_VPS_ED25519_FINGERPRINT, /^SHA256:[A-Za-z0-9+/]+$/u);
});

test("scanned authority accepts one pinned ed25519 record plus scanner comments only", () => {
  const key = "AAAAC3NzaC1lZDI1NTE5AAAAITestOnly";
  assert.equal(
    parseScannedHostKey(`# banner\n103.233.252.201 ssh-ed25519 ${key}\n`),
    `103.233.252.201 ssh-ed25519 ${key}`,
  );
  for (const source of [
    `example.test ssh-ed25519 ${key}\n`,
    `103.233.252.201 ssh-rsa ${key}\n`,
    `103.233.252.201 ssh-ed25519 ${key}\n103.233.252.201 ssh-ed25519 ${key}\n`,
  ]) {
    assert.throws(() => parseScannedHostKey(source), {
      code: "CLOUD_RELEASE_SSH_HOST_KEY_INVALID",
    });
  }
});

test("temporary known_hosts is private, source-exact, and removed when the operation fails", async () => {
  const key = "AAAAC3NzaC1lZDI1NTE5AAAAITestOnly";
  const scan = `103.233.252.201 ssh-ed25519 ${key}\n`;
  const execute = async (_file, _arguments, label) => {
    if (label === "CLOUD_RELEASE_SSH_CONFIG") return { stdout: configSource() };
    if (label === "CLOUD_RELEASE_SSH_KEYSCAN") return { stdout: scan };
    if (label === "CLOUD_RELEASE_SSH_FINGERPRINT") {
      return { stdout: `256 ${HK_VPS_ED25519_FINGERPRINT} host (ED25519)\n` };
    }
    assert.fail(`unexpected command: ${label}`);
  };
  const failure = new Error("operation failed");
  let temporaryRoot;
  await assert.rejects(
    () =>
      withPinnedSshAuthority(execute, async (authority) => {
        temporaryRoot = authority.temporaryRoot;
        const metadata = await lstat(authority.path);
        assert.equal(metadata.mode & 0o7777, 0o600);
        assert.equal(await readFile(authority.path, "utf8"), scan);
        throw failure;
      }),
    (error) => error === failure,
  );
  await assert.rejects(() => lstat(temporaryRoot), { code: "ENOENT" });
});

test("GitHub credentials are scoped to gh and never inherited by SSH, SCP, git, or curl", () => {
  const source = {
    GH_ENTERPRISE_TOKEN: "secret-enterprise",
    GH_HOST: "attacker.invalid",
    GH_TOKEN: "secret-gh",
    GITHUB_TOKEN: "secret-github",
    HOME: "/Users/test",
    LANG: "C.UTF-8",
    PATH: "/usr/bin:/bin",
  };
  assert.equal(selectCommandEnvironment("/opt/homebrew/bin/gh", source).GH_TOKEN, "secret-gh");
  assert.equal(selectCommandEnvironment("/opt/homebrew/bin/gh", source).GH_HOST, undefined);
  assert.equal(
    selectCommandEnvironment("/opt/homebrew/bin/gh", source).GH_ENTERPRISE_TOKEN,
    undefined,
  );
  assert.equal(selectLocalEnvironment(source).GH_HOST, undefined);
  assert.equal(selectLocalEnvironment(source).GH_ENTERPRISE_TOKEN, undefined);
  for (const file of ["/usr/bin/ssh", "/usr/bin/scp", "/usr/bin/git", "/usr/bin/curl"]) {
    const selected = selectCommandEnvironment(file, source);
    assert.equal(selected.GH_TOKEN, undefined);
    assert.equal(selected.GITHUB_TOKEN, undefined);
  }
});

test("repository and GitHub check authority are pinned before fetching", async () => {
  const labels = [];
  const checks = ["workspace-check", "real-postgres"].map((name, index) => ({
    app: { slug: "github-actions" },
    conclusion: "success",
    head_sha: CANDIDATE,
    id: index + 1,
    name,
    started_at: "2026-08-10T00:00:00.000Z",
    status: "completed",
  }));
  const execute = async (_context, _file, arguments_, label) => {
    labels.push({ arguments_, label });
    const outputs = {
      CLOUD_RELEASE_GIT_ORIGIN: `${CANONICAL_ORIGIN_URL}\n`,
      CLOUD_RELEASE_GIT_FETCH: "",
      CLOUD_RELEASE_GIT_ROOT: "/private/repository\n",
      CLOUD_RELEASE_GIT_STATUS: "",
      CLOUD_RELEASE_GIT_BRANCH: "main\n",
      CLOUD_RELEASE_GIT_HEAD: `${CANDIDATE}\n`,
      CLOUD_RELEASE_GIT_REMOTE: `${CANDIDATE}\n`,
      CLOUD_RELEASE_GITHUB_CHECKS: JSON.stringify({ check_runs: checks }),
    };
    return { code: 0, stderr: "", stdout: outputs[label] };
  };
  await assertRepositoryCandidate(
    { cwd: "/private/repository", environment: {} },
    CANDIDATE,
    execute,
    { realpath: async (path) => path },
  );
  assert.deepEqual(
    labels.slice(0, 2).map(({ label }) => label),
    ["CLOUD_RELEASE_GIT_ORIGIN", "CLOUD_RELEASE_GIT_FETCH"],
  );
  const gh = labels.find(({ label }) => label === "CLOUD_RELEASE_GITHUB_CHECKS");
  assert.deepEqual(gh.arguments_.slice(0, 3), ["api", "--hostname", "github.com"]);

  const maliciousLabels = [];
  await assert.rejects(
    () =>
      assertRepositoryCandidate(
        { cwd: "/private/repository", environment: {} },
        CANDIDATE,
        async (_context, _file, _arguments, label) => {
          maliciousLabels.push(label);
          return { code: 0, stderr: "", stdout: "ssh://attacker.invalid/repository\n" };
        },
      ),
    { code: "CLOUD_RELEASE_GIT_ORIGIN_INVALID" },
  );
  assert.deepEqual(maliciousLabels, ["CLOUD_RELEASE_GIT_ORIGIN"]);
});

test("a partially failed SCP still attempts exact remote archive cleanup", async () => {
  const events = [];
  const uploadFailure = new Error("partial upload");
  await assert.rejects(
    () =>
      deployCandidate(
        { cwd: "/private/tmp/repository", environment: {}, signal: undefined },
        {
          candidateSha: CANDIDATE,
          expectedSha: EXPECTED,
          migrationHead: MIGRATION,
          token: TOKEN,
        },
        {
          assertRepositoryCandidate: async () => undefined,
          command: async (_context, _file, arguments_, label) => {
            events.push({ arguments_, label });
            if (label === "CLOUD_RELEASE_UPLOAD") throw uploadFailure;
            return { code: 0, stderr: "", stdout: "" };
          },
          createArchive: async () => ({
            archivePath: "/private/tmp/release.tar",
            digest: DIGEST,
            temporaryRoot: "/private/tmp/release-archive-root",
          }),
          rm: async (path) => events.push({ label: `LOCAL_RM:${path}` }),
          withPinnedSshAuthority: async (_execute, operation) =>
            await operation({ path: KNOWN_HOSTS }),
        },
      ),
    (error) => error === uploadFailure,
  );
  assert.deepEqual(
    events.map(({ label }) => label),
    [
      "CLOUD_RELEASE_UPLOAD",
      "CLOUD_RELEASE_REMOTE_ARCHIVE_CLEANUP",
      "LOCAL_RM:/private/tmp/release-archive-root",
    ],
  );
  const cleanup = events[1];
  assert.deepEqual(cleanup.arguments_.slice(-4), [
    "/usr/bin/rm",
    "-f",
    "--",
    incomingArchivePath(CANDIDATE, TOKEN),
  ]);
});

test("required CI checks use the newest rerun for each required name", () => {
  const successful = [
    {
      app: { slug: "github-actions" },
      head_sha: CANDIDATE,
      name: "workspace-check",
      status: "completed",
      conclusion: "failure",
      completed_at: "2026-08-10T01:00:00Z",
    },
    {
      app: { slug: "github-actions" },
      head_sha: CANDIDATE,
      name: "workspace-check",
      status: "completed",
      conclusion: "success",
      completed_at: "2026-08-10T02:00:00Z",
    },
    {
      app: { slug: "github-actions" },
      head_sha: CANDIDATE,
      name: "real-postgres",
      status: "completed",
      conclusion: "success",
      completed_at: "2026-08-10T02:00:00Z",
    },
  ];
  assert.doesNotThrow(() => assertRequiredChecks(successful, CANDIDATE));
  assert.throws(
    () =>
      assertRequiredChecks(
        [
          ...successful,
          {
            app: { slug: "github-actions" },
            head_sha: CANDIDATE,
            name: "real-postgres",
            status: "completed",
            conclusion: "failure",
            completed_at: "2026-08-10T03:00:00Z",
          },
        ],
        CANDIDATE,
      ),
    { code: "CLOUD_RELEASE_CI_NOT_GREEN" },
  );
  assert.throws(
    () =>
      assertRequiredChecks(
        [
          ...successful,
          {
            app: { slug: "github-actions" },
            head_sha: CANDIDATE,
            name: "workspace-check",
            status: "in_progress",
            conclusion: null,
            started_at: "2026-08-10T03:00:00Z",
            completed_at: null,
          },
        ],
        CANDIDATE,
      ),
    { code: "CLOUD_RELEASE_CI_NOT_GREEN" },
  );
  for (const poisoned of [
    { ...successful[1], app: { slug: "third-party" } },
    { ...successful[1], head_sha: EXPECTED },
  ]) {
    assert.throws(
      () =>
        assertRequiredChecks(
          successful.map((run, index) => (index === 1 ? poisoned : run)),
          CANDIDATE,
        ),
      { code: "CLOUD_RELEASE_CI_NOT_GREEN" },
    );
  }
});

test("bootstrap validates argc and every path-bearing token before destructive cleanup", () => {
  const script = releaseBootstrapScript();
  const cleanup = script.indexOf('rm -f -- "${archive}"');
  for (const validation of [
    'test "$#" -eq 5',
    'test "${#candidate}" -eq 40',
    'test "${#digest}" -eq 64',
    "CLOUD_RELEASE_MIGRATION_HEAD_INVALID",
    'test "${candidate}" != "${expected}"',
  ]) {
    assert.ok(script.indexOf(validation) >= 0 && script.indexOf(validation) < cleanup);
  }
  assert.ok(cleanup > 0);
  assert.doesNotMatch(script, /\beval\b/u);
  assert.ok(script.indexOf("umask 022") < script.indexOf("tar --extract"));
  assert.match(script, new RegExp(`lock="${REMOTE_RELEASE_LOCK}"`, "u"));

  const invalidCases = [
    [],
    [CANDIDATE, EXPECTED, DIGEST, TOKEN],
    ["A".repeat(40), EXPECTED, DIGEST, TOKEN, MIGRATION],
    [CANDIDATE, EXPECTED, `${DIGEST}/`, TOKEN, MIGRATION],
    [CANDIDATE, EXPECTED, DIGEST, `${TOKEN}.`, MIGRATION],
    [CANDIDATE, EXPECTED, DIGEST, TOKEN, "0046_cloud-primary.sql"],
    [CANDIDATE, CANDIDATE, DIGEST, TOKEN, MIGRATION],
  ];
  for (const arguments_ of invalidCases) {
    const result = runInvalidBootstrap(arguments_);
    assert.notEqual(result.status, 0, JSON.stringify(arguments_));
    assert.doesNotMatch(result.stderr, /No such file|Permission denied/u);
  }
});

test("every follow-up stateful remote action uses the same non-blocking release lock", () => {
  const options = {
    candidateSha: CANDIDATE,
    expectedSha: EXPECTED,
    migrationHead: MIGRATION,
    token: TOKEN,
  };
  for (const action of ["api-evidence", "finalize", "rollback"]) {
    const arguments_ = remoteStatefulArguments(action, options, KNOWN_HOSTS);
    const lockIndex = arguments_.indexOf(REMOTE_RELEASE_LOCK);
    assert.ok(lockIndex > 0);
    assert.deepEqual(arguments_.slice(lockIndex - 4, lockIndex + 1), [
      "/usr/bin/flock",
      "-n",
      "-E",
      "73",
      REMOTE_RELEASE_LOCK,
    ]);
  }
  assert.throws(() => remoteStatefulArguments("status", options, KNOWN_HOSTS), {
    code: "CLOUD_RELEASE_ACTION_INVALID",
  });
});

test("release marker mode is made exact even when the caller starts with a private umask", () => {
  const source = readFileSync(
    new URL("./hk-vps-release-remote-system.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /await handle\.chmod\(0o644\);/u);
});

test("status is serialized with the release lock and redacts the transition token", () => {
  const source = readFileSync(new URL("./hk-vps-release-local.mjs", import.meta.url), "utf8");
  assert.ok(source.includes('exec 9>"${REMOTE_RELEASE_LOCK}"'));
  assert.match(source, /flock -n 9/u);
  assert.doesNotMatch(source, /stdout: `CLOUD_RELEASE_REMOTE_STATUS[^`]*token=/u);
});

test("local and remote release CLIs reject ambiguous or incomplete identities", () => {
  const identity = [
    "--candidate-sha",
    CANDIDATE,
    "--expected-current-sha",
    EXPECTED,
    "--migration-head",
    MIGRATION,
  ];
  assert.equal(parseLocalArguments(["--action", "prepare", ...identity]).action, "prepare");
  assert.equal(parseLocalArguments(["--", "--action", "prepare", ...identity]).action, "prepare");
  assert.equal(
    parseRemoteArguments([...identity, "--release-token", TOKEN, "--archive-sha256", DIGEST])
      .action,
    "deploy",
  );
  for (const arguments_ of [
    ["--action", "prepare", ...identity, "--unknown", "value"],
    ["--action", "finalize", ...identity],
    ["--action", "status", "--candidate-sha", CANDIDATE],
    ["--", "--", "--action", "status"],
  ]) {
    assert.throws(() => parseLocalArguments(arguments_), {
      code: "CLOUD_RELEASE_ARGS_INVALID",
    });
  }
  assert.throws(() => parseRemoteArguments(identity), {
    code: "CLOUD_RELEASE_ARGS_INVALID",
  });
});
