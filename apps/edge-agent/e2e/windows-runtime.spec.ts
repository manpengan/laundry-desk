import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { fillWindowsCredential, loadWindowsRuntimeCredentials } from "./windows-credentials.mjs";
import { verifyInstalledFeatureSettings } from "./windows-feature-settings.js";
import { closeWindowAndWaitForApplication } from "./windows-window-close.mjs";

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

function requiredAbsoluteEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || !isAbsolute(value) || value.includes("\0")) {
    throw new Error(`${name} must be one absolute path`);
  }
  return value;
}

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

async function launchInstalled(executable: string, userDataPath: string) {
  return await electron.launch({
    executablePath: executable,
    args: [`--user-data-dir=${userDataPath}`],
    env: credentialFreeEnvironment(),
  });
}

async function closeApplication(application: ElectronApplication | null): Promise<void> {
  await application?.close();
}

async function launchSecondInstance(executable: string, userDataPath: string): Promise<void> {
  const child = spawn(executable, [`--user-data-dir=${userDataPath}`], {
    env: credentialFreeEnvironment(),
    stdio: "ignore",
    windowsHide: true,
  });
  await new Promise<void>((resolve, reject) => {
    let failureCode: string | null = null;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      failureCode = "WINDOWS_SECOND_INSTANCE_EXIT_TIMEOUT";
      cleanupTimer = setTimeout(() => {
        reject(new Error("WINDOWS_SECOND_INSTANCE_CLEANUP_TIMEOUT"));
      }, 5_000);
      child.kill();
    }, 15_000);
    child.once("error", () => {
      clearTimeout(timer);
      failureCode ??= "WINDOWS_SECOND_INSTANCE_LAUNCH_FAILED";
      if (child.pid === undefined) reject(new Error(failureCode));
      else if (cleanupTimer === undefined) {
        cleanupTimer = setTimeout(() => {
          reject(new Error("WINDOWS_SECOND_INSTANCE_CLEANUP_TIMEOUT"));
        }, 5_000);
        child.kill();
      }
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      clearTimeout(cleanupTimer);
      if (failureCode !== null) reject(new Error(failureCode));
      else if (code === 0) resolve();
      else reject(new Error("WINDOWS_SECOND_INSTANCE_EXIT_FAILED"));
    });
  });
}

test("installed Windows Counter signs in and restarts against the native Runtime", async () => {
  expect(process.platform).toBe("win32");
  const executable = await realpath(requiredAbsoluteEnvironment("LAUNDRY_WINDOWS_INSTALLED_EXE"));
  const executableMetadata = await lstat(executable);
  expect(executableMetadata.isFile()).toBe(true);
  expect(executableMetadata.isSymbolicLink()).toBe(false);
  expect(executableMetadata.nlink).toBe(1);
  const credentials = await loadWindowsRuntimeCredentials();
  const screenshot = requiredAbsoluteEnvironment("LAUNDRY_WINDOWS_ACCEPTANCE_SCREENSHOT");
  const userDataPath = await mkdtemp(join(await realpath(tmpdir()), "laundry-win-runtime-"));
  let application: ElectronApplication | null = null;
  let secondaryCleanupConfirmed = true;

  try {
    application = await launchInstalled(executable, userDataPath);
    let page = await application.firstWindow();
    await expect(page.locator('[data-page="login"]')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("heading", { name: "本地服务尚未就绪" })).toHaveCount(0);
    expect(page.url()).toBe("app://local/index.html");

    const main = await application.evaluate(({ app, BrowserWindow, safeStorage, session }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (window === undefined) throw new Error("installed Windows main window is unavailable");
      // Electron exposes this native inspection method without declaring it in its public types.
      const inspect = (
        window.webContents as unknown as {
          getLastWebPreferences?: () => Readonly<Record<string, unknown>>;
        }
      ).getLastWebPreferences;
      if (typeof inspect !== "function")
        throw new Error("WINDOWS_PREFERENCE_INSPECTION_UNAVAILABLE");
      const preferences = inspect.call(window.webContents);
      return {
        dedicatedSession:
          window.webContents.session === session.fromPartition("persist:laundry-v2-local"),
        encryptionAvailable: safeStorage.isEncryptionAvailable(),
        isPackaged: app.isPackaged,
        platform: process.platform,
        preferences: Object.fromEntries(
          [
            "nodeIntegration",
            "contextIsolation",
            "sandbox",
            "webSecurity",
            "allowRunningInsecureContent",
          ].map((key) => [key, preferences[key]]),
        ),
      };
    });
    expect(main).toEqual({
      dedicatedSession: true,
      encryptionAvailable: true,
      isPackaged: true,
      platform: "win32",
      preferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
      },
    });

    const renderer = await page.evaluate(() => {
      const global = window as Window & {
        electron?: unknown;
        process?: unknown;
        require?: unknown;
      };
      return {
        electronType: typeof global.electron,
        processType: typeof global.process,
        requireType: typeof global.require,
      };
    });
    expect(renderer).toEqual({
      electronType: "undefined",
      processType: "undefined",
      requireType: "undefined",
    });

    const health = await page.evaluate(async () => {
      const bridge = (
        window as Window & {
          laundryDesktop?: { health?: { get?: () => Promise<unknown> } };
        }
      ).laundryDesktop;
      return await bridge?.health?.get?.();
    });
    expect(health).toEqual({ ok: true, data: { status: "ready" } });

    await page.locator('input[name="org_code"]').fill("local");
    await page.locator('input[name="store_code"]').fill("main");
    await fillWindowsCredential(page.locator('input[name="username"]'), credentials.adminUsername);
    await fillWindowsCredential(page.locator('input[name="password"]'), credentials.adminPassword);
    await page.getByRole("button", { name: "登录" }).click();
    await expect(page.locator('[data-shell="counter"]')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(credentials.adminDisplayName, { exact: true })).toBeVisible();
    await page.screenshot({ path: screenshot });
    await verifyInstalledFeatureSettings(page);

    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.minimize());
    await expect
      .poll(
        async () =>
          await application!.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0]?.isMinimized(),
          ),
      )
      .toBe(true);
    try {
      await launchSecondInstance(executable, userDataPath);
    } catch (error) {
      if (error instanceof Error && error.message === "WINDOWS_SECOND_INSTANCE_CLEANUP_TIMEOUT") {
        secondaryCleanupConfirmed = false;
      }
      throw error;
    }
    await expect
      .poll(
        async () =>
          await application!.evaluate(({ BrowserWindow }) => {
            const windows = BrowserWindow.getAllWindows();
            return {
              count: windows.length,
              minimized: windows[0]?.isMinimized(),
              focused: windows[0]?.isFocused(),
            };
          }),
      )
      .toEqual({ count: 1, minimized: false, focused: true });
    const closingApplication = application;
    await closeWindowAndWaitForApplication(closingApplication, () =>
      closingApplication.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        if (window === undefined) throw new Error("WINDOWS_MAIN_WINDOW_UNAVAILABLE");
        setImmediate(() => window.close());
      }),
    );
    application = null;
    application = await launchInstalled(executable, userDataPath);
    page = await application.firstWindow();
    await expect(page.locator('[data-shell="counter"]')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(credentials.adminDisplayName, { exact: true })).toBeVisible();

    const logout = await page.evaluate(async () => {
      const bridge = (
        window as Window & {
          laundryDesktop?: { auth?: { logout?: () => Promise<unknown> } };
        }
      ).laundryDesktop;
      return await bridge?.auth?.logout?.();
    });
    expect(logout).toEqual({ ok: true, data: { logged_out: true } });
  } finally {
    await closeApplication(application);
    if (secondaryCleanupConfirmed) await rm(userDataPath, { force: true, recursive: true });
  }
});
