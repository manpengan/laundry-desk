import { execFile, type ChildProcess } from "node:child_process";
import { isAbsolute, join } from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";

type SwitchStage =
  `switch.${"approver" | "admin"}.${"open" | "dialog" | "option" | "select" | "pin" | "submit" | "identity"}`;
type LogoutStage = `logout.${"bootstrap" | "final"}.${"ipc" | "reload" | "identity"}`;
type CloseStage = `close.${"restart" | "final" | "cleanup"}`;
export type FunctionalStage =
  | SwitchStage
  | LogoutStage
  | CloseStage
  | "receive.final-recovery"
  | `screenshot.${"workbench" | "settings" | "order" | "settled" | "stats" | "restarted"}`
  | "cleanup.process-tree"
  | "cleanup.private-material"
  | "diagnostics.dom"
  | "diagnostics.main-log";

/** Only fixed stage names and outcomes enter the public JSONL; never pass error objects. */
export function functionalStage(
  stage: FunctionalStage,
  outcome: "started" | "completed" | "failed" | "retained",
): void {
  process.stdout.write(
    `${JSON.stringify({ kind: "windows-functional-stage", stage, outcome, time: new Date().toISOString() })}\n`,
  );
}

export async function functionalStep<T>(
  stage: FunctionalStage,
  operation: () => Promise<T>,
  timeoutMs = 10_000,
): Promise<T> {
  functionalStage(stage, "started");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`WINDOWS_FUNCTIONAL_TIMEOUT:${stage}`)),
          timeoutMs,
        );
      }),
    ]);
    functionalStage(stage, "completed");
    return result;
  } catch (error) {
    functionalStage(stage, "failed");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/** Failure-only, bounded observation: no text extraction, input values, or identities. */
export async function captureFunctionalFailureDom(page: Page): Promise<void> {
  const state = await functionalStep(
    "diagnostics.dom",
    () =>
      Promise.all([
        page
          .locator('[data-nav-id="receive"][aria-current="page"]')
          .count()
          .then((count) => count > 0),
        page
          .locator('[data-nav-id="workbench"][aria-current="page"]')
          .count()
          .then((count) => count > 0),
        page.getByRole("dialog", { name: "切换员工", exact: true }).isVisible(),
        page.getByRole("dialog", { name: "保护当前开单内容", exact: true }).isVisible(),
        page.getByText("正在读取本机开单恢复记录…", { exact: true }).isVisible(),
        page.getByText("正在安全保存本机开单内容…", { exact: true }).isVisible(),
        page.getByText("本机开单内容已加密保存", { exact: true }).isVisible(),
      ]),
    2_000,
  ).catch(() => null);
  if (state === null) return;
  const [
    on_receive,
    on_workbench,
    staff_dialog,
    protect_dialog,
    recovery_reading,
    recovery_saving,
    recovery_saved,
  ] = state;
  process.stdout.write(
    `${JSON.stringify({ on_receive, on_workbench, staff_dialog, protect_dialog, recovery_reading, recovery_saving, recovery_saved })}\n`,
  );
}

function observeExit(child: ChildProcess) {
  let listener: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    listener = resolve;
    child.once("exit", listener);
    if (hasExited(child)) resolve();
  });
  return { promise, dispose: () => listener !== undefined && child.off("exit", listener) };
}

async function killOwnedWindowsTree(child: ChildProcess): Promise<void> {
  // Keep the actual child handle from this launch; never discover a process by app name.
  if (hasExited(child)) return;
  const pid = child.pid;
  const systemRoot = process.env.SystemRoot;
  if (
    process.platform !== "win32" ||
    pid === undefined ||
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    systemRoot === undefined ||
    !isAbsolute(systemRoot)
  ) {
    throw new Error("WINDOWS_FUNCTIONAL_OWNED_PROCESS_UNAVAILABLE");
  }
  const exit = observeExit(child);
  try {
    await functionalStep(
      "cleanup.process-tree",
      async () => {
        if (!hasExited(child)) {
          await new Promise<void>((resolve, reject) => {
            execFile(
              join(systemRoot, "System32", "taskkill.exe"),
              ["/PID", String(pid), "/T", "/F"],
              { windowsHide: true, timeout: 4_000, maxBuffer: 64 * 1024 },
              (error) => {
                if (error === null) resolve();
                else reject(new Error("WINDOWS_FUNCTIONAL_PROCESS_TREE_CLEANUP_FAILED"));
              },
            );
          });
        }
        await exit.promise;
      },
      5_000,
    );
  } finally {
    exit.dispose();
  }
}

/** A forced cleanup always leaves close failed; it must never turn acceptance green. */
export async function closeFunctionalApplication(
  application: ElectronApplication,
  stage: CloseStage,
): Promise<void> {
  const child = application.process();
  const exit = observeExit(child);
  try {
    await functionalStep(stage, async () => {
      await application.close();
      await exit.promise;
    });
  } catch (error) {
    try {
      await killOwnedWindowsTree(child);
    } catch {
      functionalStage("cleanup.process-tree", "failed");
    }
    // Preserve the first close error, including when the bounded cleanup also fails.
    throw error;
  } finally {
    exit.dispose();
  }
}
