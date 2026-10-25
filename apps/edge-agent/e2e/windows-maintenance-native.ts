import { execFile } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export const executeNative = promisify(execFile);
export const MAINTENANCE_TITLE = "Laundry Desk V2 · 本地服务安装与维护";
export type NativeWindow = Readonly<{ id: number; started: string }>;
export const powershell = () =>
  join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe");

export async function maintenanceWindows(
  title = MAINTENANCE_TITLE,
): Promise<readonly NativeWindow[]> {
  const result = await executeNative(
    powershell(),
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$ErrorActionPreference='Stop'
      $items=@(Get-Process -Name powershell -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq (Get-Process -Id $PID).SessionId -and $_.MainWindowTitle -ceq $env:LAUNDRY_TEST_WINDOW_TITLE })
      ConvertTo-Json -Compress -InputObject @($items | ForEach-Object { @{id=$_.Id; started=$_.StartTime.ToUniversalTime().Ticks.ToString()} })`,
    ],
    {
      env: { ...process.env, LAUNDRY_TEST_WINDOW_TITLE: title },
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
        typeof item.started !== "string" ||
        !/^\d+$/u.test(item.started),
    )
  )
    throw new Error("COUNTER_MAINTENANCE_WINDOW_RESULT_INVALID");
  return value as NativeWindow[];
}

export async function closeMaintenanceWindow(
  window: NativeWindow,
  title = MAINTENANCE_TITLE,
  onBusy?: () => Promise<void>,
): Promise<Readonly<{ observedBusy: boolean }>> {
  const pending = executeNative(
    powershell(),
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      fileURLToPath(new URL("windows-maintenance-close.ps1", import.meta.url)),
      "-WindowId",
      String(window.id),
      "-Started",
      window.started,
      "-Title",
      title,
    ],
    { windowsHide: true, timeout: 110_000, maxBuffer: 8192 },
  );
  type BusyNotification = Readonly<{ ok: true }> | Readonly<{ ok: false; error: unknown }>;
  let notification = Promise.resolve<BusyNotification>({ ok: true });
  let notified = false;
  let stderrLine = "";
  pending.child.stderr?.on("data", (chunk: Buffer) => {
    const lines = `${stderrLine}${chunk.toString("utf8")}`.split("\n");
    stderrLine = lines.pop() ?? "";
    if (
      !notified &&
      lines.some((line) => line.replace(/\r$/u, "") === "COUNTER_MAINTENANCE_BUSY_OBSERVED")
    ) {
      notified = true;
      notification = Promise.resolve()
        .then(() => onBusy?.())
        .then<BusyNotification, BusyNotification>(
          () => ({ ok: true }),
          (error: unknown) => ({ ok: false, error }),
        );
    }
  });
  let result: Awaited<typeof pending> | undefined;
  let executionFailure: Readonly<{ error: unknown }> | undefined;
  try {
    result = await pending;
  } catch (error) {
    executionFailure = { error };
  }
  const observed = await notification;
  const failures = [
    ...(executionFailure ? [executionFailure.error] : []),
    ...(!observed.ok ? [observed.error] : []),
  ];
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, "COUNTER_MAINTENANCE_CLOSE_AND_OBSERVER_FAILED");
  if (!result) throw new Error("COUNTER_MAINTENANCE_CLOSE_RESULT_MISSING");
  const value: unknown = JSON.parse(result.stdout);
  if (
    typeof value !== "object" ||
    value === null ||
    !("closed" in value) ||
    value.closed !== true ||
    !("observed_busy" in value) ||
    typeof value.observed_busy !== "boolean"
  )
    throw new Error("COUNTER_MAINTENANCE_CLOSE_RESULT_INVALID");
  return { observedBusy: value.observed_busy };
}
