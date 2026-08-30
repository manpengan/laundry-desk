import { lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { inspectPrivateFile } from "@laundry/platform-fs";

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

type DevelopmentCredentials = Readonly<{
  adminUsername: string;
  adminDisplayName: string;
  adminPassword: string;
}>;

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

async function loadCredentials(path: string): Promise<DevelopmentCredentials> {
  await inspectPrivateFile(path);
  const metadata = await lstat(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    metadata.size > 8192
  ) {
    throw new Error("Windows development credential handoff is invalid");
  }
  const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  const adminUsername = value.admin_username;
  const adminDisplayName = value.admin_display_name;
  const adminPassword = value.admin_password;
  if (
    value.development_only !== true ||
    typeof adminUsername !== "string" ||
    !/^[A-Za-z0-9_.-]{1,64}$/u.test(adminUsername) ||
    typeof adminDisplayName !== "string" ||
    adminDisplayName.length < 1 ||
    adminDisplayName.length > 80 ||
    typeof adminPassword !== "string" ||
    adminPassword.length < 12 ||
    adminPassword.length > 256 ||
    /[\0\r\n]/u.test(adminPassword)
  ) {
    throw new Error("Windows development credential handoff is invalid");
  }
  return Object.freeze({ adminUsername, adminDisplayName, adminPassword });
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
  const credentials = await loadCredentials(
    requiredAbsoluteEnvironment("LAUNDRY_WINDOWS_RUNTIME_CREDENTIALS_FILE"),
  );
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
    await page.locator('input[name="username"]').fill(credentials.adminUsername);
    await page.locator('input[name="password"]').fill(credentials.adminPassword);
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
