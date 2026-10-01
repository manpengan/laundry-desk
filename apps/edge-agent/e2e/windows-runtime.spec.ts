import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { fillWindowsCredential, loadWindowsRuntimeCredentials } from "./windows-credentials.mjs";

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

  try {
    application = await launchInstalled(executable, userDataPath);
    let page = await application.firstWindow();
    await expect(page.locator('[data-page="login"]')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("heading", { name: "本地服务尚未就绪" })).toHaveCount(0);
    expect(page.url()).toBe("app://local/index.html");

    const main = await application.evaluate(({ app, BrowserWindow, safeStorage, session }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (window === undefined) throw new Error("installed Windows main window is unavailable");
      return {
        dedicatedSession:
          window.webContents.session === session.fromPartition("persist:laundry-v2-local"),
        encryptionAvailable: safeStorage.isEncryptionAvailable(),
        isPackaged: app.isPackaged,
        platform: process.platform,
      };
    });
    expect(main).toEqual({
      dedicatedSession: true,
      encryptionAvailable: true,
      isPackaged: true,
      platform: "win32",
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

    await closeApplication(application);
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
    await rm(userDataPath, { force: true, recursive: true });
  }
});
