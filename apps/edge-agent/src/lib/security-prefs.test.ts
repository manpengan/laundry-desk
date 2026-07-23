import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { IPC_CHANNELS, SECURITY_WEB_PREFERENCES } from "./security-prefs.js";

// Compiled tests live in dist/lib/; package sources stay under src/.
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const srcRoot = join(packageRoot, "src");

test("SECURITY_WEB_PREFERENCES hard baseline values", () => {
  assert.equal(SECURITY_WEB_PREFERENCES.nodeIntegration, false);
  assert.equal(SECURITY_WEB_PREFERENCES.contextIsolation, true);
  assert.equal(SECURITY_WEB_PREFERENCES.sandbox, true);
  assert.equal(SECURITY_WEB_PREFERENCES.webSecurity, true);
  assert.equal(SECURITY_WEB_PREFERENCES.allowRunningInsecureContent, false);
});

test("main/window/preload sources wire baseline and guards", () => {
  const main = readFileSync(join(srcRoot, "main.ts"), "utf8");
  const windowSrc = readFileSync(join(srcRoot, "window.ts"), "utf8");
  const preload = readFileSync(join(srcRoot, "preload.ts"), "utf8");
  const ipc = readFileSync(join(srcRoot, "ipc.ts"), "utf8");

  assert.match(windowSrc, /SECURITY_WEB_PREFERENCES/);
  assert.match(windowSrc, /setWindowOpenHandler/);
  assert.match(windowSrc, /will-navigate/);
  assert.match(main, /setPermissionRequestHandler/);
  assert.match(main, /registerSchemesAsPrivileged/);
  assert.match(main, /verifySpaIntegrity/);
  assert.match(preload, /contextBridge\.exposeInMainWorld/);
  assert.match(preload, /edgeBridge/);
  assert.doesNotMatch(preload, /require\(/);
  assert.match(ipc, /isValidAppSender/);
  assert.match(ipc, /IPC_CHANNELS\.ping/);
  assert.match(ipc, /IPC_CHANNELS\.health/);
  assert.match(ipc, /IPC_CHANNELS\.upgradeStatus/);
  assert.match(ipc, /IPC_CHANNELS\.pairingCreateCode/);
  assert.match(ipc, /IPC_CHANNELS\.pairingStatus/);
  assert.match(ipc, /isValidAppSender/);
  assert.match(preload, /pairingCreateCode/);
  assert.match(preload, /pairingStatus/);
  assert.doesNotMatch(preload, /privateKey/i);
  assert.doesNotMatch(ipc, /privateKey/i);
  assert.match(main, /claimPrimaryInstance|requestSingleInstanceLock/);
  assert.match(main, /createAppTray/);
  assert.equal(IPC_CHANNELS.ping, "edge:ping");
  assert.equal(IPC_CHANNELS.health, "edge:health");
  assert.equal(IPC_CHANNELS.pairingCreateCode, "pairing:createCode");
  assert.equal(IPC_CHANNELS.pairingStatus, "pairing:status");
  assert.equal(IPC_CHANNELS.queueStatus, "edge:queue-status");
  assert.equal(IPC_CHANNELS.printEnqueue, "edge:print-enqueue");
  assert.equal(IPC_CHANNELS.printProcess, "edge:print-process");
  assert.equal(IPC_CHANNELS.printList, "edge:print-list");
  assert.match(preload, /printProcess/);
  assert.match(ipc, /IPC_CHANNELS\.printProcess/);
  assert.match(ipc, /IPC_CHANNELS\.printEnqueue/);
  // Process path returns receipt fields only — never payload bytes to renderer.
  assert.doesNotMatch(ipc, /bytes:\s*result\.bytes|rawBytes|payload\.byteLength/);
});
