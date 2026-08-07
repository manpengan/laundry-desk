import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import test from "node:test";

import {
  parseLanDiagnoseArguments,
  probeLanHttpsEndpoint,
  runLanDiagnose,
} from "./lan-diagnose.mjs";

const CONFIG = Object.freeze({
  origin: "https://192.168.50.12:8443",
  bindHost: "192.168.50.12",
  backendHost: "127.0.0.1",
  backendPort: 8787,
  cert: Buffer.from("certificate-secret-marker"),
  key: Buffer.from("private-key-secret-marker"),
});
const CERTIFICATE = Object.freeze({
  fingerprintSha256: "AA:BB:CC",
  validFrom: "2026-08-07T00:00:00.000Z",
  validTo: "2027-08-07T00:00:00.000Z",
  validNow: true,
  ipSanMatches: true,
  keyMatches: true,
  selfSigned: false,
});

function successfulDependencies(overrides = {}) {
  return Object.freeze({
    loadConfig: async () => CONFIG,
    inspectCertificate: () => CERTIFICATE,
    probeBackend: async () => Object.freeze({ reachable: true, ready: true }),
    probeHttps: async (_url, _ca, kind) =>
      Object.freeze({
        reachable: true,
        statusOk: true,
        healthReady: kind === "health",
      }),
    probeTcp: async () => Object.freeze({ measured: true, connectable: false }),
    ...overrides,
  });
}

test("LAN diagnostics report only bounded credential-free summaries", async () => {
  let output = "";
  let backendUrl;
  const tcpTargets = [];
  const report = await runLanDiagnose(
    {
      argv: Object.freeze([]),
      env: Object.freeze({
        LAUNDRY_LOCAL_ADMIN_PASSWORD: "password-secret-marker",
        LAUNDRY_LOCAL_ADMIN_PIN: "pin-secret-marker",
        AUTHORIZATION: "token-secret-marker",
        COOKIE: "cookie-secret-marker",
        LAUNDRY_TLS_KEY_FILE: "/private/path-secret-marker/key.pem",
      }),
      stdout: (text) => {
        output += text;
      },
    },
    successfulDependencies({
      probeBackend: async (url) => {
        backendUrl = url;
        return Object.freeze({ reachable: true, ready: true });
      },
      probeTcp: async (host, port) => {
        tcpTargets.push(Object.freeze({ host, port }));
        return Object.freeze({ measured: true, connectable: false });
      },
    }),
  );

  assert.equal(report.ok, true);
  assert.equal(backendUrl, "http://127.0.0.1:8787/health");
  assert.deepEqual(tcpTargets, [
    { host: "192.168.50.12", port: 8787 },
    { host: "192.168.50.12", port: 8543 },
  ]);
  assert.equal(report.configuration.owner_url, "https://192.168.50.12:8443/owner");
  assert.equal(report.certificate.fingerprint_sha256, "AA:BB:CC");
  assert.equal(report.https.health_ready, true);
  assert.equal(report.isolation.fastify_lan_connectable, false);
  for (const secret of [
    "certificate-secret-marker",
    "private-key-secret-marker",
    "password-secret-marker",
    "pin-secret-marker",
    "token-secret-marker",
    "cookie-secret-marker",
    "path-secret-marker",
  ]) {
    assert.doesNotMatch(output, new RegExp(secret, "u"));
  }
});

test("configuration failures redact exception text and skip every network probe", async () => {
  let probes = 0;
  let output = "";
  const report = await runLanDiagnose(
    {
      argv: Object.freeze([]),
      env: Object.freeze({}),
      stdout: (text) => {
        output += text;
      },
    },
    successfulDependencies({
      loadConfig: async () => {
        throw new Error("password-secret-marker at /private/path-secret-marker");
      },
      probeBackend: async () => {
        probes += 1;
      },
      probeHttps: async () => {
        probes += 1;
      },
      probeTcp: async () => {
        probes += 1;
      },
    }),
  );

  assert.equal(report.ok, false);
  assert.equal(report.configuration.error_code, "LAN_CONFIG_INVALID");
  assert.equal(report.https.status, "skipped");
  assert.equal(probes, 0);
  assert.doesNotMatch(output, /password-secret-marker|path-secret-marker/u);
});

test("certificate readiness failure skips HTTPS instead of weakening verification", async () => {
  let httpsProbes = 0;
  const report = await runLanDiagnose(
    {
      argv: Object.freeze([]),
      env: Object.freeze({}),
      stdout: () => undefined,
    },
    successfulDependencies({
      inspectCertificate: () => Object.freeze({ ...CERTIFICATE, ipSanMatches: false }),
      probeHttps: async () => {
        httpsProbes += 1;
        return Object.freeze({ reachable: true, statusOk: true, healthReady: true });
      },
    }),
  );

  assert.equal(report.ok, false);
  assert.equal(report.certificate.ip_san_matches, false);
  assert.deepEqual(report.https, { status: "skipped", reason: "CERTIFICATE_NOT_READY" });
  assert.equal(httpsProbes, 0);
});

test("trusted HTTPS probe sends no credential, cookie, PIN, or forwarding header", async () => {
  let captured;
  const requestImplementation = (url, options, callback) => {
    captured = Object.freeze({ url, options });
    const request = new EventEmitter();
    request.destroy = () => request.emit("error", new Error("destroyed"));
    request.end = () => {
      const response = Object.assign(Readable.from(['{"ok":true,"data":{"status":"ready"}}']), {
        statusCode: 200,
      });
      queueMicrotask(() => callback(response));
    };
    return request;
  };

  const result = await probeLanHttpsEndpoint(
    "https://192.168.50.12:8443/health",
    CONFIG.cert,
    "health",
    requestImplementation,
  );

  assert.deepEqual(result, { reachable: true, statusOk: true, healthReady: true });
  assert.equal(captured.url, "https://192.168.50.12:8443/health");
  assert.equal(captured.options.rejectUnauthorized, true);
  assert.equal(captured.options.ca, CONFIG.cert);
  assert.deepEqual(captured.options.headers, { accept: "application/json" });
  for (const name of ["authorization", "cookie", "x-csrf-token", "forwarded", "x-forwarded-for"]) {
    assert.equal(captured.options.headers[name], undefined);
  }
});

test("HTTPS transport failures collapse to a stable credential-free result", async () => {
  const requestImplementation = () => {
    const request = new EventEmitter();
    request.destroy = () => request.emit("error", new Error("private response body marker"));
    request.end = () => queueMicrotask(() => request.emit("timeout"));
    return request;
  };

  assert.deepEqual(
    await probeLanHttpsEndpoint(
      "https://192.168.50.12:8443/health",
      CONFIG.cert,
      "health",
      requestImplementation,
    ),
    { reachable: false, statusOk: false, healthReady: false },
  );
});

test("LAN diagnostics accept no command-line inputs", () => {
  assert.doesNotThrow(() => parseLanDiagnoseArguments([]));
  assert.throws(() => parseLanDiagnoseArguments(["--include-logs"]), /LAN_DIAGNOSE_ARGS_INVALID/u);
});
