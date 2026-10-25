import { randomBytes, randomInt } from "node:crypto";
import { lstat, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  DesktopLogoutResultSchema,
  DesktopMaintenanceInputSchema,
  DesktopMaintenanceResultSchema,
  DesktopQueryExecuteInputSchema,
  DesktopQueryExecuteResultSchema,
} from "@laundry/contracts";
import { _electron as electron, expect, test, type Page } from "@playwright/test";

import { loadWindowsBootstrapCredentials } from "./windows-credentials.mjs";
import {
  absoluteInput,
  acceptanceEnvironment,
  installedExecutable,
} from "./windows-offline-runtime.js";
import {
  createStaff,
  expectIdentity,
  expectSecretCleared,
  loginStaff,
  openSettings,
  resetStaffCredentials,
  switchStaff,
  type StaffAccount,
} from "./windows-staff-ui.js";

async function newEvidencePath(): Promise<string> {
  const path = absoluteInput("LAUNDRY_WINDOWS_STAFF_EVIDENCE_FILE");
  for (let directory = dirname(path); ; directory = dirname(directory)) {
    const metadata = await lstat(directory);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      (await realpath(directory)).toLowerCase() !== resolve(directory).toLowerCase()
    ) {
      throw new Error("WINDOWS_STAFF_EVIDENCE_PARENT_INVALID");
    }
    if (dirname(directory) === directory) break;
  }
  const existing = await lstat(path).then(
    () => true,
    (error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
      throw new Error("WINDOWS_STAFF_EVIDENCE_UNAVAILABLE");
    },
  );
  if (existing) throw new Error("WINDOWS_STAFF_EVIDENCE_MUST_BE_NEW");
  return path;
}

function syntheticAccount(): StaffAccount {
  const suffix = randomBytes(8).toString("hex");
  return Object.freeze({
    username: `qa-staff-${suffix}`,
    displayName: `合成店员 ${suffix}`,
    password: `Staff-Aa1-${randomBytes(24).toString("base64url")}`,
    pin: String(randomInt(100_000, 1_000_000)),
  });
}

async function staffAccessResult(page: Page): Promise<string> {
  const input: unknown = await DesktopQueryExecuteInputSchema.parseAsync({
    name: "staff.access.list",
    body: {},
  });
  const result: unknown = await page.evaluate(async (request) => {
    const bridge = (
      window as Window & {
        laundryDesktop?: { query?: { execute?: (value: unknown) => Promise<unknown> } };
      }
    ).laundryDesktop;
    if (typeof bridge?.query?.execute !== "function") throw new Error("QUERY_UNAVAILABLE");
    return await bridge.query.execute(request);
  }, input);
  const parsed = DesktopQueryExecuteResultSchema.safeParse(result);
  if (!parsed.success) throw new Error("WINDOWS_STAFF_QUERY_RESULT_INVALID");
  return parsed.data.ok ? "ok" : parsed.data.error.code;
}

async function expectMaintenanceDenied(page: Page): Promise<void> {
  const input = DesktopMaintenanceInputSchema.parse({ operation: "open", intent: "backup" });
  const result: unknown = await page.evaluate(async (request) => {
    const bridge = (
      window as Window & {
        laundryDesktop?: { maintenance?: { execute?: (value: unknown) => Promise<unknown> } };
      }
    ).laundryDesktop;
    if (typeof bridge?.maintenance?.execute !== "function") {
      throw new Error("MAINTENANCE_UNAVAILABLE");
    }
    return await bridge.maintenance.execute(request);
  }, input);
  const parsed = DesktopMaintenanceResultSchema.safeParse(result);
  if (!parsed.success) throw new Error("WINDOWS_STAFF_MAINTENANCE_RESULT_INVALID");
  expect(parsed.data.ok ? "UNEXPECTED_SUCCESS" : parsed.data.error.code).toBe(
    "AUTHENTICATION_FAILED",
  );
}

async function logout(page: Page): Promise<void> {
  const result: unknown = await page.evaluate(async () => {
    const bridge = (
      window as Window & { laundryDesktop?: { auth?: { logout?: () => Promise<unknown> } } }
    ).laundryDesktop;
    if (typeof bridge?.auth?.logout !== "function") throw new Error("LOGOUT_UNAVAILABLE");
    return await bridge.auth.logout();
  });
  const parsed = DesktopLogoutResultSchema.safeParse(result);
  if (!parsed.success) throw new Error("WINDOWS_STAFF_LOGOUT_RESULT_INVALID");
  expect(parsed.data.ok && parsed.data.data.logged_out).toBe(true);
  await page.reload({ waitUntil: "domcontentloaded" });
}

test("installed staff can open receive, cannot list staff or open maintenance, and reset rejects old credentials", async () => {
  // The external runner binds source/manifest, synthetic Runtime, and the limited Windows session.
  if (
    process.platform !== "win32" ||
    process.env.LAUNDRY_WINDOWS_STAFF_ACCEPTANCE !== "synthetic-isolated"
  ) {
    throw new Error("WINDOWS_STAFF_SYNTHETIC_ACCEPTANCE_REQUIRED");
  }
  const evidencePath = await newEvidencePath();
  const executablePath = await installedExecutable();
  const bootstrap = await loadWindowsBootstrapCredentials();
  const approver = Object.freeze({
    displayName: bootstrap.approverDisplayName,
    pin: bootstrap.approverPin,
  });
  const account = syntheticAccount();
  const replacement = syntheticAccount();
  const reset = Object.freeze({
    password: replacement.password,
    pin: replacement.pin === account.pin ? String(Number(account.pin) + 1) : replacement.pin,
  });
  const userData = await mkdtemp(join(await realpath(tmpdir()), "laundry-win-staff-"));
  try {
    const application = await electron.launch({
      executablePath,
      args: [`--user-data-dir=${userData}`],
      env: acceptanceEnvironment(),
      timeout: 30_000,
    });
    try {
      const identity = await application.evaluate(({ app }) => ({
        isPackaged: app.isPackaged,
        platform: process.platform,
      }));
      expect(identity).toEqual({ isPackaged: true, platform: "win32" });
      const page = await application.firstWindow();
      await test.step("create a staff account with two-person approval and no privacy grant", async () => {
        await loginStaff(page, bootstrap.adminUsername, bootstrap.adminPassword);
        await expectIdentity(page, "admin", bootstrap.adminDisplayName);
        expect(await staffAccessResult(page)).toBe("ok");
        await createStaff(page, account, approver);
      });
      await test.step("staff can open receive while management query and maintenance are denied", async () => {
        await switchStaff(page, account.displayName, account.pin);
        await expectIdentity(page, "staff", account.displayName);
        await page.locator('[data-nav-id="receive"]').click();
        await expect(
          page.getByRole("heading", { name: "开单", level: 1, exact: true }),
        ).toBeVisible();
        await openSettings(page, "backup");
        const panel = page.getByRole("region", { name: "备份与恢复", exact: true });
        await expect(
          panel.getByRole("button", { name: "刷新备份状态", exact: true }),
        ).toBeVisible();
        for (const name of ["打开维护程序", "创建本机备份", "恢复演练"]) {
          await expect(panel.getByRole("button", { name, exact: true })).toHaveCount(0);
        }
        expect(await staffAccessResult(page)).toBe("PERMISSION_DENIED");
        await expectMaintenanceDenied(page);
      });
      await test.step("approved reset rejects old PIN and permits the replacement PIN", async () => {
        await switchStaff(page, bootstrap.adminDisplayName, bootstrap.adminPin);
        await expectIdentity(page, "admin", bootstrap.adminDisplayName);
        await resetStaffCredentials(page, account.displayName, reset, approver);
        await switchStaff(page, account.displayName, account.pin);
        const dialog = page.getByRole("dialog", { name: "切换员工", exact: true });
        await expect(dialog.getByRole("alert")).toContainText("Authentication failed", {
          timeout: 20_000,
        });
        await expectSecretCleared(dialog.getByLabel("PIN", { exact: true }));
        await expectIdentity(page, "admin", bootstrap.adminDisplayName);
        await dialog.getByRole("button", { name: "取消", exact: true }).click();
        await switchStaff(page, account.displayName, reset.pin);
        await expectIdentity(page, "staff", account.displayName);
      });
      await test.step("old password is rejected and replacement password signs in as staff", async () => {
        await logout(page);
        await loginStaff(page, account.username, account.password);
        await expect(page.locator('[data-page="login"]').getByRole("alert")).toContainText(
          "Authentication failed",
          { timeout: 20_000 },
        );
        await expectSecretCleared(page.locator('input[name="password"]'));
        await expect(page.locator('[data-shell="counter"]')).toHaveCount(0);
        await loginStaff(page, account.username, reset.password);
        await expectIdentity(page, "staff", account.displayName);
        await logout(page);
      });
    } finally {
      await application.close();
    }
  } finally {
    await rm(userData, { recursive: true, force: true });
  }
  // Counts and booleans only: credentials and staff identifiers never enter the evidence.
  await writeFile(
    evidencePath,
    `${JSON.stringify(
      {
        schema_version: 1,
        packaged_windows_verified: true,
        synthetic_staff_created: 1,
        two_person_approvals_completed: 2,
        staff_without_privacy_grant: true,
        admin_staff_list_allowed: true,
        staff_receive_screen_visible: true,
        staff_maintenance_controls_hidden: true,
        staff_access_list_permission_denied: true,
        staff_maintenance_open_authentication_failed: true,
        old_pin_rejected: true,
        replacement_pin_accepted: true,
        old_password_rejected: true,
        replacement_password_accepted: true,
        final_logout_succeeded: true,
        application_closed: true,
      },
      null,
      2,
    )}\n`,
    { flag: "wx", mode: 0o600 },
  );
});
