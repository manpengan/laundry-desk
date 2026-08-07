import { createPrivateKey, X509Certificate } from "node:crypto";

export class LanCertificateError extends Error {
  constructor(code) {
    super(code);
    this.name = "LanCertificateError";
    this.code = code;
  }
}

function fail(code) {
  throw new LanCertificateError(code);
}

function parseDate(value) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail("LAN_CERTIFICATE_INVALID");
  return parsed;
}

function parseNow(now) {
  const value = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(value)) fail("LAN_CERTIFICATE_CLOCK_INVALID");
  return value;
}

function inspectSelfSignature(certificate) {
  try {
    return certificate.checkIssued(certificate) && certificate.verify(certificate.publicKey);
  } catch {
    return false;
  }
}

const defaultDependencies = () =>
  Object.freeze({
    createCertificate: (bytes) => new X509Certificate(bytes),
    createKey: (bytes) => createPrivateKey(bytes),
    now: () => new Date(),
  });

export function inspectLanCertificate(config, dependencies = defaultDependencies()) {
  if (
    config === null ||
    typeof config !== "object" ||
    !Buffer.isBuffer(config.cert) ||
    !Buffer.isBuffer(config.key) ||
    typeof config.bindHost !== "string"
  ) {
    fail("LAN_CERTIFICATE_CONFIG_INVALID");
  }

  let certificate;
  let privateKey;
  try {
    certificate = dependencies.createCertificate(config.cert);
  } catch {
    fail("LAN_CERTIFICATE_INVALID");
  }
  try {
    privateKey = dependencies.createKey(config.key);
  } catch {
    fail("LAN_PRIVATE_KEY_INVALID");
  }

  const validFromMs = parseDate(certificate.validFrom);
  const validToMs = parseDate(certificate.validTo);
  const nowMs = parseNow(dependencies.now());
  let ipSanMatches = false;
  let keyMatches = false;
  try {
    ipSanMatches = certificate.checkIP(config.bindHost, { subject: "never" }) !== undefined;
    keyMatches = certificate.checkPrivateKey(privateKey);
  } catch {
    fail("LAN_CERTIFICATE_INVALID");
  }

  if (typeof certificate.fingerprint256 !== "string" || certificate.fingerprint256.length === 0) {
    fail("LAN_CERTIFICATE_INVALID");
  }
  return Object.freeze({
    fingerprintSha256: certificate.fingerprint256,
    validFrom: new Date(validFromMs).toISOString(),
    validTo: new Date(validToMs).toISOString(),
    validNow: nowMs >= validFromMs && nowMs <= validToMs,
    ipSanMatches,
    keyMatches,
    selfSigned: inspectSelfSignature(certificate),
  });
}

export function assertLanCertificateReady(summary) {
  if (!summary.validNow) fail("LAN_CERTIFICATE_NOT_CURRENT");
  if (!summary.ipSanMatches) fail("LAN_CERTIFICATE_IP_SAN_MISMATCH");
  if (!summary.keyMatches) fail("LAN_CERTIFICATE_KEY_MISMATCH");
}
