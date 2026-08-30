import { createServer, type Server } from "node:http";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";

const PACKAGE_ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const RELEASE_ROOT = join(PACKAGE_ROOT, "release");
const DEFAULT_APP_ROOT = join(RELEASE_ROOT, "win-unpacked");
const EXECUTABLE_NAME = "laundry-desk V2.exe";
const SCREENSHOT_PATH = join(PACKAGE_ROOT, "test-results", "windows-package", "desktop-smoke.png");
const PASSTHROUGH_ENV_KEYS = Object.freeze([
  "PATH",
  "SystemRoot",
  "WINDIR",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
]);

function credentialFreeEnvironment(): Readonly<Record<string, string>> {
  const environment = Object.fromEntries(
    PASSTHROUGH_ENV_KEYS.flatMap((name) => {
      const value = process.env[name];
      return typeof value === "string" ? [[name, value] as const] : [];
    }),
  );
  const printerQueue = process.env.LAUNDRY_WINDOWS_TEST_QUEUE?.trim();
  if (
    printerQueue !== undefined &&
    printerQueue.length > 0 &&
    printerQueue.length <= 256 &&
    !printerQueue.includes("/") &&
    !/[\u0000-\u001f\u007f]/u.test(printerQueue)
  ) {
    return Object.freeze({ ...environment, LAUNDRY_PRINTER_QUEUE: printerQueue });
  }
  return Object.freeze(environment);
}

async function packagedExecutable(): Promise<Readonly<{ executable: string; root: string }>> {
  const configuredRoot = process.env.LAUNDRY_WINDOWS_APP_ROOT?.trim();
  const root = configuredRoot === undefined ? DEFAULT_APP_ROOT : configuredRoot;
  if (!isAbsolute(root)) throw new Error("Windows package root must be absolute");
  const canonicalRoot = await realpath(root);
  if (canonicalRoot !== root) throw new Error("Windows package root must be canonical");
  const executable = join(canonicalRoot, EXECUTABLE_NAME);
  const metadata = await lstat(executable);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new Error("packaged Windows executable must be one real file");
  }
  const canonicalExecutable = await realpath(executable);
  const child = relative(canonicalRoot, canonicalExecutable);
  if (dirname(canonicalExecutable) !== canonicalRoot || child !== EXECUTABLE_NAME) {
    throw new Error("packaged Windows executable escapes its package root");
  }
  return Object.freeze({ executable: canonicalExecutable, root: canonicalRoot });
}

async function unavailableLoopbackService(requests: string[]): Promise<Server> {
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    response.writeHead(503, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end('{"ok":false}\n');
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen({ host: "127.0.0.1", port: 8787, exclusive: true }, resolveListen);
  });
  return server;
}

async function closeServer(server: Server | null): Promise<void> {
  if (server === null) return;
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
  });
}

test("packaged Windows Counter is a secure Electron desktop with its native helper", async () => {
  expect(process.platform).toBe("win32");
  const packaged = await packagedExecutable();
  const userDataPath = await mkdtemp(join(await realpath(tmpdir()), "laundry-win-smoke-"));
  const requests: string[] = [];
  let service: Server | null = null;
  let application: ElectronApplication | null = null;

  try {
    await mkdir(dirname(SCREENSHOT_PATH), { recursive: true });
    await rm(SCREENSHOT_PATH, { force: true });
    service = await unavailableLoopbackService(requests);
    application = await electron.launch({
      executablePath: packaged.executable,
      args: [`--user-data-dir=${userDataPath}`],
      env: credentialFreeEnvironment(),
    });
    const page = await application.firstWindow();
    await expect(page.getByRole("heading", { name: "本地服务尚未就绪" })).toBeVisible({
      timeout: 20_000,
    });
    expect(page.url()).toBe("app://local/index.html");

    const main = await application.evaluate(({ app, BrowserWindow, safeStorage, session }) => {
      const windows = BrowserWindow.getAllWindows();
      const window = windows[0];
      if (window === undefined) throw new Error("packaged Windows main window is unavailable");
      return {
        dedicatedSession:
          window.webContents.session === session.fromPartition("persist:laundry-v2-local"),
        encryptionAvailable: safeStorage.isEncryptionAvailable(),
        isPackaged: app.isPackaged,
        platform: process.platform,
        resourcesPath: process.resourcesPath,
        windowCount: windows.length,
      };
    });
    expect(main).toEqual({
      dedicatedSession: true,
      encryptionAvailable: true,
      isPackaged: true,
      platform: "win32",
      resourcesPath: join(packaged.root, "resources"),
      windowCount: 1,
    });

    const renderer = await page.evaluate(() => {
      const global = window as Window & {
        electron?: unknown;
        laundryDesktop?: Record<string, unknown>;
        process?: unknown;
        require?: unknown;
      };
      return {
        bridgeKeys: Object.keys(global.laundryDesktop ?? {}).sort(),
        electronType: typeof global.electron,
        processType: typeof global.process,
        requireType: typeof global.require,
      };
    });
    expect(renderer).toEqual({
      bridgeKeys: ["auth", "command", "health", "offline", "photo", "printer", "query"],
      electronType: "undefined",
      processType: "undefined",
      requireType: "undefined",
    });
    expect(requests).toContain("/health");

    const expectedQueue = process.env.LAUNDRY_WINDOWS_TEST_QUEUE?.trim();
    if (expectedQueue !== undefined && expectedQueue.length > 0) {
      const config = JSON.parse(
        await readFile(join(userDataPath, "edge-state", "printing", "printer-config.json"), "utf8"),
      ) as unknown;
      expect(config).toEqual({ version: 1, queue: expectedQueue });
    }
    await page.screenshot({ path: SCREENSHOT_PATH });
  } finally {
    await application?.close();
    await closeServer(service);
    await rm(userDataPath, { force: true, recursive: true });
  }
});
