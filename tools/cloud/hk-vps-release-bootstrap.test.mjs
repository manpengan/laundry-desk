import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { REMOTE_SIGNAL_RECOVERY_GRACE_SECONDS } from "./hk-vps-release-bootstrap-signal.mjs";
import { REMOTE_RELEASE_LOCK, releaseBootstrapScript } from "./hk-vps-release-core.mjs";
import { parseSafeRemoteReleaseErrorCode } from "./hk-vps-release-remote-error-contract.mjs";

const CANDIDATE = "a".repeat(40);
const EXPECTED = "b".repeat(40);
const DIGEST = "c".repeat(64);
const TOKEN = "d".repeat(32);
const MIGRATION = "0046_cloud_primary.sql";
const BOOTSTRAP_FIXTURE_TIMEOUT_MS = 10_000;

function installPortableProcessRecord(script) {
  const start = script.indexOf("read_process_record() {");
  const end = script.indexOf("read_process_identity() {");
  assert.ok(start >= 0 && end > start);
  const portable = `read_process_record() {
  local process_pid="$1" process_state=""
  process_state="$(/bin/ps -o state= -p "\${process_pid}" 2>/dev/null |
    /usr/bin/awk 'NR == 1 { print substr($1, 1, 1) }')" || return 1
  [ -n "\${process_state}" ] || return 1
  printf '%s:fixture %s\\n' "\${process_pid}" "\${process_state}"
}
`;
  return `${script.slice(0, start)}${portable}${script.slice(end)}`;
}

function bootstrapFixtureScript({ archive, graceSeconds, killMarkerPath, lock, node, staging }) {
  let script = installPortableProcessRecord(releaseBootstrapScript())
    .replace(
      'archive="/opt/laundry-desk.incoming-${candidate}-${token}.tar"',
      `archive=${JSON.stringify(archive)}`,
    )
    .replace('staging="/opt/laundry-desk.next-${candidate}"', `staging=${JSON.stringify(staging)}`)
    .replace(`lock="${REMOTE_RELEASE_LOCK}"`, `lock=${JSON.stringify(lock)}`)
    .replace(
      '/opt/nodejs/bin/node "${staging}/tools/cloud/hk-vps-release-remote.mjs"',
      `${JSON.stringify(node)} "${staging}/tools/cloud/hk-vps-release-remote.mjs"`,
    );
  if (graceSeconds !== undefined) {
    script = script.replace(
      `remaining=${REMOTE_SIGNAL_RECOVERY_GRACE_SECONDS}`,
      `remaining=${graceSeconds}`,
    );
  }
  if (killMarkerPath !== undefined) {
    script = script.replace(
      'kill -KILL "${remote_pid}" >/dev/null 2>&1 || true',
      `printf 'kill\\n' >${JSON.stringify(killMarkerPath)} 2>/dev/null || true\n        kill -KILL "\${remote_pid}" >/dev/null 2>&1 || true`,
    );
  }
  return script;
}

async function writeExecutable(path, source) {
  await writeFile(path, source, { mode: 0o700 });
  await chmod(path, 0o700);
}

async function createCommands(root) {
  const commands = join(root, "commands");
  await mkdir(commands, { mode: 0o700 });
  await Promise.all([
    writeExecutable(join(commands, "chmod"), "#!/bin/sh\nexit 0\n"),
    writeExecutable(join(commands, "flock"), "#!/bin/sh\nexit 0\n"),
    writeExecutable(
      join(commands, "rm"),
      "#!/bin/sh\n" +
        'if [ "$FAKE_RM_RESULT" = failure ]; then\n' +
        "  printf 'private cleanup detail\\n' >&2\n" +
        "  exit 99\n" +
        "fi\n" +
        'if [ "$1" = -rf ] && [ "$2" = --one-file-system ]; then\n' +
        "  shift 2\n" +
        '  exec /bin/rm -rf "$@"\n' +
        "fi\n" +
        'exec /bin/rm "$@"\n',
    ),
    writeExecutable(
      join(commands, "sha256sum"),
      '#!/bin/sh\nprintf \'%s  %s\\n\' "$FAKE_DIGEST" "$1"\n',
    ),
    writeExecutable(
      join(commands, "stat"),
      "#!/bin/sh\n" +
        "if [ \"$2\" = '%U:%G:%h:%d:%i' ]; then\n" +
        "  printf '%s\\n' \"${FAKE_ARCHIVE_METADATA:-root:root:1:1:1}\"\n" +
        "else\n" +
        "  printf '1:1\\n'\n" +
        "fi\n",
    ),
    writeExecutable(
      join(commands, "tar"),
      "#!/bin/sh\n" +
        'if [ "$FAKE_TAR_RESULT" = failure ]; then\n' +
        "  printf 'private extract path %s\\n' \"$*\" >&2\n" +
        "  exit 1\n" +
        "fi\n",
    ),
  ]);
  return commands;
}

async function prepareBootstrap(root, commands, label, options = {}) {
  const stageRoot = join(root, label);
  const archive = join(stageRoot, "archive.tar");
  const staging = options.stagingParentMissing
    ? join(stageRoot, "missing", "staging")
    : join(stageRoot, "staging");
  const node = join(stageRoot, "node");
  const lock = options.lockFails
    ? join(stageRoot, "missing", "release.lock")
    : join(stageRoot, "release.lock");
  await mkdir(stageRoot, { mode: 0o700 });
  if (options.archivePresent !== false) await writeFile(archive, "archive", { mode: 0o600 });
  if (options.stagingKind === "directory") {
    await mkdir(staging, { mode: 0o755 });
    await writeFile(join(staging, "sentinel"), "keep", { mode: 0o600 });
  } else if (options.stagingKind === "file") {
    await writeFile(staging, "keep", { mode: 0o600 });
  } else if (options.stagingKind === "symlink") {
    const target = join(stageRoot, "collision-target");
    await mkdir(target, { mode: 0o700 });
    await writeFile(join(target, "sentinel"), "keep", { mode: 0o600 });
    await symlink(target, staging);
  }
  await writeExecutable(
    node,
    options.nodeSource ?? "#!/bin/sh\nprintf 'CLOUD_RELEASE_INSTALL_FAILED\\n' >&2\nexit 1\n",
  );
  return {
    archive,
    environment: {
      FAKE_DIGEST: options.digestMismatch ? "e".repeat(64) : DIGEST,
      FAKE_ARCHIVE_METADATA: options.archiveMetadata ?? "",
      FAKE_RM_RESULT: options.rmFails ? "failure" : "success",
      FAKE_TAR_RESULT: options.tarFails ? "failure" : "success",
      LANG: "C",
      PATH: `${commands}:/usr/bin:/bin:/sbin`,
      ...(options.environment ?? {}),
    },
    input: bootstrapFixtureScript({
      archive,
      graceSeconds: options.graceSeconds,
      killMarkerPath: options.killMarkerPath,
      lock,
      node,
      staging,
    }),
    staging,
  };
}

async function runBootstrap(root, commands, label, options = {}) {
  const fixture = await prepareBootstrap(root, commands, label, options);
  const result = spawnSync(
    "/bin/bash",
    ["-s", "--", CANDIDATE, EXPECTED, DIGEST, TOKEN, MIGRATION],
    {
      encoding: "utf8",
      env: fixture.environment,
      input: fixture.input,
      timeout: BOOTSTRAP_FIXTURE_TIMEOUT_MS,
    },
  );
  assert.equal(result.error, undefined, result.error?.message);
  return { ...fixture, result };
}

function assertSafeFailure(result, code, status = 74) {
  assert.equal(result.status, status);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, `${code}\n`);
  assert.equal(parseSafeRemoteReleaseErrorCode(result.stdout, result.stderr), code);
}

async function waitForText(path, timeoutMs = BOOTSTRAP_FIXTURE_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("fixture marker timeout");
}

async function runSignalledBootstrap(fixture, signal, timeoutMs = 7_000) {
  const child = spawn("/bin/bash", ["-s", "--", CANDIDATE, EXPECTED, DIGEST, TOKEN, MIGRATION], {
    env: fixture.environment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  child.stdin.end(fixture.input);
  await waitForText(fixture.environment.FAKE_NODE_PID_PATH);
  assert.equal(child.kill(signal), true);
  const outcome = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("signalled bootstrap did not exit")),
      timeoutMs,
    );
    child.once("close", (status, closeSignal) => {
      clearTimeout(timer);
      resolve({
        signal: closeSignal,
        status,
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdout: Buffer.concat(stdout).toString("utf8"),
      });
    });
  });
  return outcome;
}

async function runParentDisconnectedBootstrap(fixture, root, timeoutMs = 10_000) {
  const scriptPath = join(root, "parent-disconnect-bootstrap.sh");
  await writeFile(scriptPath, fixture.input, { mode: 0o700 });
  const wrapper =
    '"/bin/bash" "$1" "$2" "$3" "$4" "$5" "$6" &\n' +
    'while [ ! -s "$FAKE_NODE_PID_PATH" ]; do /bin/sleep 0.02; done\n';
  const child = spawn(
    "/bin/bash",
    ["-c", wrapper, "fixture", scriptPath, CANDIDATE, EXPECTED, DIGEST, TOKEN, MIGRATION],
    { env: fixture.environment, stdio: ["ignore", "pipe", "pipe"] },
  );
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("parent-disconnect bootstrap did not exit")),
      timeoutMs,
    );
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      resolve({
        signal,
        status,
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdout: Buffer.concat(stdout).toString("utf8"),
      });
    });
  });
}

test("bootstrap binds Linux process identity to start time and rejects zombie activity", () => {
  const script = releaseBootstrapScript();
  assert.match(script, /<"\/proc\/\$\{process_pid\}\/stat"/u);
  assert.match(script, /process_start="\$\{process_fields\[19\]\}"/u);
  assert.ok(script.includes('[ "${process_state}" != Z ]'));
  assert.ok(script.includes('[ "${process_state}" != X ]'));
});

test("bootstrap stages return stable errors and never remove a collided staging tree", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloud-release-bootstrap-"));
  try {
    const commands = await createCommands(root);
    const stages = [
      ["lock", { lockFails: true }, "CLOUD_RELEASE_BOOTSTRAP_LOCK_FAILED"],
      ["archive", { archivePresent: false }, "CLOUD_RELEASE_BOOTSTRAP_ARCHIVE_INVALID"],
      [
        "archive-hardlink",
        { archiveMetadata: "root:root:2:1:1" },
        "CLOUD_RELEASE_BOOTSTRAP_ARCHIVE_INVALID",
      ],
      ["digest", { digestMismatch: true }, "CLOUD_RELEASE_BOOTSTRAP_ARCHIVE_DIGEST_MISMATCH"],
      [
        "collision-directory",
        { stagingKind: "directory" },
        "CLOUD_RELEASE_BOOTSTRAP_STAGING_COLLISION",
      ],
      ["collision-file", { stagingKind: "file" }, "CLOUD_RELEASE_BOOTSTRAP_STAGING_COLLISION"],
      [
        "collision-symlink",
        { stagingKind: "symlink" },
        "CLOUD_RELEASE_BOOTSTRAP_STAGING_COLLISION",
      ],
      [
        "staging-create",
        { stagingParentMissing: true },
        "CLOUD_RELEASE_BOOTSTRAP_STAGING_CREATE_FAILED",
      ],
      ["extract", { tarFails: true }, "CLOUD_RELEASE_BOOTSTRAP_EXTRACT_FAILED"],
      [
        "cleanup",
        { digestMismatch: true, rmFails: true },
        "CLOUD_RELEASE_BOOTSTRAP_CLEANUP_FAILED",
      ],
    ];
    for (const [label, options, code] of stages) {
      const fixture = await runBootstrap(root, commands, label, options);
      assertSafeFailure(fixture.result, code);
      if (label === "collision-directory") {
        assert.equal(await readFile(join(fixture.staging, "sentinel"), "utf8"), "keep");
      } else if (label === "collision-file") {
        assert.equal(await readFile(fixture.staging, "utf8"), "keep");
      } else if (label === "collision-symlink") {
        assert.equal((await lstat(fixture.staging)).isSymbolicLink(), true);
        assert.equal(
          await readFile(join(root, label, "collision-target", "sentinel"), "utf8"),
          "keep",
        );
      } else if (label === "cleanup") {
        assert.equal(await readFile(fixture.archive, "utf8"), "archive");
      } else {
        await assert.rejects(lstat(fixture.staging), { code: "ENOENT" });
      }
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("bootstrap preserves one safe remote code and folds every noisy remote failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloud-release-bootstrap-"));
  try {
    const commands = await createCommands(root);
    const cases = [
      [
        "safe",
        "#!/bin/sh\nprintf 'CLOUD_RELEASE_RECOVERY_REQUIRED\\n' >&2\nexit 1\n",
        "CLOUD_RELEASE_RECOVERY_REQUIRED",
      ],
      [
        "multiline",
        "#!/bin/sh\nprintf 'CLOUD_RELEASE_INSTALL_FAILED\\nsecret=%s\\n' \"$5\" >&2\nexit 1\n",
        "CLOUD_RELEASE_BOOTSTRAP_REMOTE_ENTRY_FAILED",
      ],
      [
        "no-newline",
        "#!/bin/sh\nprintf 'CLOUD_RELEASE_INSTALL_FAILED' >&2\nexit 1\n",
        "CLOUD_RELEASE_BOOTSTRAP_REMOTE_ENTRY_FAILED",
      ],
      [
        "unknown-code",
        "#!/bin/sh\nprintf 'CLOUD_RELEASE_FAILED\\n' >&2\nexit 1\n",
        "CLOUD_RELEASE_BOOTSTRAP_REMOTE_ENTRY_FAILED",
      ],
      [
        "stdout-noise",
        "#!/bin/sh\nprintf 'noise\\n'\nprintf 'CLOUD_RELEASE_INSTALL_FAILED\\n' >&2\nexit 1\n",
        "CLOUD_RELEASE_BOOTSTRAP_REMOTE_ENTRY_FAILED",
      ],
    ];
    for (const [label, nodeSource, code] of cases) {
      const { result, staging } = await runBootstrap(root, commands, label, { nodeSource });
      assertSafeFailure(result, code, label === "safe" ? 1 : 74);
      assert.doesNotMatch(result.stderr, new RegExp(TOKEN, "u"));
      await assert.rejects(lstat(staging), { code: "ENOENT" });
    }

    const recovery = await runBootstrap(root, commands, "recovery-cleanup", {
      nodeSource: "#!/bin/sh\nprintf 'CLOUD_RELEASE_RECOVERY_REQUIRED\\n' >&2\nexit 1\n",
      rmFails: true,
    });
    assertSafeFailure(recovery.result, "CLOUD_RELEASE_RECOVERY_REQUIRED", 1);

    const success = await runBootstrap(root, commands, "success", {
      nodeSource: "#!/bin/sh\nprintf 'CLOUD_RELEASE_AWAITING_EXTERNAL_VERIFICATION\\n'\n",
    });
    assert.equal(success.result.status, 0);
    assert.equal(success.result.stdout, "CLOUD_RELEASE_AWAITING_EXTERNAL_VERIFICATION\n");
    assert.equal(success.result.stderr, "");
    await assert.rejects(lstat(success.staging), { code: "ENOENT" });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("bootstrap forwards shell-only signals and reaps the remote release process", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloud-release-bootstrap-"));
  try {
    const commands = await createCommands(root);
    for (const signal of ["SIGTERM", "SIGHUP"]) {
      const label = signal.toLowerCase();
      const nodePidPath = join(root, `${label}.pid`);
      const signalPath = join(root, `${label}.signal`);
      const killMarkerPath = join(root, `${label}.kill`);
      const fixture = await prepareBootstrap(root, commands, label, {
        environment: {
          FAKE_NODE_PID_PATH: nodePidPath,
          FAKE_SIGNAL_PATH: signalPath,
        },
        killMarkerPath,
        nodeSource:
          "#!/bin/sh\n" +
          'printf \'%s\\n\' "$$" >"$FAKE_NODE_PID_PATH"\n' +
          "finish() {\n" +
          "  printf '%s\\n' signal >\"$FAKE_SIGNAL_PATH\"\n" +
          "  printf 'CLOUD_RELEASE_RECOVERY_REQUIRED\\n' >&2\n" +
          "  exit 1\n" +
          "}\n" +
          "trap finish HUP INT TERM\n" +
          "while :; do /bin/sleep 0.1; done\n",
      });
      const result = await runSignalledBootstrap(fixture, signal);
      assert.equal(result.signal, null);
      assertSafeFailure(result, "CLOUD_RELEASE_RECOVERY_REQUIRED");
      assert.equal(await readFile(signalPath, "utf8"), "signal\n");
      const nodePid = Number.parseInt(await readFile(nodePidPath, "utf8"), 10);
      assert.throws(() => process.kill(nodePid, 0), { code: "ESRCH" });
      await assert.rejects(lstat(killMarkerPath), { code: "ENOENT" });
      await assert.rejects(lstat(fixture.staging), { code: "ENOENT" });
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("bootstrap lets a slow interrupted release finish authoritative recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloud-release-bootstrap-"));
  try {
    const commands = await createCommands(root);
    const nodePidPath = join(root, "slow-recovery.pid");
    const killMarkerPath = join(root, "slow-recovery.kill");
    const fixture = await prepareBootstrap(root, commands, "slow-recovery", {
      environment: { FAKE_NODE_PID_PATH: nodePidPath },
      killMarkerPath,
      nodeSource:
        "#!/bin/sh\n" +
        'printf \'%s\\n\' "$$" >"$FAKE_NODE_PID_PATH"\n' +
        "finish() {\n" +
        "  trap - HUP INT TERM\n" +
        "  /bin/sleep 5.2\n" +
        "  printf 'CLOUD_RELEASE_RECOVERY_REQUIRED\\n' >&2\n" +
        "  exit 1\n" +
        "}\n" +
        "trap finish HUP INT TERM\n" +
        "while :; do /bin/sleep 0.1; done\n",
    });
    const result = await runSignalledBootstrap(fixture, "SIGTERM", 10_000);
    assert.equal(result.signal, null);
    assertSafeFailure(result, "CLOUD_RELEASE_RECOVERY_REQUIRED");
    const nodePid = Number.parseInt(await readFile(nodePidPath, "utf8"), 10);
    assert.throws(() => process.kill(nodePid, 0), { code: "ESRCH" });
    await assert.rejects(lstat(killMarkerPath), { code: "ENOENT" });
    await assert.rejects(lstat(fixture.staging), { code: "ENOENT" });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("bootstrap force-kills only a still-identical release after grace exhaustion", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloud-release-bootstrap-"));
  try {
    const commands = await createCommands(root);
    const nodePidPath = join(root, "grace-exhausted.pid");
    const killMarkerPath = join(root, "grace-exhausted.kill");
    const fixture = await prepareBootstrap(root, commands, "grace-exhausted", {
      environment: { FAKE_NODE_PID_PATH: nodePidPath },
      graceSeconds: 1,
      killMarkerPath,
      nodeSource:
        "#!/bin/sh\n" +
        'printf \'%s\\n\' "$$" >"$FAKE_NODE_PID_PATH"\n' +
        "trap '' HUP INT TERM\n" +
        "while :; do /bin/sleep 0.1; done\n",
    });
    const result = await runSignalledBootstrap(fixture, "SIGTERM", 5_000);
    assert.equal(result.signal, null);
    assertSafeFailure(result, "CLOUD_RELEASE_BOOTSTRAP_REMOTE_ENTRY_FAILED");
    assert.equal(await readFile(killMarkerPath, "utf8"), "kill\n");
    const nodePid = Number.parseInt(await readFile(nodePidPath, "utf8"), 10);
    assert.throws(() => process.kill(nodePid, 0), { code: "ESRCH" });
    await assert.rejects(lstat(fixture.staging), { code: "ENOENT" });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("bootstrap detects an SSH-session parent loss and waits for slow recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloud-release-bootstrap-"));
  try {
    const commands = await createCommands(root);
    const nodePidPath = join(root, "parent-loss.pid");
    const recoveryPath = join(root, "parent-loss.recovered");
    const killMarkerPath = join(root, "parent-loss.kill");
    const fixture = await prepareBootstrap(root, commands, "parent-loss", {
      environment: { FAKE_NODE_PID_PATH: nodePidPath, FAKE_RECOVERY_PATH: recoveryPath },
      killMarkerPath,
      nodeSource:
        "#!/bin/sh\n" +
        'printf \'%s\\n\' "$$" >"$FAKE_NODE_PID_PATH"\n' +
        "finish() {\n" +
        "  trap - HUP INT TERM\n" +
        "  /bin/sleep 3.2\n" +
        "  printf 'recovered\\n' >\"$FAKE_RECOVERY_PATH\"\n" +
        "  printf 'CLOUD_RELEASE_RECOVERY_REQUIRED\\n' >&2\n" +
        "  exit 1\n" +
        "}\n" +
        "trap finish HUP INT TERM\n" +
        "while :; do /bin/sleep 0.1; done\n",
    });
    const result = await runParentDisconnectedBootstrap(fixture, root);
    assert.equal(result.signal, null);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "CLOUD_RELEASE_RECOVERY_REQUIRED\n");
    assert.equal(await readFile(recoveryPath, "utf8"), "recovered\n");
    await assert.rejects(lstat(killMarkerPath), { code: "ENOENT" });
    const nodePid = Number.parseInt(await readFile(nodePidPath, "utf8"), 10);
    assert.throws(() => process.kill(nodePid, 0), { code: "ESRCH" });
    await assert.rejects(lstat(fixture.staging), { code: "ENOENT" });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("bootstrap suppresses capture helper and final output diagnostics", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloud-release-bootstrap-"));
  try {
    const commands = await createCommands(root);
    await writeExecutable(
      join(commands, "head"),
      "#!/bin/sh\n" +
        "while IFS= read -r line; do :; done\n" +
        "printf 'private capture path with token %s\\n' \"$TOKEN\" >&2\n" +
        "exit 1\n",
    );
    const helperFailure = await runBootstrap(root, commands, "helper-failure", {
      nodeSource: "#!/bin/sh\nprintf 'CLOUD_RELEASE_INSTALL_FAILED\\n' >&2\nexit 1\n",
    });
    assertSafeFailure(helperFailure.result, "CLOUD_RELEASE_BOOTSTRAP_REMOTE_ENTRY_FAILED");
    assert.doesNotMatch(helperFailure.result.stderr, /private capture|token/u);

    await rm(join(commands, "head"));
    await writeExecutable(
      join(commands, "cat"),
      "#!/bin/sh\nprintf 'private final output path %s\\n' \"$TOKEN\" >&2\nexit 1\n",
    );
    const outputFailure = await runBootstrap(root, commands, "output-failure", {
      nodeSource: "#!/bin/sh\nprintf 'CLOUD_RELEASE_AWAITING_EXTERNAL_VERIFICATION\\n'\n",
    });
    assertSafeFailure(outputFailure.result, "CLOUD_RELEASE_BOOTSTRAP_REMOTE_ENTRY_FAILED");
    assert.doesNotMatch(outputFailure.result.stderr, /private final|token/u);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
