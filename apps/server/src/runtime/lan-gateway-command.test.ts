import assert from "node:assert/strict";
import test from "node:test";

import { EMBEDDED_LAN_GATEWAY_URL, runEmbeddedLanGateway } from "./lan-gateway-command.js";

test("loads only the immutable LAN gateway entrypoint embedded in the Server OCI", async () => {
  const loaded: string[] = [];
  let invocations = 0;

  await runEmbeddedLanGateway({
    loadModule: async (specifier) => {
      loaded.push(specifier);
      return Object.freeze({
        runRuntimeLanGateway: async () => {
          invocations += 1;
        },
      });
    },
  });

  assert.deepEqual(loaded, [EMBEDDED_LAN_GATEWAY_URL]);
  assert.equal(
    EMBEDDED_LAN_GATEWAY_URL,
    "file:///opt/laundry/lan-gateway/lan-runtime-entrypoint.mjs",
  );
  assert.equal(invocations, 1);
});

test("rejects an embedded module without the one fixed entrypoint", async () => {
  await assert.rejects(
    () => runEmbeddedLanGateway({ loadModule: async () => Object.freeze({}) }),
    /RUNTIME_LAN_GATEWAY_MODULE_INVALID/u,
  );
});
