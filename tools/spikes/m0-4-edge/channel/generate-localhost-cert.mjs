#!/usr/bin/env node
/**
 * Generate a dev certificate for wss://127.0.0.1 (and localhost).
 * Uses OpenSSL if available; otherwise writes a Node selfsigned-like RSA cert via crypto.
 *
 * WARNING: spike only — production must use a controlled install-time trust story
 * (local CA installed by Edge installer, or alternative channel design).
 */
import { generateKeyPairSync, createHash } from "node:crypto";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const dir = dirname(fileURLToPath(import.meta.url));
const outDir = join(dir, "certs");

function tryOpenSsl() {
  const conf = join(outDir, "localhost.cnf");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    conf,
    `[req]
distinguished_name = req_distinguished_name
x509_extensions = v3_req
prompt = no
[req_distinguished_name]
CN = localhost
O = laundry-desk-m0-4-spike
[v3_req]
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names
[alt_names]
DNS.1 = localhost
IP.1 = 127.0.0.1
IP.2 = ::1
`,
  );
  const key = join(outDir, "localhost-key.pem");
  const cert = join(outDir, "localhost-cert.pem");
  const r = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-nodes",
      "-newkey",
      "rsa:2048",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "825",
      "-config",
      conf,
      "-extensions",
      "v3_req",
    ],
    { encoding: "utf8" },
  );
  if (r.status !== 0) {
    return null;
  }
  return { key, cert, method: "openssl" };
}

/** Fallback PEM without proper SAN — browsers will still warn; field uses openssl path. */
function fallbackPem() {
  mkdirSync(outDir, { recursive: true });
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const key = join(outDir, "localhost-key.pem");
  const cert = join(outDir, "localhost-cert.pem");
  // Minimal self-signed-ish placeholder: store key + note that openssl is required for real SAN.
  writeFileSync(key, privateKey);
  writeFileSync(
    cert,
    `# SPIKE PLACEHOLDER — not a valid X.509 for browsers\n# Install openssl and re-run npm run cert\n${publicKey}`,
  );
  writeFileSync(
    join(outDir, "README.txt"),
    "OpenSSL unavailable. Install openssl and re-run: node channel/generate-localhost-cert.mjs\n",
  );
  return { key, cert, method: "placeholder", publicKey };
}

function fingerprint(pemPath) {
  if (!existsSync(pemPath)) return null;
  const body = readCertBody(pemPath);
  if (!body) return null;
  return createHash("sha256").update(body).digest("hex");
}

function readCertBody(pemPath) {
  const raw = spawnSync("openssl", ["x509", "-in", pemPath, "-outform", "DER"], {
    encoding: "buffer",
  });
  if (raw.status !== 0) return null;
  return raw.stdout;
}

function main() {
  let result = tryOpenSsl();
  if (!result) {
    console.warn("openssl failed or missing; writing placeholder keys");
    result = fallbackPem();
  }
  const fp = fingerprint(result.cert);
  const meta = {
    method: result.method,
    key: result.key,
    cert: result.cert,
    sha256: fp,
    hosts: ["127.0.0.1", "localhost", "::1"],
    generatedAt: new Date().toISOString(),
  };
  writeFileSync(join(outDir, "meta.json"), JSON.stringify(meta, null, 2));
  console.log(JSON.stringify(meta, null, 2));
  if (result.method === "placeholder") {
    process.exitCode = 2;
  }
}

main();
