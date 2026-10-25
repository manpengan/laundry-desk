import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { fillWindowsCredential, loadWindowsRuntimeCredentials } from "./windows-credentials.mjs";

import {
  closeMaintenanceWindow,
  maintenanceWindows,
  type NativeWindow,
} from "./windows-maintenance-native.js";
import "./windows-maintenance-close-regression.js";

// This gate uses an installed native PostgreSQL Runtime and the actual Counter IPC path.
// It does not perform physical-store/operator acceptance or mutate non-CI installations.
test("installed paired Counter reads backup health and opens a maintenance window that survives Counter exit", async () => {
  // Two separately verified health reads can each consume the bounded 90-second native budget.
  test.setTimeout(240_000);
  expect(process.platform).toBe("win32");
  expect(process.env.GITHUB_ACTIONS).toBe("true");
  expect(process.env.LAUNDRY_RUNTIME_PAIR_INSTALLED).toBe("true");
  const executable = process.env.LAUNDRY_WINDOWS_INSTALLED_EXE;
  if (!executable || !isAbsolute(executable)) throw new Error("INSTALLED_COUNTER_REQUIRED");
  const profile = process.env.LAUNDRY_WINDOWS_DISTRIBUTION_PROFILE;
  if (profile !== "generic" && profile !== "hongfa") throw new Error("COUNTER_PROFILE_REQUIRED");
  const credentials = await loadWindowsRuntimeCredentials();
  const userData = await mkdtemp(join(await realpath(tmpdir()), "counter-pair-ci-"));
  const before = await maintenanceWindows();
  let application: ElectronApplication | null = null;
  let ownedWindow: NativeWindow | undefined;
  const failures: unknown[] = [];
  const env = Object.fromEntries(
    [
      "PATH",
      "SystemRoot",
      "WINDIR",
      "TEMP",
      "TMP",
      "USERPROFILE",
      "LOCALAPPDATA",
      "APPDATA",
    ].flatMap((key) => (process.env[key] ? [[key, process.env[key]!]] : [])),
  );
  try {
    application = await electron.launch({
      executablePath: executable,
      args: [`--user-data-dir=${userData}`],
      env,
    });
    const page = await application.firstWindow();
    await expect(page.locator('[data-page="login"]')).toBeVisible({ timeout: 30_000 });
    await fillWindowsCredential(page.locator('input[name="username"]'), credentials.adminUsername);
    await fillWindowsCredential(page.locator('input[name="password"]'), credentials.adminPassword);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await expect(page.locator('[data-shell="counter"]')).toBeVisible({ timeout: 30_000 });
    await page.locator('[data-nav-id="settings"]').click();
    const navigation = page.getByRole("navigation", { name: "设置分区" });
    const select = navigation.getByRole("combobox", { name: "查看分区" });
    if (await select.isVisible()) await select.selectOption("settings-backup");
    else await navigation.getByRole("button", { name: "备份与恢复", exact: true }).click();
    const panel = page.getByRole("region", { name: "备份与恢复", exact: true });
    await panel.getByRole("button", { name: "刷新备份状态", exact: true }).click();
    // Screenshots stay off in this gate; on failure report the panel's own visible copy instead.
    const panelText = async () => (await panel.innerText()).replace(/\s+/gu, " ").slice(0, 800);
    const checkedAt = panel.getByText("状态核对时间", { exact: true });
    const alert = panel.locator('[role="alert"]');
    try {
      await expect(checkedAt.or(alert).first()).toBeVisible({ timeout: 100_000 });
    } catch (error) {
      throw new Error(`COUNTER_BACKUP_HEALTH_NOT_SHOWN ${await panelText()}`, { cause: error });
    }
    if ((await alert.count()) > 0) {
      throw new Error(`COUNTER_BACKUP_HEALTH_ALERT ${await panelText()}`);
    }
    await expect(checkedAt).toBeVisible();
    await panel.getByRole("button", { name: "打开维护程序", exact: true }).click();
    await expect(
      panel.getByText("维护窗口已打开，请在窗口中确认操作。完成后回到此处刷新状态。", {
        exact: true,
      }),
    ).toBeVisible({ timeout: 40_000 });
    const created = (await maintenanceWindows()).filter(
      (item) => !before.some((old) => old.id === item.id && old.started === item.started),
    );
    expect(created).toHaveLength(1);
    ownedWindow = created[0]!;
    await application.close();
    application = null;
    for (let check = 0; check < 3; check++) {
      expect(await maintenanceWindows()).toContainEqual(ownedWindow);
    }
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      await application?.close();
    } catch (error) {
      failures.push(error);
    }
    if (ownedWindow) {
      try {
        await closeMaintenanceWindow(ownedWindow);
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      await rm(userData, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, "COUNTER_MAINTENANCE_ACCEPTANCE_AND_CLEANUP_FAILED", {
      cause: failures[0],
    });
  await writeFile(
    join(process.env.RUNNER_TEMP!, `counter-maintenance-${profile}.json`),
    JSON.stringify(
      {
        source_git_sha: process.env.GITHUB_SHA,
        runtime_manifest_sha256: process.env.LAUNDRY_MANIFEST_SHA256,
        profile,
        assurance: "development_only",
        environment: "CI_only_not_target_host_acceptance",
        backup_health_read_from_installed_counter: true,
        native_maintenance_window_opened: true,
        maintenance_survived_counter_exit: true,
        native_maintenance_window_closed: true,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
});
