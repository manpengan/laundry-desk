import assert from "node:assert/strict";
import { chmod, link, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  isPrivateLanIpv4,
  LanGatewayConfigError,
  loadLanGatewayConfig,
  loadRuntimeLanGatewayConfig,
  loadRuntimeLanHealthcheckConfig,
} from "./lan-gateway-config.mjs";

const OWNER_SPA_SHA256 = "a".repeat(64);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "laundry-lan-config-"));
  const certPath = join(root, "cert.pem");
  const keyPath = join(root, "key.pem");
  await writeFile(certPath, "test certificate", { mode: 0o644 });
  await writeFile(keyPath, "test private key", { mode: 0o600 });
  return Object.freeze({ root, certPath, keyPath });
}

function environment(paths, overrides = {}) {
  return Object.freeze({
    LAUNDRY_LAN_ORIGIN: "https://192.168.50.12:8443",
    LAUNDRY_LAN_BIND_HOST: "192.168.50.12",
    LAUNDRY_TLS_CERT_FILE: paths.certPath,
    LAUNDRY_TLS_KEY_FILE: paths.keyPath,
    ...overrides,
  });
}

test("accepts only explicit RFC1918 IPv4 addresses", () => {
  for (const address of ["10.0.0.1", "172.16.0.1", "172.31.255.254", "192.168.1.2"]) {
    assert.equal(isPrivateLanIpv4(address), true, address);
  }
  for (const address of [
    "127.0.0.1",
    "169.254.1.1",
    "172.15.0.1",
    "172.32.0.1",
    "198.18.0.1",
    "8.8.8.8",
    "192.168.1.999",
  ]) {
    assert.equal(isPrivateLanIpv4(address), false, address);
  }
});

test("loads an exact HTTPS LAN profile with private key bytes kept out of argv", async () => {
  const paths = await fixture();
  const config = await loadLanGatewayConfig(environment(paths));

  assert.equal(config.origin, "https://192.168.50.12:8443");
  assert.equal(config.authority, "192.168.50.12:8443");
  assert.equal(config.bindHost, "192.168.50.12");
  assert.equal(config.port, 8443);
  assert.equal(config.backendHost, "127.0.0.1");
  assert.equal(config.backendPort, 8787);
  assert.equal(config.cert.toString(), "test certificate");
  assert.equal(config.key.toString(), "test private key");
  assert.equal(Object.isFrozen(config), true);
});

test("fails closed for non-HTTPS, non-private, mismatched, or non-canonical origins", async () => {
  const paths = await fixture();
  const invalid = [
    { LAUNDRY_LAN_ORIGIN: "" },
    { LAUNDRY_LAN_ORIGIN: " https://192.168.50.12:8443" },
    { LAUNDRY_LAN_ORIGIN: "http://192.168.50.12:8443" },
    { LAUNDRY_LAN_ORIGIN: "https://0.0.0.0:8443", LAUNDRY_LAN_BIND_HOST: "0.0.0.0" },
    { LAUNDRY_LAN_ORIGIN: "https://127.0.0.1:8443", LAUNDRY_LAN_BIND_HOST: "127.0.0.1" },
    { LAUNDRY_LAN_ORIGIN: "https://198.18.0.1:8443", LAUNDRY_LAN_BIND_HOST: "198.18.0.1" },
    { LAUNDRY_LAN_ORIGIN: "https://[fd00::12]:8443", LAUNDRY_LAN_BIND_HOST: "fd00::12" },
    { LAUNDRY_LAN_ORIGIN: "https://192.168.50.12:1023" },
    { LAUNDRY_LAN_ORIGIN: "https://192.168.50.12:8443/owner" },
    { LAUNDRY_LAN_ORIGIN: "https://192.168.50.12:8443?route=owner" },
    { LAUNDRY_LAN_ORIGIN: "https://192.168.50.12:8443#owner" },
    { LAUNDRY_LAN_ORIGIN: "https://user@192.168.50.12:8443" },
    { LAUNDRY_LAN_ORIGIN: "https://192.168.50.12" },
    { LAUNDRY_LAN_BIND_HOST: "192.168.50.13" },
    { LAUNDRY_TLS_KEY_FILE: "relative-key.pem" },
    { LAUNDRY_TLS_KEY_FILE: paths.certPath },
  ];
  for (const override of invalid) {
    await assert.rejects(
      () => loadLanGatewayConfig(environment(paths, override)),
      (error) => error instanceof LanGatewayConfigError,
    );
  }
});

test("rejects permissive or linked TLS files", async () => {
  const paths = await fixture();
  await chmod(paths.keyPath, 0o644);
  await assert.rejects(
    () => loadLanGatewayConfig(environment(paths)),
    (error) => error instanceof LanGatewayConfigError && error.code.endsWith("_PERMISSIONS"),
  );

  await chmod(paths.keyPath, 0o700);
  await assert.rejects(
    () => loadLanGatewayConfig(environment(paths)),
    (error) => error instanceof LanGatewayConfigError && error.code.endsWith("_PERMISSIONS"),
  );

  await chmod(paths.keyPath, 0o200);
  await assert.rejects(
    () => loadLanGatewayConfig(environment(paths)),
    (error) => error instanceof LanGatewayConfigError,
  );

  await chmod(paths.keyPath, 0o600);
  const linkedKey = join(paths.root, "linked-key.pem");
  await symlink(paths.keyPath, linkedKey);
  await assert.rejects(
    () =>
      loadLanGatewayConfig(
        environment(paths, {
          LAUNDRY_TLS_KEY_FILE: linkedKey,
        }),
      ),
    (error) => error instanceof LanGatewayConfigError,
  );

  const linkedCertificate = join(paths.root, "linked-cert.pem");
  await symlink(paths.certPath, linkedCertificate);
  await assert.rejects(
    () =>
      loadLanGatewayConfig(
        environment(paths, {
          LAUNDRY_TLS_CERT_FILE: linkedCertificate,
        }),
      ),
    (error) => error instanceof LanGatewayConfigError,
  );

  const hardlinkedKey = join(paths.root, "hardlinked-key.pem");
  await link(paths.keyPath, hardlinkedKey);
  await assert.rejects(
    () => loadLanGatewayConfig(environment(paths)),
    (error) => error instanceof LanGatewayConfigError && error.code.endsWith("_HARDLINKS"),
  );
});

test("runtime mode loads public address and SPA identity only from one bounded config file", async () => {
  const paths = await fixture();
  const configPath = join(paths.root, "lan-config.json");
  await writeFile(
    configPath,
    `${JSON.stringify({
      schema_version: 1,
      public_host: "192.168.50.12",
      public_port: 8443,
      owner_spa_sha256: OWNER_SPA_SHA256,
    })}\n`,
    { mode: 0o600 },
  );

  const config = await loadRuntimeLanGatewayConfig({
    configPath,
    certPath: paths.certPath,
    keyPath: paths.keyPath,
    webRoot: "/opt/laundry/owner-spa",
  });

  assert.deepEqual(
    {
      origin: config.origin,
      authority: config.authority,
      bindHost: config.bindHost,
      listenHost: config.listenHost,
      port: config.port,
      ownerSpaSha256: config.ownerSpaSha256,
      webRoot: config.webRoot,
      backendHost: config.backendHost,
      backendPort: config.backendPort,
    },
    {
      origin: "https://192.168.50.12:8443",
      authority: "192.168.50.12:8443",
      bindHost: "192.168.50.12",
      listenHost: "0.0.0.0",
      port: 8443,
      ownerSpaSha256: OWNER_SPA_SHA256,
      webRoot: "/opt/laundry/owner-spa",
      backendHost: "127.0.0.1",
      backendPort: 8787,
    },
  );

  const healthcheck = await loadRuntimeLanHealthcheckConfig({
    configPath,
    certPath: paths.certPath,
  });
  assert.deepEqual(
    {
      authority: healthcheck.authority,
      bindHost: healthcheck.bindHost,
      port: healthcheck.port,
      cert: healthcheck.cert.toString("utf8"),
    },
    {
      authority: "192.168.50.12:8443",
      bindHost: "192.168.50.12",
      port: 8443,
      cert: "test certificate",
    },
  );
});

test("runtime mode rejects extra config keys, reserved ports, linked config, and inline PEM", async () => {
  const paths = await fixture();
  const configPath = join(paths.root, "lan-config.json");
  const writeConfig = async (value) => {
    await writeFile(configPath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  };
  const valid = {
    schema_version: 1,
    public_host: "192.168.50.12",
    public_port: 8443,
    owner_spa_sha256: OWNER_SPA_SHA256,
  };
  const runtimePaths = {
    configPath,
    certPath: paths.certPath,
    keyPath: paths.keyPath,
    webRoot: "/opt/laundry/owner-spa",
  };
  const load = () => loadRuntimeLanGatewayConfig(runtimePaths);

  for (const value of [
    { ...valid, unexpected: true },
    { ...valid, schema_version: 2 },
    { ...valid, public_host: "0.0.0.0" },
    { ...valid, public_port: 8543 },
    { ...valid, public_port: 8787 },
    { ...valid, owner_spa_sha256: "short" },
  ]) {
    await writeConfig(value);
    await assert.rejects(load, (error) => error instanceof LanGatewayConfigError);
  }

  await writeConfig(valid);
  await assert.rejects(
    () =>
      loadRuntimeLanGatewayConfig({
        ...runtimePaths,
        cert: "inline certificate forbidden",
        key: "inline private key forbidden",
      }),
    (error) => error instanceof LanGatewayConfigError,
  );
  const linkedConfig = join(paths.root, "linked-config.json");
  await symlink(configPath, linkedConfig);
  await assert.rejects(
    () =>
      loadRuntimeLanGatewayConfig({
        configPath: linkedConfig,
        certPath: paths.certPath,
        keyPath: paths.keyPath,
        webRoot: "/opt/laundry/owner-spa",
      }),
    (error) => error instanceof LanGatewayConfigError,
  );
});
