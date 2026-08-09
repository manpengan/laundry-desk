import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, createPrivateKey, sign } from "node:crypto";
import {
  cp,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { registerKeyCleanup, setup } from "./no-repo-helpers.mjs";
import { runLanMaintenanceAcceptance } from "./no-repo-lan-maintenance-acceptance.mjs";

const executeFile = promisify(execFile);
const kitRoot = dirname(fileURLToPath(import.meta.url));
const builtApp = join(kitRoot, "dist/Laundry Desk Runtime Test.app");
const signingKey = join(kitRoot, "dist/test-signing-private.pem");
const temporary = await mkdtemp(join(tmpdir(), "laundry-runtime-native-lan-"));
const emptyCwd = join(temporary, "empty-cwd");
const fakeHome = join(temporary, "home");
const copiedApp = join(temporary, "Laundry Desk Runtime Test.app");
const configRoot = join(temporary, "config");
const runnerLog = join(temporary, "runner.jsonl");
registerKeyCleanup(process.argv.slice(2), signingKey);

try {
  const bindIpv4 = "192.168.50.12";
  const port = 18443;
  const canary = "runtime-lan-support-canary-7d421";

  const checksum = (value) => createHash("sha256").update(value).digest("hex");
  const repeated = (value) => value.repeat(64);
  const canonical = (value) => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  };

  async function generateCertificate(root) {
    const config = join(root, "openssl.cnf");
    const certificate = join(root, "certificate.pem");
    const privateKey = join(root, "private-key.pem");
    await writeFile(
      config,
      `[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=leaf\n[dn]\nCN=${bindIpv4}\n[leaf]\nsubjectAltName=IP:${bindIpv4}\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`,
      { mode: 0o600 },
    );
    await executeFile(
      "/usr/bin/openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "2",
        "-keyout",
        privateKey,
        "-out",
        certificate,
        "-config",
        config,
      ],
      { maxBuffer: 64 * 1024 },
    );
    await chmod(privateKey, 0o600);
    return Object.freeze({
      certificatePem: await readFile(certificate, "utf8"),
      privateKeyPem: await readFile(privateKey, "utf8"),
    });
  }

  const runAt = (executable, runtimeRoot, runtimeLog, args, input = "", extraEnvironment = {}) =>
    new Promise((resolveRun, rejectRun) => {
      const child = spawn(
        executable,
        ["--test-config-root", runtimeRoot, "--test-runner-log", runtimeLog, ...args],
        {
          cwd: emptyCwd,
          env: {
            PATH: "",
            HOME: fakeHome,
            LAUNDRY_RUNTIME_TEST_LAN_INTERFACES: JSON.stringify([
              {
                name: "en7",
                ipv4: bindIpv4,
                up: true,
                loopback: false,
                point_to_point: false,
              },
            ]),
            LAUNDRY_RUNTIME_SUPPORT_CANARY: canary,
            ...extraEnvironment,
          },
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      const stdout = [];
      const stderr = [];
      let bytes = 0;
      const collect = (target) => (chunk) => {
        bytes += chunk.length;
        if (bytes > 32 * 1024) child.kill("SIGKILL");
        else target.push(chunk);
      };
      child.stdout.on("data", collect(stdout));
      child.stderr.on("data", collect(stderr));
      child.once("error", rejectRun);
      child.once("close", (code) =>
        resolveRun({
          code,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        }),
      );
      child.stdin.end(input);
    });
  const runRuntime = (executable, args, input = "", extraEnvironment = {}) =>
    runAt(executable, configRoot, runnerLog, args, input, extraEnvironment);

  function assertExactKeys(value, expected) {
    assert.deepEqual(Object.keys(value).sort(), [...expected].sort());
  }

  await Promise.all([
    mkdir(emptyCwd),
    mkdir(fakeHome),
    cp(builtApp, copiedApp, { recursive: true }),
  ]);
  const executable = join(copiedApp, "Contents/MacOS/Laundry Desk Runtime");
  const resources = join(copiedApp, "Contents/Resources");
  const [compose, lanCompose, credentials, key] = await Promise.all([
    readFile(join(resources, "docker-compose.runtime.yml")),
    readFile(join(resources, "docker-compose.runtime-lan.yml")),
    generateCertificate(temporary),
    readFile(signingKey).then(createPrivateKey),
  ]);
  const basePayload = Object.freeze({
    schema_version: 2,
    product: "laundry-desk-runtime",
    release: "0.1.0",
    contracts_major: 2,
    contracts_sha256: repeated("a"),
    server_version: "0.1.0",
    web_bundle_sha256: repeated("b"),
    minimum_app_version: "0.1.0",
    database_schema_sha256: repeated("c"),
    migrations_sha256: repeated("d"),
    migration_head: "0033_offline_grant_replay.sql",
    maximum_compatible_schema: "0033_offline_grant_replay.sql",
    rollback_target: null,
    compose_sha256: checksum(compose),
    lan_compose_sha256: checksum(lanCompose),
    owner_spa_sha256: repeated("3"),
    server_image: Object.freeze({
      index: `registry.example/laundry/server@sha256:${repeated("e")}`,
      linux_arm64: `sha256:${repeated("f")}`,
      linux_amd64: `sha256:${repeated("1")}`,
    }),
    postgres_major: 16,
    postgres_image: `docker.io/library/postgres@sha256:${repeated("2")}`,
  });
  const writeManifest = async (name, payload) => {
    const signature = sign(null, Buffer.from(JSON.stringify(canonical(payload))), key).toString(
      "base64url",
    );
    const path = join(temporary, name);
    await writeFile(path, JSON.stringify({ payload, signature }), { mode: 0o600 });
    return path;
  };
  const manifest = await writeManifest("runtime-manifest-v2.json", basePayload);
  const upgradedPayload = Object.freeze({
    ...basePayload,
    release: "0.2.0",
    server_version: "0.2.0",
    web_bundle_sha256: repeated("4"),
    rollback_target: Object.freeze({
      release: basePayload.release,
      server_image_index: basePayload.server_image.index,
      maximum_compatible_schema: basePayload.maximum_compatible_schema,
    }),
    server_image: Object.freeze({
      index: "registry.example/laundry/server@sha256:" + repeated("5"),
      linux_arm64: "sha256:" + repeated("6"),
      linux_amd64: "sha256:" + repeated("7"),
    }),
  });
  const upgradeManifest = await writeManifest("runtime-manifest-v2-upgrade.json", upgradedPayload);
  const mismatchedLanPayload = Object.freeze({
    ...upgradedPayload,
    release: "0.3.0",
    server_version: "0.3.0",
    web_bundle_sha256: repeated("8"),
    owner_spa_sha256: repeated("9"),
    server_image: Object.freeze({
      index: "registry.example/laundry/server@sha256:" + repeated("a"),
      linux_arm64: "sha256:" + repeated("b"),
      linux_amd64: "sha256:" + repeated("c"),
    }),
  });
  const mismatchedLanManifest = await writeManifest(
    "runtime-manifest-v2-mismatched-lan.json",
    mismatchedLanPayload,
  );

  let result = await runRuntime(executable, ["install", "--manifest", manifest], setup);
  assert.equal(result.code, 0, result.stderr);
  result = await runRuntime(executable, ["lan", "status"]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { configured: false, enabled: false });

  const configureInput = JSON.stringify({
    bind_ipv4: bindIpv4,
    port,
    certificate_pem: credentials.certificatePem,
    private_key_pem: credentials.privateKeyPem,
  });
  result = await runRuntime(executable, ["lan", "configure"], configureInput);
  assert.equal(result.code, 0, result.stderr);
  const configured = JSON.parse(result.stdout);
  assertExactKeys(configured, [
    "status",
    "generation",
    "bind_ipv4",
    "port",
    "certificate_fingerprint_sha256",
    "valid_not_after",
  ]);
  assert.equal(configured.status, "configured");
  assert.equal(configured.bind_ipv4, bindIpv4);
  assert.equal(configured.port, port);
  assert.match(configured.generation, /^[A-Za-z0-9_-]{22,128}$/u);
  assert.match(configured.certificate_fingerprint_sha256, /^[0-9a-f]{64}$/u);

  const generationRoot = join(configRoot, "lan/generations", configured.generation);
  assert.equal((await stat(join(configRoot, "lan"))).mode & 0o777, 0o700);
  assert.equal((await stat(generationRoot)).mode & 0o777, 0o700);
  assert.deepEqual((await readdir(generationRoot)).sort(), [
    "certificate.pem",
    "compose.env",
    "config.json",
    "private-key.pem",
    "profile.json",
  ]);
  for (const name of await readdir(generationRoot)) {
    const metadata = await stat(join(generationRoot, name));
    assert.equal(metadata.mode & 0o777, 0o600);
    assert.equal(metadata.nlink, 1);
  }
  const stateText = await readFile(join(configRoot, "lan/state.json"), "utf8");
  assert.doesNotMatch(stateText, /BEGIN (?:CERTIFICATE|PRIVATE KEY)/u);

  await writeFile(runnerLog + ".fail-once", `https://${bindIpv4}:${port}/health\n`, {
    mode: 0o600,
  });
  result = await runRuntime(executable, ["lan", "enable"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /RUNTIME_LAN_START_FAILED/u);
  assert.equal(JSON.parse((await runRuntime(executable, ["lan", "status"])).stdout).enabled, false);

  const readinessLogOffset = (await readFile(runnerLog, "utf8")).trim().split("\n").length;
  result = await runRuntime(executable, ["lan", "enable"], "", {
    LAUNDRY_RUNTIME_TEST_FAIL_ATOMIC_WRITE: "lan/state.json",
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /RUNTIME_LAN_STATE_COMMIT_FAILED/u);
  assert.deepEqual(JSON.parse((await runRuntime(executable, ["lan", "status"])).stdout), {
    configured: false,
    enabled: false,
    fault_code: "RUNTIME_LAN_STATE_COMMIT_FAILED",
  });
  await assert.rejects(() => stat(runnerLog + ".lan-running"), { code: "ENOENT" });
  const uncertainStartOffset = (await readFile(runnerLog, "utf8")).trim().split("\n").length;
  result = await runRuntime(executable, ["start"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /RUNTIME_LAN_STATE_COMMIT_FAILED/u);
  const uncertainStartLog = (await readFile(runnerLog, "utf8"))
    .trim()
    .split("\n")
    .slice(uncertainStartOffset)
    .map((line) => JSON.parse(line));
  assert.equal(
    uncertainStartLog.some(
      (entry) => entry.arguments.includes("up") && entry.arguments.includes("lan-gateway"),
    ),
    false,
  );
  result = await runRuntime(executable, ["lan", "configure"], configureInput);
  assert.equal(result.code, 0, result.stderr);
  result = await runRuntime(executable, ["lan", "enable"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, "enabled");
  const readinessLog = (await readFile(runnerLog, "utf8"))
    .trim()
    .split("\n")
    .slice(readinessLogOffset)
    .map((line) => JSON.parse(line));
  for (const path of ["/health", "/owner"]) {
    assert.ok(
      readinessLog.some(
        (entry) =>
          entry.executable === "/usr/bin/curl" &&
          entry.arguments.includes(`https://${bindIpv4}:${port}${path}`) &&
          entry.arguments.includes("--max-time") &&
          entry.arguments.includes("3") &&
          entry.arguments.includes("--cacert") &&
          entry.arguments.includes("--output") &&
          entry.arguments.includes("/dev/null"),
      ),
    );
  }

  const reconfigureLogOffset = (await readFile(runnerLog, "utf8")).trim().split("\n").length;
  result = await runRuntime(executable, ["lan", "configure"], configureInput);
  assert.equal(result.code, 0, result.stderr);
  const reconfigured = JSON.parse(result.stdout);
  assert.notEqual(reconfigured.generation, configured.generation);
  const reconfigureLog = (await readFile(runnerLog, "utf8"))
    .trim()
    .split("\n")
    .slice(reconfigureLogOffset)
    .map((line) => JSON.parse(line));
  const gatewayStopIndex = reconfigureLog.findIndex(
    (entry) =>
      entry.arguments[0] === "ps" &&
      entry.arguments.includes("label=com.docker.compose.service=lan-gateway"),
  );
  const serverReconcileIndex = reconfigureLog.findIndex(
    (entry) =>
      entry.arguments.includes("--force-recreate") &&
      entry.arguments.includes("--no-deps") &&
      entry.arguments.includes("server") &&
      entry.arguments.filter((argument) => argument === "--file").length === 1,
  );
  const loopbackReadyIndex = reconfigureLog.findIndex(
    (entry) =>
      entry.executable === "/usr/bin/curl" &&
      entry.arguments.includes("http://127.0.0.1:8787/health"),
  );
  assert.ok(
    gatewayStopIndex >= 0 &&
      serverReconcileIndex > gatewayStopIndex &&
      loopbackReadyIndex > serverReconcileIndex,
  );
  result = await runRuntime(executable, ["lan", "enable"]);
  assert.equal(result.code, 0, result.stderr);

  result = await runRuntime(executable, ["restart"]);
  assert.equal(result.code, 0, result.stderr);
  result = await runRuntime(executable, ["lan", "status"]);
  assert.equal(JSON.parse(result.stdout).enabled, true);

  result = await runRuntime(executable, ["launchd", "install"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(
    JSON.parse(result.stdout).path,
    /Library\/LaunchAgents\/com\.laundry-desk\.runtime\.plist$/u,
  );
  result = await runRuntime(executable, ["start"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse((await runRuntime(executable, ["lan", "status"])).stdout).enabled, true);
  result = await runRuntime(executable, ["launchd", "uninstall"]);
  assert.equal(result.code, 0, result.stderr);

  result = await runRuntime(executable, ["lan", "configure"], configureInput, {
    LAUNDRY_RUNTIME_TEST_FAIL_ATOMIC_WRITE: "lan/state.json",
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /RUNTIME_LAN_STATE_COMMIT_FAILED/u);
  assert.equal(JSON.parse((await runRuntime(executable, ["lan", "status"])).stdout).enabled, false);
  result = await runRuntime(executable, ["lan", "configure"], configureInput);
  assert.equal(result.code, 0, result.stderr);
  result = await runRuntime(executable, ["lan", "enable"]);
  assert.equal(result.code, 0, result.stderr);

  const onboard = JSON.parse((await runRuntime(executable, ["lan", "onboard"])).stdout);
  assertExactKeys(onboard, [
    "owner_url",
    "certificate_fingerprint_sha256",
    "valid_not_after",
    "ip_sans",
    "qr",
  ]);
  assert.equal(onboard.owner_url, `https://${bindIpv4}:${port}/owner`);
  assert.deepEqual(onboard.ip_sans, [bindIpv4]);
  assert.doesNotMatch(JSON.stringify(onboard), /password|private.?key|cookie|token|pin/iu);

  const diagnose = JSON.parse((await runRuntime(executable, ["lan", "diagnose"])).stdout);
  assertExactKeys(diagnose, ["ok", "checks", "certificate_fingerprint_sha256", "valid_not_after"]);
  assert.equal(diagnose.ok, true);
  assert.ok(diagnose.checks.length >= 7);
  assert.equal(new Set(diagnose.checks.map((check) => check.code)).size, diagnose.checks.length);
  assert.ok(diagnose.checks.every((check) => typeof check.code === "string" && check.ok === true));

  result = await runRuntime(executable, ["support", "create"]);
  assert.equal(result.code, 0, result.stderr);
  const supportResult = JSON.parse(result.stdout);
  assert.deepEqual(supportResult, {
    status: "created",
    path: join(configRoot, "support/runtime-support.json"),
    bytes: supportResult.bytes,
  });
  assert.ok(Number.isSafeInteger(supportResult.bytes) && supportResult.bytes > 0);
  const supportMetadata = await stat(supportResult.path);
  assert.equal(supportMetadata.mode & 0o777, 0o600);
  assert.equal(supportMetadata.nlink, 1);
  assert.ok(supportMetadata.size <= 256 * 1024);
  const supportText = await readFile(supportResult.path, "utf8");
  const support = JSON.parse(supportText);
  assertExactKeys(support, [
    "schema_version",
    "generated_at",
    "runtime",
    "server",
    "lan",
    "backup",
    "printing",
  ]);
  assert.doesNotMatch(
    supportText,
    /BEGIN (?:CERTIFICATE|PRIVATE KEY)|password|cookie|token|pin|customer|order|staff|\.pem|\/Users\//iu,
  );
  assert.doesNotMatch(supportText, new RegExp(canary, "u"));

  await writeFile(runnerLog + ".fail-once", "pg_dump\n", { mode: 0o600 });
  result = await runRuntime(executable, ["upgrade", "--manifest", upgradeManifest]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /RUNTIME_COMMAND_FAILED/u);
  assert.equal(JSON.parse((await runRuntime(executable, ["lan", "status"])).stdout).enabled, true);
  await stat(runnerLog + ".lan-running");

  let releaseLogOffset = (await readFile(runnerLog, "utf8")).trim().split("\n").length;
  result = await runRuntime(executable, ["upgrade", "--manifest", upgradeManifest]);
  assert.equal(result.code, 0, result.stderr);
  let releaseResult = JSON.parse(result.stdout);
  assert.equal(releaseResult.status, "ready");
  assert.equal(releaseResult.release, "0.2.0");
  assert.equal(releaseResult.lan_status, "enabled");
  assert.equal("lan_fault_code" in releaseResult, false);
  let releaseLog = (await readFile(runnerLog, "utf8"))
    .trim()
    .split("\n")
    .slice(releaseLogOffset)
    .map((line) => JSON.parse(line));
  let verifyIndex = releaseLog.findLastIndex((entry) => entry.arguments.includes("verify"));
  let gatewayIndex = releaseLog.findLastIndex(
    (entry) => entry.arguments.includes("up") && entry.arguments.includes("lan-gateway"),
  );
  assert.ok(verifyIndex >= 0 && gatewayIndex > verifyIndex);
  assert.equal(JSON.parse(await readFile(join(configRoot, "state.json"), "utf8")).release, "0.2.0");
  assert.equal(JSON.parse((await runRuntime(executable, ["lan", "status"])).stdout).enabled, true);

  await writeFile(runnerLog + ".fail-once", "pg_dump\n", { mode: 0o600 });
  result = await runRuntime(
    executable,
    ["rollback"],
    JSON.stringify({ confirmation: "ROLLBACK-0.1.0" }),
  );
  assert.equal(result.code, 1);
  assert.match(result.stderr, /RUNTIME_COMMAND_FAILED/u);
  assert.equal(JSON.parse((await runRuntime(executable, ["lan", "status"])).stdout).enabled, true);
  await stat(runnerLog + ".lan-running");

  releaseLogOffset = (await readFile(runnerLog, "utf8")).trim().split("\n").length;
  result = await runRuntime(
    executable,
    ["rollback"],
    JSON.stringify({ confirmation: "ROLLBACK-0.1.0" }),
  );
  assert.equal(result.code, 0, result.stderr);
  releaseResult = JSON.parse(result.stdout);
  assert.equal(releaseResult.status, "ready");
  assert.equal(releaseResult.release, "0.1.0");
  assert.equal(releaseResult.lan_status, "enabled");
  assert.equal("lan_fault_code" in releaseResult, false);
  releaseLog = (await readFile(runnerLog, "utf8"))
    .trim()
    .split("\n")
    .slice(releaseLogOffset)
    .map((line) => JSON.parse(line));
  verifyIndex = releaseLog.findLastIndex((entry) => entry.arguments.includes("verify"));
  gatewayIndex = releaseLog.findLastIndex(
    (entry) => entry.arguments.includes("up") && entry.arguments.includes("lan-gateway"),
  );
  assert.ok(verifyIndex >= 0 && gatewayIndex > verifyIndex);
  assert.equal(JSON.parse(await readFile(join(configRoot, "state.json"), "utf8")).release, "0.1.0");

  result = await runRuntime(executable, ["upgrade", "--manifest", upgradeManifest], "", {
    LAUNDRY_RUNTIME_TEST_CRASH_AFTER_ATOMIC_WRITE: "release-transition.json:2",
  });
  assert.equal(result.code, 86, result.stderr);
  const transitionRecoveryOffset = (await readFile(runnerLog, "utf8")).trim().split("\n").length;
  result = await runRuntime(executable, ["upgrade", "--manifest", upgradeManifest]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /RUNTIME_RELEASE_TRANSITION_RECOVERED/u);
  assert.equal(JSON.parse((await runRuntime(executable, ["lan", "status"])).stdout).enabled, true);
  const transitionRecoveryLog = (await readFile(runnerLog, "utf8"))
    .trim()
    .split("\n")
    .slice(transitionRecoveryOffset)
    .map((line) => JSON.parse(line));
  assert.ok(
    transitionRecoveryLog.some(
      (entry) => entry.arguments.includes("up") && entry.arguments.includes("lan-gateway"),
    ),
  );

  const uncertainLogOffset = (await readFile(runnerLog, "utf8")).trim().split("\n").length;
  result = await runRuntime(executable, ["upgrade", "--manifest", mismatchedLanManifest], "", {
    LAUNDRY_RUNTIME_TEST_FAIL_ATOMIC_WRITE: "lan/state.json",
  });
  assert.equal(result.code, 0, result.stderr);
  releaseResult = JSON.parse(result.stdout);
  assert.equal(releaseResult.status, "ready");
  assert.equal(releaseResult.release, "0.3.0");
  assert.equal(releaseResult.lan_status, "state_commit_uncertain");
  assert.equal(releaseResult.lan_fault_code, "RUNTIME_LAN_STATE_COMMIT_FAILED");
  assert.equal(JSON.parse(await readFile(join(configRoot, "state.json"), "utf8")).release, "0.3.0");
  assert.deepEqual(JSON.parse((await runRuntime(executable, ["lan", "status"])).stdout), {
    configured: false,
    enabled: false,
    fault_code: "RUNTIME_LAN_STATE_COMMIT_FAILED",
  });
  await assert.rejects(() => stat(runnerLog + ".lan-running"), { code: "ENOENT" });
  await assert.rejects(() => stat(join(configRoot, "release-transition.json")), { code: "ENOENT" });

  result = await runRuntime(executable, ["start"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /RUNTIME_LAN_STATE_COMMIT_FAILED/u);
  const uncertainLog = (await readFile(runnerLog, "utf8"))
    .trim()
    .split("\n")
    .slice(uncertainLogOffset)
    .map((line) => JSON.parse(line));
  assert.equal(
    uncertainLog.some(
      (entry) => entry.arguments.includes("up") && entry.arguments.includes("lan-gateway"),
    ),
    false,
  );

  result = await runRuntime(executable, ["lan", "configure"], configureInput);
  assert.equal(result.code, 0, result.stderr);
  result = await runRuntime(executable, ["lan", "enable"]);
  assert.equal(result.code, 0, result.stderr);
  result = await runRuntime(
    executable,
    ["rollback"],
    JSON.stringify({ confirmation: "ROLLBACK-0.1.0" }),
  );
  assert.equal(result.code, 0, result.stderr);
  releaseResult = JSON.parse(result.stdout);
  assert.equal(releaseResult.status, "ready");
  assert.equal(releaseResult.release, "0.1.0");
  assert.equal(releaseResult.lan_status, "disabled_after_restore_failure");
  assert.equal(releaseResult.lan_fault_code, "RUNTIME_LAN_PROFILE_INVALID");
  assert.equal(JSON.parse(await readFile(join(configRoot, "state.json"), "utf8")).release, "0.1.0");
  assert.equal(JSON.parse((await runRuntime(executable, ["lan", "status"])).stdout).enabled, false);
  await assert.rejects(() => stat(join(configRoot, "release-transition.json")), { code: "ENOENT" });

  const beforeDisableLogCount = (await readFile(runnerLog, "utf8")).trim().split("\n").length;
  result = await runRuntime(executable, ["lan", "disable"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, "disabled");
  const afterDisable = (await readFile(runnerLog, "utf8"))
    .trim()
    .split("\n")
    .slice(beforeDisableLogCount)
    .map((line) => JSON.parse(line));
  assert.ok(
    afterDisable.some(
      (entry) =>
        entry.arguments.includes("label=com.docker.compose.project=laundry-desk-runtime") &&
        entry.arguments.includes("label=com.docker.compose.service=lan-gateway"),
    ),
  );
  assert.equal(
    afterDisable.some((entry) => entry.arguments.includes("postgres")),
    false,
  );
  assert.equal(
    afterDisable.some((entry) => entry.arguments.includes("server")),
    false,
  );
  const disabled = JSON.parse((await runRuntime(executable, ["lan", "status"])).stdout);
  assert.equal(disabled.configured, true);
  assert.equal(disabled.enabled, false);

  const occupiedLogOffset = (await readFile(runnerLog, "utf8")).trim().split("\n").length;
  result = await runRuntime(executable, ["lan", "configure"], configureInput, {
    LAUNDRY_RUNTIME_TEST_LAN_PORT_OCCUPIED: "1",
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /RUNTIME_LAN_PORT_UNAVAILABLE/u);
  const occupiedLog = (await readFile(runnerLog, "utf8"))
    .trim()
    .split("\n")
    .slice(occupiedLogOffset)
    .map((line) => JSON.parse(line));
  assert.ok(
    occupiedLog.some(
      (entry) =>
        entry.arguments.includes("--force-recreate") &&
        entry.arguments.includes("--no-deps") &&
        entry.arguments.includes("server") &&
        entry.arguments.filter((argument) => argument === "--file").length === 1,
    ),
  );
  assert.equal(JSON.parse((await runRuntime(executable, ["lan", "status"])).stdout).enabled, false);

  result = await runRuntime(
    executable,
    ["lan", "configure"],
    JSON.stringify({ ...JSON.parse(configureInput), unexpected: true }),
  );
  assert.equal(result.code, 1);
  assert.match(result.stderr, /RUNTIME_LAN_STDIN_INVALID/u);
  result = await runRuntime(executable, ["lan", "configure", "--private-key", canary]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /RUNTIME_ARGS_INVALID/u);
  result = await runRuntime(
    executable,
    ["lan", "configure"],
    JSON.stringify({
      ...JSON.parse(configureInput),
      private_key_pem: "-----BEGIN PRIVATE KEY-----\nZm9v\n-----END PRIVATE KEY-----\n",
    }),
  );
  assert.equal(result.code, 1);
  assert.match(result.stderr, /RUNTIME_LAN_PRIVATE_KEY_INVALID/u);
  result = await runRuntime(executable, ["lan", "status"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).configured, true);

  const assertEmergencyStop = async (name, tamper) => {
    const isolatedRoot = join(temporary, "config-emergency-" + name);
    const isolatedLog = join(temporary, "runner-emergency-" + name + ".jsonl");
    let isolated = await runAt(
      executable,
      isolatedRoot,
      isolatedLog,
      ["install", "--manifest", manifest],
      setup,
    );
    assert.equal(isolated.code, 0, isolated.stderr);
    isolated = await runAt(
      executable,
      isolatedRoot,
      isolatedLog,
      ["lan", "configure"],
      configureInput,
    );
    assert.equal(isolated.code, 0, isolated.stderr);
    const isolatedGeneration = JSON.parse(isolated.stdout).generation;
    isolated = await runAt(executable, isolatedRoot, isolatedLog, ["lan", "enable"]);
    assert.equal(isolated.code, 0, isolated.stderr);
    const identifier = name === "state" ? repeated("d") : repeated("e");
    await writeFile(isolatedLog + ".ps-output", identifier + "\n", { mode: 0o600 });
    await tamper(isolatedRoot, isolatedGeneration);
    const offset = (await readFile(isolatedLog, "utf8")).trim().split("\n").length;
    isolated = await runAt(executable, isolatedRoot, isolatedLog, ["lan", "disable"]);
    assert.equal(isolated.code, 1);
    const commands = (await readFile(isolatedLog, "utf8"))
      .trim()
      .split("\n")
      .slice(offset)
      .map((line) => JSON.parse(line));
    assert.ok(
      commands.some((entry) =>
        [
          "ps",
          "--all",
          "--quiet",
          "--filter",
          "label=com.docker.compose.project=laundry-desk-runtime",
          "--filter",
          "label=com.docker.compose.service=lan-gateway",
        ].every((argument, index) => entry.arguments[index] === argument),
      ),
    );
    assert.ok(
      commands.some(
        (entry) =>
          entry.arguments.length === 3 &&
          entry.arguments[0] === "rm" &&
          entry.arguments[1] === "-f" &&
          entry.arguments[2] === identifier,
      ),
    );
    assert.equal(
      commands.some(
        (entry) => entry.arguments.includes("volume") || entry.arguments.includes("server"),
      ),
      false,
    );
  };
  await assertEmergencyStop("state", async (root) => {
    await writeFile(join(root, "lan/state.json"), "{}");
  });
  await assertEmergencyStop("profile", async (root, generation) => {
    await writeFile(join(root, "lan/generations", generation, "profile.json"), "{}");
  });

  await runLanMaintenanceAcceptance({
    runAt,
    executable,
    manifest,
    upgradeManifest,
    configureInput,
    temporary,
  });

  const v1Payload = Object.fromEntries(
    Object.entries(basePayload).filter(
      ([name]) => !["lan_compose_sha256", "owner_spa_sha256"].includes(name),
    ),
  );
  v1Payload.schema_version = 1;
  const v1Manifest = await writeManifest("runtime-manifest-v1.json", v1Payload);
  const v1Root = join(temporary, "config-v1");
  const v1Log = join(temporary, "runner-v1.jsonl");
  const runV1 = (args, input = "") =>
    new Promise((resolveRun, rejectRun) => {
      const child = spawn(
        executable,
        ["--test-config-root", v1Root, "--test-runner-log", v1Log, ...args],
        {
          cwd: emptyCwd,
          env: {
            PATH: "",
            HOME: fakeHome,
            LAUNDRY_RUNTIME_TEST_LAN_INTERFACES: JSON.stringify([
              { name: "en7", ipv4: bindIpv4, up: true, loopback: false, point_to_point: false },
            ]),
          },
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      const output = [];
      const errors = [];
      child.stdout.on("data", (chunk) => output.push(chunk));
      child.stderr.on("data", (chunk) => errors.push(chunk));
      child.once("error", rejectRun);
      child.once("close", (code) =>
        resolveRun({
          code,
          stdout: Buffer.concat(output).toString("utf8"),
          stderr: Buffer.concat(errors).toString("utf8"),
        }),
      );
      child.stdin.end(input);
    });
  result = await runV1(["install", "--manifest", v1Manifest], setup);
  assert.equal(result.code, 0, result.stderr);
  result = await runV1(["lan", "configure"], configureInput);
  assert.equal(result.code, 0, result.stderr);
  result = await runV1(["lan", "enable"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /RUNTIME_LAN_MANIFEST_V2_REQUIRED/u);

  const runnerText = await readFile(runnerLog, "utf8");
  assert.doesNotMatch(
    runnerText,
    /native-acceptance-password|86420987|independent-approver-password|97531864|BEGIN PRIVATE KEY/u,
  );
  assert.doesNotMatch(runnerText, new RegExp(canary, "u"));
  process.stdout.write("RUNTIME_NATIVE_NO_REPO_LAN_ACCEPTANCE_OK scenarios=34\n");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
