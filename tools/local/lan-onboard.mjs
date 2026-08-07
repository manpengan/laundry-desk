import { pathToFileURL } from "node:url";

import QRCode from "qrcode";

import {
  assertLanCertificateReady,
  inspectLanCertificate,
  LanCertificateError,
} from "./lan-certificate.mjs";
import { LanGatewayConfigError, loadLanGatewayConfig } from "./lan-gateway-config.mjs";

export class LanOnboardingError extends Error {
  constructor(code) {
    super(code);
    this.name = "LanOnboardingError";
    this.code = code;
  }
}

export function parseLanOnboardingArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 0) {
    throw new LanOnboardingError("LAN_ONBOARD_ARGS_INVALID");
  }
}

export function createLanOnboarding(config, certificate) {
  assertLanCertificateReady(certificate);
  return Object.freeze({
    ownerUrl: `${config.origin}/owner`,
    host: config.bindHost,
    fingerprintSha256: certificate.fingerprintSha256,
    validTo: certificate.validTo,
    selfSigned: certificate.selfSigned,
  });
}

export function formatLanOnboarding(onboarding, qr) {
  const trustSource = onboarding.selfSigned
    ? "Install the configured public certificate as the trust anchor."
    : "Install the issuing private CA certificate, not the server private key.";
  return [
    "Laundry Desk LAN onboarding (credential-free)",
    `Owner URL: ${onboarding.ownerUrl}`,
    "The QR contains only this HTTPS URL; it contains no account, password, PIN, or session.",
    qr.trimEnd(),
    "Certificate verification:",
    `- Expected IP SAN: ${onboarding.host}`,
    `- Leaf SHA-256: ${onboarding.fingerprintSha256}`,
    `- Valid until: ${onboarding.validTo}`,
    `- ${trustSource}`,
    "Device trust steps:",
    "1. Transfer only the public certificate or issuing CA over a trusted local channel.",
    "2. iPhone/iPad: install the profile, then enable full trust in Certificate Trust Settings.",
    "3. Android: install the issuing CA under Security > Encryption & credentials.",
    "4. macOS: import the trust anchor in Keychain Access and explicitly trust it.",
    "5. Reopen the URL and verify the displayed leaf SHA-256 fingerprint before login.",
    "Never transfer, scan, or install LAUNDRY_TLS_KEY_FILE on a client device.",
    "Do not bypass a browser certificate warning.",
    "",
  ].join("\n");
}

const defaultDependencies = () =>
  Object.freeze({
    loadConfig: loadLanGatewayConfig,
    inspectCertificate: inspectLanCertificate,
    renderQr: (value) =>
      QRCode.toString(value, {
        type: "terminal",
        small: true,
        errorCorrectionLevel: "M",
        margin: 1,
      }),
  });

export async function runLanOnboarding(options, dependencies = defaultDependencies()) {
  parseLanOnboardingArguments(options.argv);
  const config = await dependencies.loadConfig(options.env);
  const onboarding = createLanOnboarding(config, dependencies.inspectCertificate(config));
  const qr = await dependencies.renderQr(onboarding.ownerUrl);
  options.stdout(formatLanOnboarding(onboarding, qr));
  return onboarding;
}

function safeErrorCode(error) {
  if (
    error instanceof LanOnboardingError ||
    error instanceof LanGatewayConfigError ||
    error instanceof LanCertificateError
  ) {
    return error.code;
  }
  return "LAN_ONBOARD_FAILED";
}

const isMainModule = () => {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href;
};

if (isMainModule()) {
  void runLanOnboarding({
    argv: Object.freeze(process.argv.slice(2)),
    env: process.env,
    stdout: (text) => process.stdout.write(text),
  }).catch((error) => {
    process.stderr.write(`${safeErrorCode(error)}\n`);
    process.exitCode = 1;
  });
}
