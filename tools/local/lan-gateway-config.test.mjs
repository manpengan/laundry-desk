import assert from "node:assert/strict";
import { chmod, link, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  isPrivateLanIpv4,
  LanGatewayConfigError,
  loadLanGatewayConfig,
} from "./lan-gateway-config.mjs";

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
