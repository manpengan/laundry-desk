import { request as httpsRequest } from "node:https";
import { resolve } from "node:path";
import { checkServerIdentity } from "node:tls";
import { fileURLToPath } from "node:url";

import { loadRuntimeLanHealthcheckConfig } from "./lan-gateway-config.mjs";

const MAXIMUM_RESPONSE_BYTES = 8 * 1024;
const REQUEST_TIMEOUT_MS = 2_000;

export const RUNTIME_LAN_HEALTHCHECK_PATHS = Object.freeze({
  configPath: "/run/secrets/lan-config",
  certPath: "/run/secrets/lan-cert",
});

export function runtimeLanHealthRequestOptions(config) {
  return Object.freeze({
    host: "127.0.0.1",
    port: config.port,
    path: "/health",
    method: "GET",
    agent: false,
    ca: config.cert,
    rejectUnauthorized: true,
    servername: config.bindHost,
    checkServerIdentity: (_hostname, certificate) =>
      checkServerIdentity(config.bindHost, certificate),
    headers: Object.freeze({ host: config.authority }),
  });
}

export function requestRuntimeLanHealth(config, createRequest = httpsRequest) {
  return new Promise((resolveHealth, rejectHealth) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (error === undefined) resolveHealth();
      else rejectHealth(new Error("RUNTIME_LAN_HEALTHCHECK_FAILED"));
    };
    const request = createRequest(runtimeLanHealthRequestOptions(config), (response) => {
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.byteLength;
        if (bytes > MAXIMUM_RESPONSE_BYTES) {
          response.destroy();
          finish(new Error("RUNTIME_LAN_HEALTHCHECK_RESPONSE_TOO_LARGE"));
        }
      });
      response.once("aborted", () => finish(new Error("RUNTIME_LAN_HEALTHCHECK_ABORTED")));
      response.once("error", (error) => finish(error));
      response.once("end", () => {
        if (response.statusCode === 200) finish();
        else finish(new Error("RUNTIME_LAN_HEALTHCHECK_STATUS_INVALID"));
      });
    });
    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error("RUNTIME_LAN_HEALTHCHECK_TIMEOUT"));
    });
    request.once("error", (error) => finish(error));
    request.end();
  });
}

export async function probeRuntimeLanGateway(dependencies = {}) {
  const loadConfig = dependencies.loadConfig ?? loadRuntimeLanHealthcheckConfig;
  const requestHealth = dependencies.requestHealth ?? requestRuntimeLanHealth;
  const config = await loadConfig(RUNTIME_LAN_HEALTHCHECK_PATHS);
  await requestHealth(config);
}

export async function runRuntimeLanHealthcheck() {
  try {
    await probeRuntimeLanGateway();
  } catch {
    process.stderr.write("RUNTIME_LAN_HEALTHCHECK_FAILED\n");
    process.exitCode = 1;
  }
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await runRuntimeLanHealthcheck();
