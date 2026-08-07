import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { listenLanGateway } from "./lan-gateway-lifecycle.mjs";

class FakeServer extends EventEmitter {
  constructor(event) {
    super();
    this.event = event;
    this.listenArgs = null;
  }

  listen(port, bindHost) {
    this.listenArgs = Object.freeze({ port, bindHost });
    queueMicrotask(() => this.emit(this.event, new Error("startup failed")));
  }
}

test("replaces the startup listener with the runtime error handler before resolving", async () => {
  const server = new FakeServer("listening");
  const runtimeErrors = [];
  await listenLanGateway(server, {
    port: 8443,
    bindHost: "192.168.50.12",
    onRuntimeError: (error) => runtimeErrors.push(error.message),
  });

  assert.deepEqual(server.listenArgs, { port: 8443, bindHost: "192.168.50.12" });
  assert.equal(server.listenerCount("error"), 1);
  server.emit("error", new Error("runtime failed"));
  assert.deepEqual(runtimeErrors, ["runtime failed"]);
});

test("startup failure rejects without leaving a listening handler behind", async () => {
  const server = new FakeServer("error");
  await assert.rejects(
    () =>
      listenLanGateway(server, {
        port: 8443,
        bindHost: "192.168.50.12",
        onRuntimeError: () => assert.fail("runtime handler must not be installed"),
      }),
    /startup failed/u,
  );

  assert.equal(server.listenerCount("error"), 0);
  assert.equal(server.listenerCount("listening"), 0);
});
