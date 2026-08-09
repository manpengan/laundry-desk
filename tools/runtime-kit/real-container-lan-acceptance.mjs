import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomInt, X509Certificate } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createServer as createTcpServer, connect } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkServerIdentity } from "node:tls";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadLanStaticAssets } from "../local/lan-gateway-core.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const baseComposeSource = join(repositoryRoot, "tools/compose/docker-compose.runtime.yml");
const lanComposeSource = join(repositoryRoot, "tools/compose/docker-compose.runtime-lan.yml");
const dockerfile = join(repositoryRoot, "apps/server/Dockerfile.runtime");
const migrationRoot = join(repositoryRoot, "packages/db/src/migrations");
const webRoot = join(repositoryRoot, "apps/web/dist-spa");
const commandEnvironment = Object.freeze({
  ...process.env,
  PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
});
const executableRoots = Object.freeze(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]);
const dockerCandidates = Object.freeze([
  "/Applications/Docker.app/Contents/Resources/bin/docker",
  ...executableRoots.map((root) => join(root, "docker")),
]);
const pnpmCandidates = Object.freeze(executableRoots.map((root) => join(root, "pnpm")));

async function firstExecutable(candidates, errorCode) {
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue through fixed installation locations.
    }
  }
  throw new Error(errorCode);
}

const COMMAND_TIMEOUT_MS = 120_000;
const BUILD_TIMEOUT_MS = 15 * 60_000;
const TERMINATION_GRACE_MS = 2_000;
export function execute(file, args, options = {}, dependencies = {}) {
  const spawnChild = dependencies.spawn ?? spawn;
  const graceMs = dependencies.graceMs ?? TERMINATION_GRACE_MS;
  const timeoutMs = options.timeoutMs ?? COMMAND_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > BUILD_TIMEOUT_MS) {
    throw new Error("RUNTIME_LAN_TIMEOUT_INVALID");
  }
  const label = options.label ?? "COMMAND";
  return new Promise((resolveRun, rejectRun) => {
    let child;
    try {
      child = spawnChild(file, args, {
        cwd: options.cwd ?? repositoryRoot,
        env: options.env ?? commandEnvironment,
        shell: false,
        stdio: options.visible ? "inherit" : ["ignore", "pipe", "pipe"],
      });
    } catch {
      rejectRun(new Error(`${label}_FAILED`));
      return;
    }
    const stdout = [];
    let bytes = 0;
    let settled = false,
      timedOut = false,
      terminationTimer,
      timeoutTimer;
    const onStdout = (chunk) => {
      bytes += chunk.byteLength;
      if (bytes <= 1024 * 1024) stdout.push(chunk);
    };
    const onStderr = (chunk) => (bytes += chunk.byteLength);
    const cleanup = () => {
      for (const timer of [timeoutTimer, terminationTimer]) clearTimeout(timer);
      child.removeListener("error", onError);
      child.removeListener("close", onClose);
      child.stdout?.removeListener("data", onStdout);
      child.stderr?.removeListener("data", onStderr);
    };
    const finish = (error, output = "") => {
      if (settled) return;
      settled = true;
      cleanup();
      error === undefined ? resolveRun(output) : rejectRun(error);
    };
    const onError = () => !timedOut && finish(new Error(`${label}_FAILED`));
    const onClose = (code) => {
      const output = Buffer.concat(stdout).toString("utf8");
      if (timedOut) finish(new Error(`${label}_TIMEOUT`));
      else if (bytes > 1024 * 1024) finish(new Error("RUNTIME_LAN_OUTPUT_TOO_LARGE"));
      else if (!(options.accepting ?? [0]).includes(code ?? 1)) {
        finish(new Error(`${label}_FAILED`));
      } else finish(undefined, output);
    };
    child.once("error", onError);
    child.once("close", onClose);
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    const kill = (signal) => {
      try {
        child.kill(signal);
      } catch {}
    };
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminationTimer = setTimeout(() => {
        timeoutTimer = setTimeout(() => finish(new Error(`${label}_TIMEOUT`)), graceMs);
        kill("SIGKILL");
      }, graceMs);
      kill("SIGTERM");
    }, timeoutMs);
  });
}

const digest = (value) => createHash("sha256").update(value).digest("hex");
const isPrivateIpv4 = (value) => {
  const parts = value.split(".").map(Number);
  return (
    parts.length === 4 &&
    parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) &&
    (parts[0] === 10 ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168))
  );
};

function selectPhysicalLanAddress() {
  const candidates = Object.entries(networkInterfaces())
    .filter(([name]) => !/^(?:lo|utun|tun|tap|wg)/u.test(name))
    .flatMap(([name, addresses]) =>
      (addresses ?? [])
        .filter((address) => address.family === "IPv4" && !address.internal)
        .map((address) => ({ name, address: address.address })),
    )
    .filter(({ address }) => isPrivateIpv4(address))
    .sort((left, right) => {
      const leftPhysical = /^en\d+$/u.test(left.name) ? 0 : 1;
      const rightPhysical = /^en\d+$/u.test(right.name) ? 0 : 1;
      return leftPhysical - rightPhysical || left.name.localeCompare(right.name);
    });
  const requested = process.env.LAUNDRY_ACCEPTANCE_LAN_IPV4;
  const selected =
    requested === undefined
      ? candidates[0]
      : candidates.find((candidate) => candidate.address === requested);
  if (selected === undefined) throw new Error("RUNTIME_LAN_PHYSICAL_INTERFACE_REQUIRED");
  return selected;
}

const selectFreePort = (host) =>
  new Promise((resolvePort, rejectPort) => {
    const server = createTcpServer();
    server.once("error", rejectPort);
    server.listen({ host, port: 0, exclusive: true }, () => {
      const address = server.address();
      assert.ok(typeof address === "object" && address !== null);
      const port = address.port;
      server.close((error) => {
        if (error !== undefined) rejectPort(error);
        else if (port === 8543 || port === 8787 || port < 1024) {
          rejectPort(new Error("RUNTIME_LAN_PORT_INVALID"));
        } else resolvePort(port);
      });
    });
  });

const portCanBind = (host, port) =>
  new Promise((resolveAvailability) => {
    const server = createTcpServer();
    const finish = (available) => {
      server.removeAllListeners();
      resolveAvailability(available);
    };
    server.once("error", () => finish(false));
    server.listen({ host, port, exclusive: true }, () => {
      server.close((error) => finish(error === undefined));
    });
  });

async function migrationBundle() {
  const names = (await readdir(migrationRoot))
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/u.test(name))
    .sort();
  assert.ok(names.length > 0);
  const records = [];
  for (const name of names)
    records.push(`${name}\0${digest(await readFile(join(migrationRoot, name)))}\n`);
  return Object.freeze({ sha256: digest(records.join("")), head: names.at(-1) });
}

async function writePrivate(path, value) {
  await writeFile(path, value, { flag: "wx", mode: 0o600 });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
}

async function createCertificate(root, host) {
  const config = join(root, "openssl.cnf");
  const certificate = join(root, "certificate.pem");
  const privateKey = join(root, "private-key.pem");
  await writePrivate(
    config,
    `[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=v3\n[dn]\nCN=${host}\n[v3]\nsubjectAltName=IP:${host}\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth\n`,
  );
  await execute(
    "/usr/bin/openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-sha256",
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
    { label: "CERTIFICATE_CREATE" },
  );
  await chmod(privateKey, 0o600);
  await chmod(certificate, 0o600);
  const certificatePem = await readFile(certificate, "utf8");
  const parsed = new X509Certificate(certificatePem);
  const spki = parsed.publicKey.export({ format: "der", type: "spki" });
  return Object.freeze({
    certificate,
    privateKey,
    certificatePem,
    spkiSha256: createHash("sha256").update(spki).digest("base64"),
  });
}

const tcpConnects = (host, port) =>
  new Promise((resolveConnection) => {
    const socket = connect({ host, port });
    const finish = (connected) => {
      socket.destroy();
      resolveConnection(connected);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(1_000, () => finish(false));
  });

function requestLan({ host, port, ca, path, method = "GET", headers = {}, body = "" }) {
  return new Promise((resolveRequest, rejectRequest) => {
    const request = httpsRequest(
      {
        host,
        port,
        path,
        method,
        ca,
        rejectUnauthorized: true,
        checkServerIdentity: (_hostname, certificate) => checkServerIdentity(host, certificate),
        headers,
      },
      (response) => {
        const chunks = [];
        let bytes = 0;
        response.on("data", (chunk) => {
          bytes += chunk.byteLength;
          if (bytes <= 1024 * 1024) chunks.push(chunk);
        });
        response.once("end", () => {
          if (bytes > 1024 * 1024) rejectRequest(new Error("RUNTIME_LAN_RESPONSE_TOO_LARGE"));
          else resolveRequest({ status: response.statusCode, body: Buffer.concat(chunks) });
        });
      },
    );
    request.setTimeout(5_000, () => request.destroy(new Error("RUNTIME_LAN_REQUEST_TIMEOUT")));
    request.once("error", rejectRequest);
    request.end(body);
  });
}

async function waitForGateway(requestOptions) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const response = await requestLan({ ...requestOptions, path: "/health" }).catch(() => null);
    if (response?.status === 200) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error("RUNTIME_LAN_GATEWAY_NOT_READY");
}

function requestLoopbackHealth() {
  return new Promise((resolveHealth, rejectHealth) => {
    const request = httpRequest(
      { host: "127.0.0.1", port: 8787, path: "/health", method: "GET" },
      (response) => {
        let bytes = 0;
        response.on("data", (chunk) => {
          bytes += chunk.byteLength;
          if (bytes > 8 * 1024) response.destroy(new Error("LOOPBACK_HEALTH_TOO_LARGE"));
        });
        response.once("error", rejectHealth);
        response.once("end", () => resolveHealth(response.statusCode));
      },
    );
    request.setTimeout(5_000, () => request.destroy(new Error("LOOPBACK_HEALTH_TIMEOUT")));
    request.once("error", rejectHealth);
    request.end();
  });
}

async function inspectOwnedVolume(name, project, runDocker) {
  const raw = await runDocker(["volume", "inspect", "--format", "{{json .Labels}}", name]);
  const labels = JSON.parse(raw);
  assert.equal(labels["com.laundry-desk.managed"], "true");
  assert.equal(labels["com.laundry-desk.project"], project);
}

export async function runRealContainerLanAcceptance() {
  const docker = await firstExecutable(dockerCandidates, "RUNTIME_LAN_DOCKER_UNAVAILABLE");
  const pnpm = await firstExecutable(pnpmCandidates, "RUNTIME_LAN_PNPM_UNAVAILABLE");
  const dockerRun = (args, options = {}) => execute(docker, args, options);
  const buildRun = (file, args, label, options = {}) =>
    execute(file, args, { ...options, visible: true, label, timeoutMs: BUILD_TIMEOUT_MS });
  const suffix = randomBytes(8).toString("hex");
  const project = `laundry-lan-accept-${suffix}`;
  const databaseVolume = `${project}_pgdata-v2`;
  const photoVolume = `${project}_photos`;
  const image = `laundry-runtime-lan-acceptance:${suffix}`;
  const imageLabel = `com.laundry-desk.acceptance=${project}`;
  const temporary = await mkdtemp(join(tmpdir(), "laundry-runtime-real-lan-"));
  const configRoot = join(temporary, "runtime");
  const secretsRoot = join(configRoot, "secrets");
  const lanRoot = join(temporary, "lan-generation");
  const baseCompose = join(temporary, "docker-compose.runtime.yml");
  const { address: lanHost } = selectPhysicalLanAddress();
  const lanPort = await selectFreePort(lanHost);
  const origin = `https://${lanHost}:${lanPort}`;
  let environment;

  try {
    await mkdir(secretsRoot, { recursive: true, mode: 0o700 });
    await mkdir(lanRoot, { mode: 0o700 });
    await buildRun(pnpm, ["--filter", "@laundry/ui", "build"], "UI_BUILD");
    await buildRun(pnpm, ["--filter", "@laundry/web", "build"], "WEB_BUILD");
    const ownerSpaSha256 = (await loadLanStaticAssets(webRoot)).sha256;
    const migrations = await migrationBundle();
    const release = "0.1.0-lan-acceptance";
    const checksum = digest(
      await readFile(join(repositoryRoot, "packages/contracts/openapi/laundry-v2.openapi.json")),
    );
    const postgresImage = (
      await dockerRun(["image", "inspect", "--format", "{{index .RepoDigests 0}}", "postgres:16"], {
        label: "POSTGRES_IMAGE_INSPECT",
      })
    ).trim();
    assert.match(postgresImage, /^[A-Za-z0-9._/-]+@sha256:[0-9a-f]{64}$/u);

    await dockerRun(
      [
        "build",
        "--file",
        dockerfile,
        "--tag",
        image,
        "--label",
        imageLabel,
        "--build-arg",
        `RUNTIME_RELEASE=${release}`,
        "--build-arg",
        "RUNTIME_CONTRACTS_MAJOR=2",
        "--build-arg",
        `RUNTIME_CONTRACTS_SHA256=${checksum}`,
        "--build-arg",
        `RUNTIME_SERVER_VERSION=${release}`,
        "--build-arg",
        `RUNTIME_WEB_BUNDLE_SHA256=${ownerSpaSha256}`,
        "--build-arg",
        `RUNTIME_SCHEMA_SHA256=${digest(await readFile(join(repositoryRoot, "packages/db/src/README.md")))}`,
        "--build-arg",
        `RUNTIME_MIGRATIONS_SHA256=${migrations.sha256}`,
        "--build-arg",
        `RUNTIME_MIGRATION_HEAD=${migrations.head}`,
        repositoryRoot,
      ],
      { visible: true, label: "RUNTIME_IMAGE_BUILD", timeoutMs: BUILD_TIMEOUT_MS },
    );

    const baseSource = await readFile(baseComposeSource, "utf8");
    assert.equal(baseSource.includes("laundry-desk-runtime_pgdata-v2"), true);
    assert.equal(baseSource.includes("laundry-desk-runtime_photos"), true);
    await writePrivate(
      baseCompose,
      baseSource
        .replaceAll("laundry-desk-runtime_pgdata-v2", databaseVolume)
        .replaceAll("laundry-desk-runtime_photos", photoVolume),
    );
    const certificate = await createCertificate(lanRoot, lanHost);
    await writePrivate(
      join(lanRoot, "config.json"),
      `${JSON.stringify({ schema_version: 1, public_host: lanHost, public_port: lanPort, owner_spa_sha256: ownerSpaSha256 })}\n`,
    );

    const postgresPassword = randomBytes(32).toString("base64url");
    const appPassword = randomBytes(32).toString("base64url");
    const adminPassword = randomBytes(32).toString("base64url");
    const approverPassword = randomBytes(32).toString("base64url");
    const adminPin = String(randomInt(100_000, 1_000_000));
    let approverPin = String(randomInt(100_000, 1_000_000));
    while (approverPin === adminPin) approverPin = String(randomInt(100_000, 1_000_000));
    const secretValues = Object.freeze({
      "postgres-password": postgresPassword,
      "app-password": appPassword,
      "database-url": `postgresql://laundry_app:${appPassword}@postgres:5432/laundry_v2`,
      "database-admin-url": `postgresql://postgres:${postgresPassword}@postgres:5432/laundry_v2`,
      "access-token-secret": randomBytes(48).toString("base64url"),
      "csrf-proof-secret": randomBytes(48).toString("base64url"),
      "bootstrap-admin-username": "owner",
      "bootstrap-admin-display-name": "Local Owner",
      "bootstrap-admin-password": adminPassword,
      "bootstrap-admin-pin": adminPin,
      "bootstrap-approver-username": "approver",
      "bootstrap-approver-display-name": "Approval Administrator",
      "bootstrap-approver-password": approverPassword,
      "bootstrap-approver-pin": approverPin,
    });
    for (const [name, value] of Object.entries(secretValues))
      await writePrivate(join(secretsRoot, name), value);
    environment = Object.freeze({
      ...commandEnvironment,
      COMPOSE_PROJECT_NAME: project,
      LAUNDRY_RUNTIME_CONFIG_ROOT: configRoot,
      LAUNDRY_RUNTIME_LAN_CONFIG_ROOT: lanRoot,
      LAUNDRY_RUNTIME_SERVER_IMAGE: image,
      LAUNDRY_RUNTIME_POSTGRES_IMAGE: postgresImage,
      LAUNDRY_RUNTIME_RELEASE: release,
      LAUNDRY_RUNTIME_CONTRACTS_SHA256: checksum,
      LAUNDRY_RUNTIME_SCHEMA_SHA256: digest(
        await readFile(join(repositoryRoot, "packages/db/src/README.md")),
      ),
      LAUNDRY_RUNTIME_MIGRATIONS_SHA256: migrations.sha256,
      LAUNDRY_RUNTIME_MIGRATION_HEAD: migrations.head,
      LAUNDRY_RUNTIME_LAN_BIND_HOST: lanHost,
      LAUNDRY_RUNTIME_LAN_PORT: String(lanPort),
    });
    const compose = [
      "compose",
      "--project-name",
      project,
      "--file",
      baseCompose,
      "--file",
      lanComposeSource,
    ];
    const baseOnlyCompose = ["compose", "--project-name", project, "--file", baseCompose];
    await dockerRun(
      [
        "volume",
        "create",
        "--label",
        "com.laundry-desk.managed=true",
        "--label",
        `com.laundry-desk.project=${project}`,
        databaseVolume,
      ],
      { env: environment },
    );
    await dockerRun(
      [
        "volume",
        "create",
        "--label",
        "com.laundry-desk.managed=true",
        "--label",
        `com.laundry-desk.project=${project}`,
        photoVolume,
      ],
      { env: environment },
    );
    await dockerRun([...compose, "up", "--detach", "--wait", "postgres"], {
      env: environment,
      visible: true,
      label: "POSTGRES_START",
    });
    for (const service of ["roles", "migrate", "bootstrap"])
      await dockerRun([...compose, "run", "--rm", service], {
        env: environment,
        visible: true,
        label: service.toUpperCase(),
      });
    await dockerRun([...compose, "run", "--rm", "verify", "verify-commissioned"], {
      env: environment,
      visible: true,
      label: "VERIFY_COMMISSIONED",
    });
    await dockerRun([...compose, "up", "--detach", "--wait", "server"], {
      env: environment,
      visible: true,
      label: "SERVER_START",
    });
    await dockerRun([...compose, "up", "--detach", "--wait", "lan-gateway"], {
      env: environment,
      visible: true,
      label: "GATEWAY_START",
    });
    await waitForGateway({ host: lanHost, port: lanPort, ca: certificate.certificatePem });

    const common = { host: lanHost, port: lanPort, ca: certificate.certificatePem };
    assert.equal((await requestLan({ ...common, path: "/owner" })).status, 200);
    assert.equal((await requestLan({ ...common, path: "/health" })).status, 200);
    assert.equal(
      (await requestLan({ ...common, path: "/health", headers: { host: "wrong.invalid" } })).status,
      400,
    );
    assert.equal(
      (await requestLan({ ...common, path: "/health", headers: { forwarded: "for=192.0.2.1" } }))
        .status,
      400,
    );
    assert.equal(
      (
        await requestLan({
          ...common,
          path: "/health",
          headers: { "x-forwarded-for": "192.0.2.1" },
        })
      ).status,
      400,
    );
    for (const headers of [
      { origin: "https://wrong.invalid", "sec-fetch-site": "same-origin" },
      { origin, "sec-fetch-site": "cross-site" },
    ]) {
      assert.equal(
        (
          await requestLan({
            ...common,
            path: "/api/v2/auth/login",
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: "{}",
          })
        ).status,
        403,
      );
    }
    assert.equal(
      (
        await requestLan({
          ...common,
          path: "/v1/commands/order.receive",
          method: "POST",
          headers: { origin, "sec-fetch-site": "same-origin", "content-type": "application/json" },
          body: "{}",
        })
      ).status,
      404,
    );
    assert.equal((await requestLan({ ...common, path: "/" })).status, 404);
    assert.equal((await requestLan({ ...common, path: "/index.html" })).status, 404);
    assert.deepEqual(await Promise.all([tcpConnects(lanHost, 8787), tcpConnects(lanHost, 8543)]), [
      false,
      false,
    ]);

    const serverId = (
      await dockerRun([...compose, "ps", "--quiet", "server"], { env: environment })
    ).trim();
    const gatewayId = (
      await dockerRun([...compose, "ps", "--quiet", "lan-gateway"], { env: environment })
    ).trim();
    for (const id of [serverId, gatewayId]) {
      const inspected = JSON.parse(
        await dockerRun(["container", "inspect", id], { env: environment }),
      )[0];
      assert.equal(inspected.Config.User, "10001:10001");
      assert.equal(inspected.HostConfig.ReadonlyRootfs, true);
      assert.ok(inspected.HostConfig.CapDrop.includes("ALL"));
      assert.ok(inspected.HostConfig.SecurityOpt.includes("no-new-privileges:true"));
    }
    const gatewayInspect = JSON.parse(
      await dockerRun(["container", "inspect", gatewayId], { env: environment }),
    )[0];
    assert.equal(gatewayInspect.HostConfig.NetworkMode, `container:${serverId}`);
    assert.equal(gatewayInspect.Config.Image, image);

    await buildRun(
      pnpm,
      ["exec", "playwright", "test", "-c", "apps/web/playwright.lan.config.ts"],
      "PLAYWRIGHT_LAN",
      {
        env: {
          ...environment,
          LAUNDRY_LAN_ORIGIN: origin,
          LAUNDRY_TEST_CERT_SPKI: certificate.spkiSha256,
          LAUNDRY_LOCAL_ORG_CODE: "local",
          LAUNDRY_LOCAL_STORE_CODE: "main",
          LAUNDRY_BOOTSTRAP_ADMIN_USERNAME: "owner",
          LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD: adminPassword,
        },
      },
    );

    const serverBeforeDisable = JSON.parse(
      await dockerRun(["container", "inspect", serverId], { env: environment }),
    )[0];
    assert.deepEqual(serverBeforeDisable.HostConfig.PortBindings[`${lanPort}/tcp`], [
      { HostIp: lanHost, HostPort: String(lanPort) },
    ]);
    await dockerRun([...compose, "rm", "--stop", "--force", "lan-gateway"], {
      env: environment,
      visible: true,
      label: "GATEWAY_DISABLE",
    });
    assert.equal(await portCanBind(lanHost, lanPort), false);
    assert.equal(
      (await dockerRun([...compose, "ps", "--quiet", "server"], { env: environment })).trim(),
      serverId,
    );
    assert.equal(
      (
        await dockerRun(["container", "inspect", "--format", "{{.State.Running}}", serverId], {
          env: environment,
        })
      ).trim(),
      "true",
    );
    await dockerRun([...baseOnlyCompose, "up", "--detach", "--wait", "server"], {
      env: environment,
      visible: true,
      label: "SERVER_RELEASE_LAN_PORT_AFTER_DISABLE",
    });
    const baseServerId = (
      await dockerRun([...baseOnlyCompose, "ps", "--quiet", "server"], { env: environment })
    ).trim();
    assert.notEqual(baseServerId, serverId);
    assert.equal(await portCanBind(lanHost, lanPort), true);
    assert.equal(await requestLoopbackHealth(), 200);
    await dockerRun([...compose, "up", "--detach", "--wait", "lan-gateway"], {
      env: environment,
      visible: true,
      label: "GATEWAY_REENABLE",
    });
    assert.equal((await requestLan({ ...common, path: "/health" })).status, 200);
    const reenabledServerId = (
      await dockerRun([...compose, "ps", "--quiet", "server"], { env: environment })
    ).trim();
    assert.notEqual(reenabledServerId, baseServerId);
    const reenabledServer = JSON.parse(
      await dockerRun(["container", "inspect", reenabledServerId], { env: environment }),
    )[0];
    assert.equal(reenabledServer.State.Health.Status, "healthy");
    assert.deepEqual(reenabledServer.HostConfig.PortBindings[`${lanPort}/tcp`], [
      { HostIp: lanHost, HostPort: String(lanPort) },
    ]);
    const reenabledGatewayId = (
      await dockerRun([...compose, "ps", "--quiet", "lan-gateway"], { env: environment })
    ).trim();
    assert.notEqual(reenabledGatewayId, gatewayId);
    assert.equal(
      (
        await dockerRun(
          ["container", "inspect", "--format", "{{.State.Health.Status}}", reenabledGatewayId],
          { env: environment },
        )
      ).trim(),
      "healthy",
    );

    await dockerRun([...compose, "rm", "--stop", "--force", "lan-gateway"], {
      env: environment,
      visible: true,
      label: "GATEWAY_DISABLE_FOR_RECONFIGURE",
    });
    assert.equal(await portCanBind(lanHost, lanPort), false);
    assert.equal(
      (await dockerRun([...compose, "ps", "--quiet", "server"], { env: environment })).trim(),
      reenabledServerId,
    );
    await dockerRun(
      [...baseOnlyCompose, "up", "--detach", "--wait", "--force-recreate", "--no-deps", "server"],
      {
        env: environment,
        visible: true,
        label: "SERVER_RELEASE_LAN_PORT_FOR_RECONFIGURE",
      },
    );
    const reconfiguredBaseServerId = (
      await dockerRun([...baseOnlyCompose, "ps", "--quiet", "server"], { env: environment })
    ).trim();
    assert.notEqual(reconfiguredBaseServerId, reenabledServerId);
    assert.equal(await portCanBind(lanHost, lanPort), true);
    assert.equal(await requestLoopbackHealth(), 200);
    await dockerRun([...compose, "up", "--detach", "--wait", "lan-gateway"], {
      env: environment,
      visible: true,
      label: "GATEWAY_ENABLE_AFTER_RECONFIGURE",
    });
    assert.equal((await requestLan({ ...common, path: "/health" })).status, 200);
    const reconfiguredServerId = (
      await dockerRun([...compose, "ps", "--quiet", "server"], { env: environment })
    ).trim();
    const reconfiguredGatewayId = (
      await dockerRun([...compose, "ps", "--quiet", "lan-gateway"], { env: environment })
    ).trim();
    assert.notEqual(reconfiguredServerId, reconfiguredBaseServerId);
    assert.notEqual(reconfiguredGatewayId, reenabledGatewayId);
    for (const id of [reconfiguredServerId, reconfiguredGatewayId]) {
      assert.equal(
        (
          await dockerRun(["container", "inspect", "--format", "{{.State.Health.Status}}", id], {
            env: environment,
          })
        ).trim(),
        "healthy",
      );
    }
  } finally {
    if (environment !== undefined) {
      const compose = [
        "compose",
        "--project-name",
        project,
        "--file",
        baseCompose,
        "--file",
        lanComposeSource,
      ];
      await dockerRun([...compose, "down", "--remove-orphans"], {
        env: environment,
        accepting: [0, 1],
      }).catch(() => undefined);
    }
    for (const volume of [databaseVolume, photoVolume]) {
      await inspectOwnedVolume(volume, project, dockerRun)
        .then(() => dockerRun(["volume", "rm", "--force", volume], { accepting: [0, 1] }))
        .catch(() => undefined);
    }
    const labels = await dockerRun(
      ["image", "inspect", "--format", "{{json .Config.Labels}}", image],
      { accepting: [0, 1] },
    ).catch(() => "");
    if (labels.length > 0 && JSON.parse(labels)?.["com.laundry-desk.acceptance"] === project)
      await dockerRun(["image", "rm", "--force", image], { accepting: [0, 1] });
    await chmod(temporary, 0o700).catch(() => undefined);
    await rm(temporary, { recursive: true, force: true });
  }

  for (const [kind, args] of [
    [
      "containers",
      [
        "container",
        "ls",
        "--all",
        "--quiet",
        "--filter",
        `label=com.docker.compose.project=${project}`,
      ],
    ],
    [
      "networks",
      ["network", "ls", "--quiet", "--filter", `label=com.docker.compose.project=${project}`],
    ],
    [
      "volumes",
      ["volume", "ls", "--quiet", "--filter", `label=com.laundry-desk.project=${project}`],
    ],
    [
      "images",
      ["image", "ls", "--quiet", "--filter", `label=com.laundry-desk.acceptance=${project}`],
    ],
  ]) {
    assert.equal((await dockerRun(args, { label: `CLEANUP_${kind.toUpperCase()}` })).trim(), "");
  }
  process.stdout.write(
    `RUNTIME_REAL_CONTAINER_LAN_ACCEPTANCE_OK project=${project} host=${lanHost} port=${lanPort} lifecycle=plain-disable-reenable-and-reconfigure-clean\n`,
  );
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && pathToFileURL(resolve(invokedPath)).href === import.meta.url) {
  await runRealContainerLanAcceptance();
}
