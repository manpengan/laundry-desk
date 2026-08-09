import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  closeCounterApplication,
  firstCounterWindow,
  launchCounterApplication,
} from "./runtime-counter-loopback-electron.mjs";

function childProcess() {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = (signal) => {
    queueMicrotask(() => {
      child.signalCode = signal;
      child.emit("exit", null, signal);
    });
    return true;
  };
  return child;
}

test("launches the normal packaged executable without putting secrets in argv", async () => {
  const child = childProcess();
  const page = Object.freeze({ marker: "normal-window" });
  let launchOptions;
  const application = {
    close: async () => {
      child.exitCode = 0;
    },
    firstWindow: async () => page,
    process: () => child,
  };
  const launched = await launchCounterApplication(
    {
      launch: async (options) => {
        launchOptions = options;
        return application;
      },
    },
    {
      environment: { HOME: "/tmp/counter-home" },
      executable: "/tmp/Counter.app/Contents/MacOS/Counter",
      secrets: ["stdin-secret"],
      userDataRoot: "/tmp/counter-user-data",
    },
  );
  assert.equal(launched.application, application);
  assert.deepEqual(launchOptions.args, [
    "--user-data-dir=/tmp/counter-user-data",
    "--use-mock-keychain",
  ]);
  assert.equal(JSON.stringify(launchOptions).includes("stdin-secret"), false);
  assert.equal(await firstCounterWindow(application), page);
  await closeCounterApplication(application);
});

test("forces a bounded process termination when Playwright close fails", async () => {
  const child = childProcess();
  const application = {
    close: async () => {
      throw new Error("close failed");
    },
    process: () => child,
  };
  await closeCounterApplication(application);
  assert.equal(child.signalCode, "SIGTERM");
});
