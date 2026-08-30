import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  configureDesktopSession,
  DESKTOP_SESSION_PARTITION,
  type DesktopSessionSurface,
} from "./electron-session.js";

const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), "../..", "src");

test("desktop transport uses one fixed persistent Electron partition", () => {
  assert.equal(DESKTOP_SESSION_PARTITION, "persist:laundry-v2-local");
});

test("main registers the privileged scheme before ready and binds the window to one session", () => {
  const main = readFileSync(join(sourceRoot, "main.ts"), "utf8");
  const windowSource = readFileSync(join(sourceRoot, "window.ts"), "utf8");
  const schemeRegistration = main.indexOf("registerAppProtocolScheme(protocol)");
  const ready = main.indexOf(".whenReady()");
  const deviceIdentity = main.indexOf("await loadOrCreateDeviceId");
  const desktopAdapter = main.indexOf("createElectronDesktopDependencies({", deviceIdentity);

  assert.ok(schemeRegistration >= 0);
  assert.ok(ready > schemeRegistration);
  assert.ok(deviceIdentity >= 0);
  assert.ok(desktopAdapter > deviceIdentity);
  assert.match(main, /session\.fromPartition\(DESKTOP_SESSION_PARTITION\)/u);
  assert.match(main, /configureDesktopSession/u);
  assert.match(main, /userDataPath:\s*app\.getPath\("userData"\)/u);
  assert.match(main, /deviceId,/u);
  assert.doesNotMatch(main, /session\.defaultSession/u);
  assert.match(windowSource, /session:\s*desktopSession/u);
});

test("desktop session owns app protocol and denies every permission path", async () => {
  const calls: string[] = [];
  let permissionCheck: (() => boolean) | undefined;
  let permissionRequest: ((callback: (allowed: boolean) => void) => void) | undefined;
  const handler = (): Response => new Response("ok");
  const desktopSession: DesktopSessionSurface = {
    protocol: {
      async handle(scheme, registeredHandler) {
        calls.push(`protocol:${scheme}`);
        assert.equal(registeredHandler, handler);
      },
    },
    setPermissionCheckHandler(check) {
      calls.push("permission-check");
      if (check === null) throw new Error("permission check handler must be installed");
      const installedCheck = check;
      permissionCheck = () => installedCheck(null, "notifications", "app://local", {});
    },
    setPermissionRequestHandler(request) {
      calls.push("permission-request");
      if (request === null) throw new Error("permission request handler must be installed");
      const installedRequest = request;
      permissionRequest = (callback) => installedRequest(null, "notifications", callback, {});
    },
  };

  await configureDesktopSession(desktopSession, "app", handler);

  assert.deepEqual(calls, ["permission-check", "permission-request", "protocol:app"]);
  assert.equal(permissionCheck?.(), false);
  let allowed: boolean | undefined;
  permissionRequest?.((next) => {
    allowed = next;
  });
  assert.equal(allowed, false);
});

test("desktop session setup propagates protocol registration failures", async () => {
  const desktopSession: DesktopSessionSurface = {
    protocol: {
      async handle() {
        throw new Error("protocol registration failed");
      },
    },
    setPermissionCheckHandler() {},
    setPermissionRequestHandler() {},
  };

  await assert.rejects(
    () =>
      configureDesktopSession(desktopSession, "app", () => {
        throw new Error("unused");
      }),
    /protocol registration failed/u,
  );
});
