import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  POSTGRES_PORT,
  SERVER_PORT,
  SOFTWARE_ONLY_MARKER,
  RuntimeCounterAcceptanceError,
  assertExactLoopbackBinding,
  assertUnavailableHealth,
  assertOwnedComposeLabels,
  assertOwnedImage,
  assertOwnedTemporaryRoot,
  assertOwnedVolumeLabels,
  assertSecretsNotExposed,
  createAcceptanceIdentity,
  createRuntimeArguments,
  defaultDockerSocketCandidates,
  localDockerHostArguments,
  parseReadyHealth,
  resolveLocalDockerEndpoint,
  selectHostEnvironment,
} from "./runtime-counter-loopback-core.mjs";

const identity = createAcceptanceIdentity("abc12345def0");

test("creates isolated SystemRuntimeRunner resource names", () => {
  assert.deepEqual(identity, {
    runtimeId: "abc12345def0",
    project: "laundry-desk-runtime-test-abc12345def0",
    imageTag: "laundry-runtime-data-test-abc12345def0:local",
    acceptanceLabel: "runtime-counter-abc12345def0",
    volumes: [
      "laundry-desk-runtime-test-abc12345def0_pgdata-v2",
      "laundry-desk-runtime-test-abc12345def0_photos",
    ],
  });
  assert.throws(
    () => createAcceptanceIdentity("TOO-SHORT"),
    (error) =>
      error instanceof RuntimeCounterAcceptanceError && error.code === "RUNTIME_COUNTER_ID_INVALID",
  );
});

test("uses the real system-runner test entry and keeps setup out of argv", () => {
  const args = createRuntimeArguments(
    identity,
    "/private/tmp/laundry-runtime-counter-fixture/runtime",
    identity.imageTag,
    ["install", "--manifest", "/private/tmp/manifest.json"],
  );
  assert.deepEqual(args.slice(0, 6), [
    "--test-system-config-root",
    "/private/tmp/laundry-runtime-counter-fixture/runtime",
    "--test-runtime-id",
    identity.runtimeId,
    "--test-local-server-image",
    identity.imageTag,
  ]);
  assert.equal(args.includes("--test-config-root"), false);
  assert.equal(
    args.some((argument) => argument.includes("acceptance-password")),
    false,
  );
});

test("host environment is allowlisted and rejects credential-shaped overrides", () => {
  const selected = selectHostEnvironment({
    HOME: "/tmp/home",
    PATH: "/untrusted",
    LANG: "zh_TW.UTF-8",
    LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD: "must-not-pass",
  });
  assert.deepEqual(Object.keys(selected).sort(), ["HOME", "LANG", "PATH"]);
  assert.notEqual(selected.PATH, "/untrusted");
  assert.throws(
    () => selectHostEnvironment({}, { ACCESS_TOKEN: "forbidden" }),
    /RUNTIME_COUNTER_SECRET_CHANNEL_INVALID/u,
  );
});

test("default Docker socket candidates use the OS account home, not HOME", () => {
  const originalHome = process.env.HOME;
  process.env.HOME = "/private/tmp/fake-runtime-counter-home";
  try {
    assert.deepEqual(defaultDockerSocketCandidates(), [
      join(userInfo().homedir, ".docker/run/docker.sock"),
      "/var/run/docker.sock",
    ]);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});

test("pins Docker to an actual local Unix socket and rejects remote or invalid endpoints", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "runtime-counter-docker-endpoint-test-"));
  const socket = join(root, "docker.sock");
  const linkedSocket = join(root, "linked.sock");
  const regularFile = join(root, "regular.sock");
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(socket, resolveListen);
  });
  await symlink(socket, linkedSocket);
  await writeFile(regularFile, "not a socket\n");
  t.after(async () => {
    await new Promise((resolveClose) => server.close(resolveClose));
    await rm(root, { force: true, recursive: true });
  });

  const endpoint = await resolveLocalDockerEndpoint([linkedSocket, regularFile, socket]);
  assert.equal(endpoint.path, socket);
  assert.deepEqual(localDockerHostArguments(endpoint), ["--host", `unix://${socket}`]);
  await assert.rejects(
    () => resolveLocalDockerEndpoint([linkedSocket, regularFile]),
    /RUNTIME_COUNTER_DOCKER_ENDPOINT_INVALID/u,
  );
  assert.throws(
    () => localDockerHostArguments({ host: "ssh://remote.example", path: "/tmp/docker.sock" }),
    /RUNTIME_COUNTER_DOCKER_ENDPOINT_INVALID/u,
  );
});

test("setup secrets may be stdin only and never appear in recorded exposure", () => {
  const setupInput = JSON.stringify({ adminPassword: "acceptance-password" });
  assert.doesNotThrow(() =>
    assertSecretsNotExposed(
      {
        file: "/tmp/runtime",
        args: ["install", "--manifest", "/tmp/manifest.json"],
        env: { PATH: "/usr/bin" },
        stdout: '{"status":"ready"}',
        stderr: "",
      },
      ["acceptance-password"],
    ),
  );
  assert.ok(setupInput.includes("acceptance-password"));
  assert.throws(
    () =>
      assertSecretsNotExposed({ args: ["--password=acceptance-password"] }, [
        "acceptance-password",
      ]),
    /RUNTIME_COUNTER_SECRET_EXPOSED/u,
  );
});

test("accepts only the exact ready health envelope", () => {
  assert.deepEqual(parseReadyHealth('{"ok":true,"data":{"status":"ready"}}'), {
    ok: true,
    data: { status: "ready" },
  });
  for (const value of [
    '{"ok":true,"data":{"status":"ready","extra":true}}',
    '{"ok":true,"data":{"status":"starting"}}',
    '{"ok":false,"data":{"status":"ready"}}',
    "not-json",
  ]) {
    assert.throws(() => parseReadyHealth(value), /RUNTIME_COUNTER_HEALTH_INVALID/u);
  }
});

test("accepts only the desktop unavailable failure while Runtime is stopped", () => {
  assert.doesNotThrow(() =>
    assertUnavailableHealth({
      ok: false,
      error: { code: "RESOURCE_UNAVAILABLE", message: "本地服务不可用" },
    }),
  );
  assert.throws(
    () => assertUnavailableHealth({ ok: false, error: { code: "NETWORK" } }),
    /RUNTIME_COUNTER_HEALTH_DOWN_INVALID/u,
  );
});

test("pins PostgreSQL and Server to their exact loopback ports", () => {
  assert.doesNotThrow(() =>
    assertExactLoopbackBinding(
      { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: String(POSTGRES_PORT) }] },
      5432,
      POSTGRES_PORT,
    ),
  );
  assert.doesNotThrow(() =>
    assertExactLoopbackBinding(
      { "8787/tcp": [{ HostIp: "127.0.0.1", HostPort: String(SERVER_PORT) }] },
      8787,
      SERVER_PORT,
    ),
  );
  assert.throws(
    () =>
      assertExactLoopbackBinding(
        { "8787/tcp": [{ HostIp: "0.0.0.0", HostPort: "8787" }] },
        8787,
        SERVER_PORT,
      ),
    /RUNTIME_COUNTER_PORT_BINDING_INVALID/u,
  );
});

test("cleanup ownership requires exact Compose, volume, image and temp identities", () => {
  const instanceId = "an-instance-id-owned-by-this-run";
  assert.doesNotThrow(() =>
    assertOwnedComposeLabels({ "com.docker.compose.project": identity.project }, identity),
  );
  assert.doesNotThrow(() =>
    assertOwnedVolumeLabels(
      {
        "com.laundry-desk.managed": "true",
        "com.laundry-desk.project": identity.project,
        "com.laundry-desk.instance": instanceId,
      },
      identity,
      instanceId,
    ),
  );
  assert.doesNotThrow(() =>
    assertOwnedImage({ "com.laundry-desk.acceptance": identity.acceptanceLabel }, identity),
  );
  assert.equal(
    assertOwnedTemporaryRoot("/private/tmp", "/private/tmp/laundry-runtime-counter-fixture_123"),
    "/private/tmp/laundry-runtime-counter-fixture_123",
  );
  assert.throws(
    () =>
      assertOwnedVolumeLabels(
        {
          "com.laundry-desk.managed": "true",
          "com.laundry-desk.project": "other-project",
          "com.laundry-desk.instance": instanceId,
        },
        identity,
        instanceId,
      ),
    /RUNTIME_COUNTER_VOLUME_UNOWNED/u,
  );
  assert.throws(
    () => assertOwnedTemporaryRoot("/private/tmp", "/private/other"),
    /RUNTIME_COUNTER_TEMP_ROOT_INVALID/u,
  );
});

test("success marker cannot be mistaken for formal or physical evidence", () => {
  assert.match(SOFTWARE_ONLY_MARKER, /assurance=software_only/u);
  assert.match(SOFTWARE_ONLY_MARKER, /runner=system/u);
  assert.match(SOFTWARE_ONLY_MARKER, /ports=8543,8787/u);
  assert.doesNotMatch(SOFTWARE_ONLY_MARKER, /formal|physical|notari[sz]ed/iu);
});
