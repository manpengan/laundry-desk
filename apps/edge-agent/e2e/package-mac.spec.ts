import { createServer, type Server } from "node:http";
import { access, lstat, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const PACKAGE_ROOT = join(REPOSITORY_ROOT, "apps", "edge-agent");
const RELEASE_ROOT = join(PACKAGE_ROOT, "release");
const PASSTHROUGH_ENV_KEYS = Object.freeze([
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
]);

function credentialFreeEnvironment(): Readonly<Record<string, string>> {
  return Object.freeze(
    Object.fromEntries(
      PASSTHROUGH_ENV_KEYS.flatMap((name) => {
        const value = process.env[name];
        return typeof value === "string" ? [[name, value] as const] : [];
      }),
    ),
  );
}

async function findPackagedApp(): Promise<string> {
  const candidates: string[] = [];
  for (const entry of await readdir(RELEASE_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^(?:mac|mac-[A-Za-z0-9._-]+)$/u.test(entry.name)) continue;
    const candidate = join(RELEASE_ROOT, entry.name, "laundry-desk V2.app");
    try {
      const metadata = await lstat(candidate);
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) candidates.push(candidate);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  if (candidates.length !== 1)
    throw new Error("exactly one packaged macOS application is required");
  const canonical = await realpath(candidates[0] as string);
  const child = relative(RELEASE_ROOT, canonical);
  if (child === ".." || child.startsWith("../") || isAbsolute(child)) {
    throw new Error("packaged macOS application escapes its release root");
  }
  return canonical;
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

test("packaged Counter launches with the fixed secure shell and no service credentials", async () => {
  expect(process.platform).toBe("darwin");
  const appPath = await findPackagedApp();
  const executablePath = join(appPath, "Contents", "MacOS", "laundry-desk V2");
  await access(executablePath);
  const temporaryBase = await realpath(tmpdir());
  const userDataPath = await mkdtemp(join(temporaryBase, "laundry-package-smoke-"));
  const requests: string[] = [];
  let service: Server | null = null;
  let application: ElectronApplication | null = null;

  try {
    service = await unavailableLoopbackService(requests);
    application = await electron.launch({
      executablePath,
      args: [`--user-data-dir=${userDataPath}`, "--use-mock-keychain"],
      env: credentialFreeEnvironment(),
    });
    const page = await application.firstWindow();
    await expect(page.getByRole("heading", { name: "本地服务尚未就绪" })).toBeVisible({
      timeout: 15_000,
    });
    expect(page.url()).toBe("app://local/index.html");

    const shell = await application.evaluate(({ BrowserWindow, session }) => {
      const windows = BrowserWindow.getAllWindows();
      const window = windows[0];
      if (window === undefined) throw new Error("packaged main window is unavailable");
      return {
        dedicatedSession:
          window.webContents.session === session.fromPartition("persist:laundry-v2-local"),
        windowCount: windows.length,
      };
    });
    expect(shell).toEqual({
      dedicatedSession: true,
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
  } finally {
    await application?.close();
    await closeServer(service);
    await rm(userDataPath, { force: true, recursive: true });
  }
});
