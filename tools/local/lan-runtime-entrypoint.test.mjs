import assert from "node:assert/strict";
import test from "node:test";

import { RUNTIME_LAN_PATHS, startRuntimeLanGateway } from "./lan-runtime-entrypoint.mjs";

test("runtime gateway uses only fixed files, embedded SPA, and the shared server namespace", async () => {
  const events = [];
  const config = Object.freeze({
    origin: "https://192.168.50.12:8443",
    port: 8443,
    listenHost: "0.0.0.0",
    webRoot: "/opt/laundry/owner-spa",
    ownerSpaSha256: "a".repeat(64),
  });
  const assets = Object.freeze({ paths: Object.freeze(["/index.html"]) });
  const server = Object.freeze({ name: "gateway" });

  const result = await startRuntimeLanGateway({
    loadConfig: async (paths) => {
      events.push(["config", paths]);
      return config;
    },
    loadAssets: async (root, sha256) => {
      events.push(["assets", root, sha256]);
      return assets;
    },
    createGateway: (receivedConfig, receivedAssets) => {
      events.push(["create", receivedConfig, receivedAssets]);
      return server;
    },
    listen: async (receivedServer, options) => {
      events.push(["listen", receivedServer, options.port, options.bindHost]);
    },
  });

  assert.deepEqual(RUNTIME_LAN_PATHS, {
    configPath: "/run/secrets/lan-config",
    certPath: "/run/secrets/lan-cert",
    keyPath: "/run/secrets/lan-key",
    webRoot: "/opt/laundry/owner-spa",
  });
  assert.deepEqual(events, [
    ["config", RUNTIME_LAN_PATHS],
    ["assets", "/opt/laundry/owner-spa", "a".repeat(64)],
    ["create", config, assets],
    ["listen", server, 8443, "0.0.0.0"],
  ]);
  assert.deepEqual(result, { config, server });
});
