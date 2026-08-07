import assert from "node:assert/strict";
import test from "node:test";

import {
  createLanOnboarding,
  parseLanOnboardingArguments,
  runLanOnboarding,
} from "./lan-onboard.mjs";

const CONFIG = Object.freeze({
  origin: "https://192.168.50.12:8443",
  bindHost: "192.168.50.12",
  cert: Buffer.from("certificate-secret-marker"),
  key: Buffer.from("private-key-secret-marker"),
});
const CERTIFICATE = Object.freeze({
  fingerprintSha256: "AA:BB:CC",
  validTo: "2027-08-07T00:00:00.000Z",
  validNow: true,
  ipSanMatches: true,
  keyMatches: true,
  selfSigned: false,
});

test("onboarding QR contains only the fixed owner URL", async () => {
  let qrPayload;
  let output = "";
  const onboarding = await runLanOnboarding(
    {
      argv: Object.freeze([]),
      env: Object.freeze({
        LAUNDRY_LOCAL_ADMIN_PASSWORD: "password-secret-marker",
        LAUNDRY_LOCAL_ADMIN_PIN: "pin-secret-marker",
        AUTHORIZATION: "token-secret-marker",
        COOKIE: "cookie-secret-marker",
      }),
      stdout: (text) => {
        output += text;
      },
    },
    Object.freeze({
      loadConfig: async () => CONFIG,
      inspectCertificate: () => CERTIFICATE,
      renderQr: async (value) => {
        qrPayload = value;
        return "[terminal QR]";
      },
    }),
  );

  assert.equal(qrPayload, "https://192.168.50.12:8443/owner");
  assert.equal(onboarding.ownerUrl, qrPayload);
  assert.match(output, /credential-free/u);
  assert.match(output, /AA:BB:CC/u);
  assert.match(output, /issuing private CA/u);
  for (const secret of [
    "certificate-secret-marker",
    "private-key-secret-marker",
    "password-secret-marker",
    "pin-secret-marker",
    "token-secret-marker",
    "cookie-secret-marker",
  ]) {
    assert.doesNotMatch(output, new RegExp(secret, "u"));
  }
});

test("onboarding fails closed before rendering a QR for an unsafe certificate", () => {
  assert.throws(
    () => createLanOnboarding(CONFIG, { ...CERTIFICATE, ipSanMatches: false }),
    /LAN_CERTIFICATE_IP_SAN_MISMATCH/u,
  );
});

test("onboarding accepts no command-line inputs", () => {
  assert.doesNotThrow(() => parseLanOnboardingArguments([]));
  assert.throws(() => parseLanOnboardingArguments(["--show-key"]), /LAN_ONBOARD_ARGS_INVALID/u);
});
