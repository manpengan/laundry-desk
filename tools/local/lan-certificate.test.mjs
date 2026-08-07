import assert from "node:assert/strict";
import test from "node:test";

import {
  assertLanCertificateReady,
  inspectLanCertificate,
  LanCertificateError,
} from "./lan-certificate.mjs";

const CONFIG = Object.freeze({
  bindHost: "192.168.50.12",
  cert: Buffer.from("public-certificate-marker"),
  key: Buffer.from("private-key-marker"),
});

function dependencies(overrides = {}) {
  const certificate = {
    validFrom: "Aug  7 00:00:00 2026 GMT",
    validTo: "Aug  7 00:00:00 2027 GMT",
    fingerprint256: "AA:BB:CC",
    publicKey: Object.freeze({}),
    checkIP: (value, options) => {
      assert.equal(value, CONFIG.bindHost);
      assert.deepEqual(options, { subject: "never" });
      return value;
    },
    checkPrivateKey: (key) => key.kind === "private-key",
    checkIssued: () => true,
    verify: () => true,
    ...overrides.certificate,
  };
  return Object.freeze({
    createCertificate: (bytes) => {
      assert.equal(bytes, CONFIG.cert);
      return certificate;
    },
    createKey: (bytes) => {
      assert.equal(bytes, CONFIG.key);
      return Object.freeze({ kind: "private-key" });
    },
    now: () => new Date("2026-08-08T00:00:00.000Z"),
    ...overrides.dependencies,
  });
}

test("inspects only certificate properties needed for LAN onboarding", () => {
  const summary = inspectLanCertificate(CONFIG, dependencies());

  assert.deepEqual(summary, {
    fingerprintSha256: "AA:BB:CC",
    validFrom: "2026-08-07T00:00:00.000Z",
    validTo: "2027-08-07T00:00:00.000Z",
    validNow: true,
    ipSanMatches: true,
    keyMatches: true,
    selfSigned: true,
  });
  assert.equal(Object.isFrozen(summary), true);
  assert.doesNotMatch(JSON.stringify(summary), /private-key-marker|public-certificate-marker/u);
  assert.doesNotThrow(() => assertLanCertificateReady(summary));
});

test("certificate readiness fails closed for time, IP SAN, and key mismatches", () => {
  assert.equal(
    inspectLanCertificate(
      CONFIG,
      dependencies({ dependencies: { now: () => new Date("2028-08-08T00:00:00.000Z") } }),
    ).validNow,
    false,
  );
  assert.equal(
    inspectLanCertificate(CONFIG, dependencies({ certificate: { checkIP: () => undefined } }))
      .ipSanMatches,
    false,
  );
  assert.equal(
    inspectLanCertificate(CONFIG, dependencies({ certificate: { checkPrivateKey: () => false } }))
      .keyMatches,
    false,
  );

  for (const [field, code] of [
    ["validNow", "LAN_CERTIFICATE_NOT_CURRENT"],
    ["ipSanMatches", "LAN_CERTIFICATE_IP_SAN_MISMATCH"],
    ["keyMatches", "LAN_CERTIFICATE_KEY_MISMATCH"],
  ]) {
    const summary = Object.freeze({
      validNow: true,
      ipSanMatches: true,
      keyMatches: true,
      [field]: false,
    });
    assert.throws(
      () => assertLanCertificateReady(summary),
      (error) => error instanceof LanCertificateError && error.code === code,
    );
  }
});

test("malformed certificate and private key material become stable error codes", () => {
  assert.throws(
    () =>
      inspectLanCertificate(
        CONFIG,
        dependencies({
          dependencies: {
            createCertificate: () => {
              throw new Error("certificate secret detail");
            },
          },
        }),
      ),
    (error) => error instanceof LanCertificateError && error.code === "LAN_CERTIFICATE_INVALID",
  );
  assert.throws(
    () =>
      inspectLanCertificate(
        CONFIG,
        dependencies({
          dependencies: {
            createKey: () => {
              throw new Error("private key secret detail");
            },
          },
        }),
      ),
    (error) => error instanceof LanCertificateError && error.code === "LAN_PRIVATE_KEY_INVALID",
  );
});
