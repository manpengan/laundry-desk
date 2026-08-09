import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import test from "node:test";

import {
  probeRuntimeLanGateway,
  requestRuntimeLanHealth,
  RUNTIME_LAN_HEALTHCHECK_PATHS,
  runtimeLanHealthRequestOptions,
} from "./lan-runtime-healthcheck.mjs";

const CONFIG = Object.freeze({
  authority: "192.168.50.12:18443",
  bindHost: "192.168.50.12",
  port: 18443,
  cert: Buffer.from("trusted certificate"),
});

function fakeRequestFor(response, captured) {
  return (options, onResponse) => {
    captured.options = options;
    const request = new EventEmitter();
    request.setTimeout = (timeout, handler) => {
      captured.timeout = timeout;
      captured.onTimeout = handler;
    };
    request.destroy = (error) => request.emit("error", error);
    request.end = () => queueMicrotask(() => onResponse(response));
    return request;
  };
}

function response(statusCode, chunks = [Buffer.from("ok")]) {
  return Object.assign(Readable.from(chunks), { statusCode });
}

test("health probe connects locally while authenticating the configured LAN identity", async () => {
  const options = runtimeLanHealthRequestOptions(CONFIG);

  assert.equal(options.host, "127.0.0.1");
  assert.equal(options.port, 18443);
  assert.equal(options.path, "/health");
  assert.equal(options.method, "GET");
  assert.equal(options.servername, "192.168.50.12");
  assert.equal(options.headers.host, "192.168.50.12:18443");
  assert.equal(options.ca, CONFIG.cert);
  assert.equal(options.rejectUnauthorized, true);
  assert.equal(options.agent, false);
  assert.equal(typeof options.checkServerIdentity, "function");
});

test("health request requires status 200 and bounds both time and response bytes", async () => {
  const captured = {};
  await requestRuntimeLanHealth(CONFIG, fakeRequestFor(response(200), captured));
  assert.equal(captured.timeout, 2_000);
  assert.equal(captured.options.rejectUnauthorized, true);

  await assert.rejects(
    () => requestRuntimeLanHealth(CONFIG, fakeRequestFor(response(503), {})),
    /RUNTIME_LAN_HEALTHCHECK_FAILED/u,
  );
  await assert.rejects(
    () =>
      requestRuntimeLanHealth(
        CONFIG,
        fakeRequestFor(response(200, [Buffer.alloc(8 * 1024 + 1)]), {}),
      ),
    /RUNTIME_LAN_HEALTHCHECK_FAILED/u,
  );
});

test("health probe loads only the fixed config and certificate paths", async () => {
  const events = [];
  await probeRuntimeLanGateway({
    loadConfig: async (paths) => {
      events.push(["load", paths]);
      return CONFIG;
    },
    requestHealth: async (config) => events.push(["request", config]),
  });

  assert.deepEqual(RUNTIME_LAN_HEALTHCHECK_PATHS, {
    configPath: "/run/secrets/lan-config",
    certPath: "/run/secrets/lan-cert",
  });
  assert.deepEqual(events, [
    ["load", RUNTIME_LAN_HEALTHCHECK_PATHS],
    ["request", CONFIG],
  ]);
});
