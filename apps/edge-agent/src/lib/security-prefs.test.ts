import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import * as securityPrefs from "./security-prefs.js";

const { IPC_CHANNELS, SECURITY_WEB_PREFERENCES } = securityPrefs;

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

test("DESKTOP_IPC_CHANNELS is the exact deeply frozen renderer capability map", () => {
  const channels = Reflect.get(securityPrefs, "DESKTOP_IPC_CHANNELS") as unknown;

  assert.deepEqual(channels, {
    auth: {
      login: "desktop:auth:login",
      refresh: "desktop:auth:refresh",
      pinChallenge: "desktop:auth:pin-challenge",
      pinVerify: "desktop:auth:pin-verify",
      logout: "desktop:auth:logout",
    },
    command: { execute: "desktop:command:execute" },
    query: { execute: "desktop:query:execute" },
    photo: {
      upload: "desktop:photo:upload",
      read: "desktop:photo:read",
      delete: "desktop:photo:delete",
    },
    health: { get: "desktop:health:get" },
  });
  assert.equal(typeof channels, "object");
  assert.notEqual(channels, null);
  assert.equal(Object.isFrozen(channels), true);

  for (const namespace of ["auth", "command", "query", "photo", "health"]) {
    assert.equal(Object.isFrozen(Reflect.get(channels, namespace)), true);
  }
});

test("preload exposes only the fixed-channel laundryDesktop bridge", () => {
  const preload = readFileSync(join(srcRoot, "preload.ts"), "utf8");
  const exposedWorldKeys = Array.from(
    preload.matchAll(/contextBridge\.exposeInMainWorld\(\s*"([^"]+)"/gu),
    (match) => match[1],
  );
  const invokedDesktopChannels = Array.from(
    preload.matchAll(
      /ipcRenderer\.invoke\(\s*DESKTOP_IPC_CHANNELS\.(auth\.(?:login|refresh|pinChallenge|pinVerify|logout)|command\.execute|query\.execute|photo\.(?:upload|read|delete)|health\.get)/gu,
    ),
    (match) => match[1],
  );
  const emptyInputChannels = Array.from(
    preload.matchAll(
      /ipcRenderer\.invoke\(\s*DESKTOP_IPC_CHANNELS\.(auth\.(?:refresh|logout)|health\.get),\s*EMPTY_DESKTOP_INPUT\s*\)/gu,
    ),
    (match) => match[1],
  );

  assert.deepEqual(exposedWorldKeys, ["laundryDesktop"]);
  assert.deepEqual(invokedDesktopChannels, [
    "auth.login",
    "auth.refresh",
    "auth.pinChallenge",
    "auth.pinVerify",
    "auth.logout",
    "command.execute",
    "query.execute",
    "photo.upload",
    "photo.read",
    "photo.delete",
    "health.get",
  ]);
  assert.deepEqual(emptyInputChannels, ["auth.refresh", "auth.logout", "health.get"]);
  assert.equal(preload.match(/ipcRenderer\.invoke\(/gu)?.length, 11);
  assert.doesNotMatch(preload, /edgeBridge/);
  assert.doesNotMatch(preload, /import\s*\{\s*IPC_CHANNELS\s*\}/u);
  assert.doesNotMatch(
    preload,
    /\b(?:fetch|url|method|headers?|cookies?|tokens?)\b|require\(|\bBuffer\b|\bprocess\./iu,
  );
});

test("main/window/preload sources wire baseline and guards", () => {
  const main = readFileSync(join(srcRoot, "main.ts"), "utf8");
  const windowSrc = readFileSync(join(srcRoot, "window.ts"), "utf8");
  const preload = readFileSync(join(srcRoot, "preload.ts"), "utf8");
  const ipc = readFileSync(join(srcRoot, "ipc.ts"), "utf8");
  const printerSmokeCli = readFileSync(join(srcRoot, "print/printer-smoke-cli.ts"), "utf8");
  const enqueueStart = ipc.indexOf("ipcMain.handle(IPC_CHANNELS.printEnqueue");
  const processStart = ipc.indexOf("ipcMain.handle(IPC_CHANNELS.printProcess");
  const listStart = ipc.indexOf("ipcMain.handle(IPC_CHANNELS.printList");
  assert.ok(enqueueStart >= 0 && processStart > enqueueStart && listStart > processStart);
  const enqueueHandler = ipc.slice(enqueueStart, processStart);
  const processHandler = ipc.slice(processStart, listStart);

  assert.match(windowSrc, /SECURITY_WEB_PREFERENCES/);
  assert.match(windowSrc, /setWindowOpenHandler/);
  assert.match(windowSrc, /will-navigate/);
  assert.doesNotMatch(windowSrc, /void\s+win\.loadURL/u);
  assert.match(windowSrc, /ready:\s*win\.loadURL\(APP_ENTRY_URL\)/u);
  assert.match(main, /await\s+showMainWindow\(\)/u);
  // Task 9 keeps protocol construction session-agnostic. Task 10 owns the
  // dedicated Electron session and its deny-all permission handler.
  assert.doesNotMatch(main, /session\.defaultSession/);
  assert.match(main, /verifySpaIntegrity/);
  assert.match(preload, /contextBridge\.exposeInMainWorld/);
  assert.match(preload, /laundryDesktop/);
  assert.doesNotMatch(preload, /edgeBridge/);
  assert.doesNotMatch(preload, /require\(/);
  assert.match(ipc, /isValidAppSender/);
  assert.match(ipc, /IPC_CHANNELS\.ping/);
  assert.match(ipc, /IPC_CHANNELS\.health/);
  assert.match(ipc, /IPC_CHANNELS\.upgradeStatus/);
  assert.match(ipc, /IPC_CHANNELS\.pairingCreateCode/);
  assert.match(ipc, /IPC_CHANNELS\.pairingStatus/);
  assert.match(ipc, /isValidAppSender/);
  assert.doesNotMatch(preload, /pairingCreateCode/);
  assert.doesNotMatch(preload, /pairingStatus/);
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
  assert.doesNotMatch(preload, /printProcess/);
  // Printer smoke trigger stays CLI-only; neither renderer nor IPC may invoke it.
  assert.equal("printerSmoke" in IPC_CHANNELS, false);
  assert.doesNotMatch(preload, /printerSmoke/);
  assert.match(ipc, /IPC_CHANNELS\.printProcess/);
  assert.match(ipc, /IPC_CHANNELS\.printEnqueue/);
  assert.doesNotMatch(ipc, /IPC_CHANNELS\.printerSmoke/);
  assert.match(printerSmokeCli, /--validate/);
  assert.match(enqueueHandler, /return printMutationGate/u);
  assert.match(processHandler, /return printMutationGate/u);
  assert.doesNotMatch(main, /NODE_ENV|registerIpcHandlers|createRuntimeState/u);
  assert.doesNotMatch(ipc, /NODE_ENV/u);
  assert.match(ipc, /allowUnsignedRendererPrint/u);
  // Process path returns receipt fields only — never payload bytes to renderer.
  assert.doesNotMatch(ipc, /bytes:\s*result\.bytes|rawBytes|payload\.byteLength/);
});
