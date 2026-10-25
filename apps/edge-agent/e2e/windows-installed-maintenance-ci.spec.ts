import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { fillWindowsCredential, loadWindowsRuntimeCredentials } from "./windows-credentials.mjs";

const execute = promisify(execFile);
const TITLE = "Laundry Desk V2 · 本地服务安装与维护";
type NativeWindow = Readonly<{ id: number; started: string }>;
async function maintenanceWindows(close?: NativeWindow): Promise<readonly NativeWindow[]> {
  const result = await execute(
    join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe"),
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `
      $ErrorActionPreference='Stop'
      $items=@(Get-Process -Name powershell -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq (Get-Process -Id $PID).SessionId -and $_.MainWindowTitle -ceq $env:LAUNDRY_TEST_WINDOW_TITLE })
      if($env:LAUNDRY_TEST_CLOSE_ID){
        $target=@($items | Where-Object { $_.Id.ToString() -ceq $env:LAUNDRY_TEST_CLOSE_ID -and $_.StartTime.ToUniversalTime().Ticks.ToString() -ceq $env:LAUNDRY_TEST_CLOSE_STARTED })
        if($target.Count -ne 1 -or -not $target[0].CloseMainWindow() -or -not $target[0].WaitForExit(10000)){throw 'COUNTER_MAINTENANCE_CLOSE_FAILED'}
        $items=@()
      }
      ConvertTo-Json -Compress -InputObject @($items | ForEach-Object { @{id=$_.Id; started=$_.StartTime.ToUniversalTime().Ticks.ToString()} })
    `,
    ],
    {
      env: {
        ...process.env,
        LAUNDRY_TEST_WINDOW_TITLE: TITLE,
        LAUNDRY_TEST_CLOSE_ID: close ? String(close.id) : "",
        LAUNDRY_TEST_CLOSE_STARTED: close?.started ?? "",
      },
      windowsHide: true,
      timeout: 20_000,
      maxBuffer: 8192,
    },
  );
  const value: unknown = JSON.parse(result.stdout);
  if (
    !Array.isArray(value) ||
    value.some(
      (item: unknown) =>
        typeof item !== "object" ||
        item === null ||
        !("id" in item) ||
        !Number.isSafeInteger(item.id) ||
        !("started" in item) ||
        typeof item.started !== "string",
    )
  )
    throw new Error("COUNTER_MAINTENANCE_WINDOW_RESULT_INVALID");
  return value as NativeWindow[];
}

// This gate uses an installed native PostgreSQL Runtime and the actual Counter IPC path.
// It does not perform physical-store/operator acceptance or mutate non-CI installations.
test("installed paired Counter reads backup health and opens a maintenance window that survives Counter exit", async () => {
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
      await expect(checkedAt.or(alert).first()).toBeVisible({ timeout: 40_000 });
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
        },
        null,
        2,
      ) + "\n",
      { flag: "wx" },
    );
  } finally {
    await application?.close();
    if (ownedWindow) await maintenanceWindows(ownedWindow);
    await rm(userData, { recursive: true, force: true });
  }
});
