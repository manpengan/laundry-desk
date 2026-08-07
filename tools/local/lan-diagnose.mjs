import { request as requestHttps } from "node:https";
import { connect as connectTcp } from "node:net";
import { pathToFileURL } from "node:url";

import { inspectLanCertificate } from "./lan-certificate.mjs";
import { LanGatewayConfigError, loadLanGatewayConfig } from "./lan-gateway-config.mjs";
import { probeHealthEndpoint } from "./health-probe.mjs";

const HTTPS_TIMEOUT_MS = 2_000;
const TCP_TIMEOUT_MS = 1_500;
const MAXIMUM_HEALTH_BYTES = 8 * 1024;
const POSTGRES_PORT = 8543;

export class LanDiagnoseError extends Error {
  constructor(code) {
    super(code);
    this.name = "LanDiagnoseError";
    this.code = code;
  }
}

export function parseLanDiagnoseArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 0) {
    throw new LanDiagnoseError("LAN_DIAGNOSE_ARGS_INVALID");
  }
}

function isReadyHealthEnvelope(body) {
  return (
    body !== null &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    body.ok === true &&
    body.data?.status === "ready" &&
    Object.keys(body).length === 2
  );
}

async function readBoundedBody(stream) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > MAXIMUM_HEALTH_BYTES) throw new Error("LAN_DIAGNOSE_BODY_TOO_LARGE");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total);
}

const HTTPS_DOWN = Object.freeze({ reachable: false, statusOk: false, healthReady: false });

export function probeLanHttpsEndpoint(url, ca, kind, httpsRequestImplementation = requestHttps) {
  return new Promise((resolve) => {
    let settled = false;
    let client;
    let deadline;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(Object.freeze(result));
    };
    try {
      client = httpsRequestImplementation(
        url,
        {
          method: kind === "owner" ? "HEAD" : "GET",
          ca,
          rejectUnauthorized: true,
          timeout: HTTPS_TIMEOUT_MS,
          headers: Object.freeze({ accept: "application/json" }),
        },
        async (response) => {
          const statusOk = response.statusCode === 200;
          if (kind === "owner") {
            response.once("error", () => finish(HTTPS_DOWN));
            response.resume();
            finish({ reachable: true, statusOk, healthReady: false });
            return;
          }
          try {
            const body = await readBoundedBody(response);
            const parsed = JSON.parse(body.toString("utf8"));
            finish({
              reachable: true,
              statusOk,
              healthReady: statusOk && isReadyHealthEnvelope(parsed),
            });
          } catch {
            finish({ reachable: true, statusOk, healthReady: false });
          }
        },
      );
      if (!settled) deadline = setTimeout(() => client.destroy(), HTTPS_TIMEOUT_MS);
      client.once("timeout", () => client.destroy());
      client.once("error", () => finish(HTTPS_DOWN));
      client.end();
    } catch {
      client?.destroy();
      finish(HTTPS_DOWN);
    }
  });
}

export function probeTcpEndpoint(host, port, connectImplementation = connectTcp) {
  return new Promise((resolve) => {
    let settled = false;
    let socket;
    const finish = (connectable) => {
      if (settled) return;
      settled = true;
      socket?.destroy();
      resolve(Object.freeze({ measured: true, connectable }));
    };
    try {
      socket = connectImplementation({ host, port });
      socket.setTimeout(TCP_TIMEOUT_MS);
      socket.once("connect", () => finish(true));
      socket.once("timeout", () => finish(false));
      socket.once("error", () => finish(false));
    } catch {
      finish(false);
    }
  });
}

function skipped(reason) {
  return Object.freeze({ status: "skipped", reason });
}

function writeReport(options, report) {
  options.stdout(`${JSON.stringify(report, null, 2)}\n`);
  return report;
}

function configFailureCode(error) {
  return error instanceof LanGatewayConfigError ? error.code : "LAN_CONFIG_INVALID";
}

function certificateCheck(summary) {
  const ok = summary.validNow && summary.ipSanMatches && summary.keyMatches;
  return Object.freeze({
    status: ok ? "pass" : "fail",
    fingerprint_sha256: summary.fingerprintSha256,
    valid_from: summary.validFrom,
    valid_until: summary.validTo,
    valid_now: summary.validNow,
    ip_san_matches: summary.ipSanMatches,
    key_matches: summary.keyMatches,
    self_signed: summary.selfSigned,
  });
}

async function safeProbe(callback, fallback) {
  try {
    return await callback();
  } catch {
    return fallback;
  }
}

const defaultDependencies = () =>
  Object.freeze({
    loadConfig: loadLanGatewayConfig,
    inspectCertificate: inspectLanCertificate,
    probeBackend: (url) => probeHealthEndpoint(url),
    probeHttps: (url, ca, kind) => probeLanHttpsEndpoint(url, ca, kind),
    probeTcp: (host, port) => probeTcpEndpoint(host, port),
  });

export async function runLanDiagnose(options, dependencies = defaultDependencies()) {
  parseLanDiagnoseArguments(options.argv);
  let config;
  try {
    config = await dependencies.loadConfig(options.env);
  } catch (error) {
    return writeReport(
      options,
      Object.freeze({
        schema_version: 1,
        ok: false,
        configuration: Object.freeze({ status: "fail", error_code: configFailureCode(error) }),
        certificate: skipped("CONFIGURATION_INVALID"),
        backend: skipped("CONFIGURATION_INVALID"),
        https: skipped("CONFIGURATION_INVALID"),
        isolation: skipped("CONFIGURATION_INVALID"),
      }),
    );
  }

  let certificateSummary = null;
  try {
    certificateSummary = dependencies.inspectCertificate(config);
  } catch {
    certificateSummary = null;
  }
  const certificate =
    certificateSummary === null
      ? Object.freeze({ status: "fail", error_code: "LAN_CERTIFICATE_INVALID" })
      : certificateCheck(certificateSummary);
  const certificateReady = certificate.status === "pass";

  const unavailableBackend = Object.freeze({ reachable: false, ready: false });
  const unavailableTcp = Object.freeze({ measured: false, connectable: null });
  const backendHealthUrl = `http://${config.backendHost}:${config.backendPort}/health`;
  const [backendProbe, fastifyLan, postgresLan] = await Promise.all([
    safeProbe(() => dependencies.probeBackend(backendHealthUrl), unavailableBackend),
    safeProbe(() => dependencies.probeTcp(config.bindHost, config.backendPort), unavailableTcp),
    safeProbe(() => dependencies.probeTcp(config.bindHost, POSTGRES_PORT), unavailableTcp),
  ]);

  let ownerHttps = HTTPS_DOWN;
  let healthHttps = HTTPS_DOWN;
  if (certificateReady) {
    [ownerHttps, healthHttps] = await Promise.all([
      safeProbe(
        () => dependencies.probeHttps(`${config.origin}/owner`, config.cert, "owner"),
        HTTPS_DOWN,
      ),
      safeProbe(
        () => dependencies.probeHttps(`${config.origin}/health`, config.cert, "health"),
        HTTPS_DOWN,
      ),
    ]);
  }

  const backend = Object.freeze({
    status: backendProbe.ready ? "pass" : "fail",
    reachable: backendProbe.reachable,
    ready: backendProbe.ready,
  });
  const https = certificateReady
    ? Object.freeze({
        status: ownerHttps.statusOk && healthHttps.healthReady ? "pass" : "fail",
        owner_reachable: ownerHttps.reachable,
        owner_route_ok: ownerHttps.statusOk,
        health_reachable: healthHttps.reachable,
        health_ready: healthHttps.healthReady,
      })
    : skipped("CERTIFICATE_NOT_READY");
  const isolationOk =
    fastifyLan.measured &&
    postgresLan.measured &&
    fastifyLan.connectable === false &&
    postgresLan.connectable === false;
  const isolation = Object.freeze({
    status: isolationOk ? "pass" : "fail",
    fastify_lan_connectable: fastifyLan.connectable,
    postgres_lan_connectable: postgresLan.connectable,
  });
  const configuration = Object.freeze({
    status: "pass",
    origin: config.origin,
    owner_url: `${config.origin}/owner`,
  });
  const ok =
    certificate.status === "pass" &&
    backend.status === "pass" &&
    https.status === "pass" &&
    isolation.status === "pass";
  return writeReport(
    options,
    Object.freeze({
      schema_version: 1,
      ok,
      configuration,
      certificate,
      backend,
      https,
      isolation,
    }),
  );
}

const isMainModule = () => {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href;
};

function safeErrorCode(error) {
  return error instanceof LanDiagnoseError ? error.code : "LAN_DIAGNOSE_FAILED";
}

if (isMainModule()) {
  void runLanDiagnose({
    argv: Object.freeze(process.argv.slice(2)),
    env: process.env,
    stdout: (text) => process.stdout.write(text),
  })
    .then((report) => {
      if (!report.ok) process.exitCode = 1;
    })
    .catch((error) => {
      process.stderr.write(`${safeErrorCode(error)}\n`);
      process.exitCode = 1;
    });
}
