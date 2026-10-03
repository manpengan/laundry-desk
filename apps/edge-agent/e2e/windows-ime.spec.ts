import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { fillWindowsCredential, loadWindowsRuntimeCredentials } from "./windows-credentials.mjs";
import {
  allowsUntrustedNativeImeEnd,
  captureImeDiagnostics,
  isAcceptedImeComposition,
  projectImeDiagnostics,
} from "./windows-ime-diagnostics.mjs";
import { installImeDispatchAudit } from "./windows-ime-dispatch-audit.mjs";

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
const EXTERNAL_INPUT_TIMEOUT = 90_000;

type ImeEvent = Readonly<{
  type: string;
  trusted: boolean;
  commitsExpectedText: boolean;
  composing: boolean;
}>;
type ImeObservation = Readonly<{
  hasExpectedText: boolean;
  overflow: boolean;
  events: readonly ImeEvent[];
}>;
type ProbeWindow = Window & {
  readonly laundryImeDispatchAudit?: Readonly<{
    snapshot(
      target: EventTarget,
    ): Readonly<{ auditIntact: boolean; scriptDispatchedEvents: number }>;
    wasScriptDispatched(event: Event): boolean;
  }>;
  laundryImeAcceptance?: () => ImeObservation;
  laundryImeDiagnostic?: () => ImeObservation & {
    readonly inputConnected: boolean;
    readonly inputIsCurrent: boolean;
    readonly auditIntact: boolean;
    readonly scriptDispatchedEvents: number;
  };
};
type FailureStage =
  | "launch"
  | "login"
  | "observer_setup"
  | "ready_record"
  | "composition_wait"
  | "workbench_navigation"
  | "evidence_write";

function requiredAbsoluteEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value !== value.trim() || !isAbsolute(value) || value.includes("\0")) {
    throw new Error(`${name} must be one absolute path`);
  }
  return resolve(value);
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

async function writeNewRecord(
  path: string,
  record: Readonly<Record<string, unknown>>,
  code: string,
): Promise<void> {
  try {
    await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  } catch {
    throw new Error(code);
  }
}

async function login(page: Page, username: string, password: string): Promise<void> {
  await expect(page.locator('[data-page="login"]')).toBeVisible({ timeout: 20_000 });
  await page.locator('input[name="org_code"]').fill("local");
  await page.locator('input[name="store_code"]').fill("main");
  await fillWindowsCredential(page.locator('input[name="username"]'), username);
  await fillWindowsCredential(page.locator('input[name="password"]'), password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.locator('[data-shell="counter"]')).toBeVisible({ timeout: 20_000 });
}

async function observeInputMethod(page: Page): Promise<void> {
  await page.evaluate(() => {
    const input = document.querySelector('[data-testid="customers-name-input"]');
    if (!(input instanceof HTMLInputElement)) throw new Error("WINDOWS_IME_INPUT_UNAVAILABLE");
    const audit = (window as ProbeWindow).laundryImeDispatchAudit;
    if (audit === undefined || !audit.snapshot(input).auditIntact)
      throw new Error("WINDOWS_IME_DISPATCH_AUDIT_UNAVAILABLE");
    let events: readonly ImeEvent[] = [];
    let overflow = false;
    let scriptEventsObserved = 0;
    const record = (event: Event): void => {
      if (audit.wasScriptDispatched(event))
        scriptEventsObserved = Math.min(scriptEventsObserved + 1, 65);
      if (events.length >= 64) {
        overflow = true;
        return;
      }
      // Keep only predicates about the synthetic target; unexpected typed text is never recorded.
      events = Object.freeze([
        ...events,
        Object.freeze({
          type: event.type,
          trusted: event.isTrusted,
          commitsExpectedText:
            event instanceof CompositionEvent &&
            event.type === "compositionend" &&
            event.data === "你好",
          composing: event instanceof InputEvent && event.isComposing,
        }),
      ]);
    };
    for (const name of ["compositionstart", "compositionupdate", "compositionend", "input"]) {
      input.addEventListener(name, record);
    }
    const observe = (): ImeObservation =>
      Object.freeze({ hasExpectedText: input.value === "你好", overflow, events });
    (window as ProbeWindow).laundryImeAcceptance = observe;
    (window as ProbeWindow).laundryImeDiagnostic = () => {
      const snapshot = audit.snapshot(input);
      return Object.freeze({
        ...observe(),
        inputConnected: input.isConnected,
        inputIsCurrent: input === document.querySelector('[data-testid="customers-name-input"]'),
        auditIntact: snapshot.auditIntact,
        scriptDispatchedEvents: Math.max(snapshot.scriptDispatchedEvents, scriptEventsObserved),
      });
    };
  });
}

async function waitForExternalComposition(page: Page, versions: unknown): Promise<ImeObservation> {
  try {
    await expect
      .poll(
        async () => {
          const raw = await page.evaluate(() => (window as ProbeWindow).laundryImeDiagnostic?.());
          return isAcceptedImeComposition(raw, versions);
        },
        { timeout: EXTERNAL_INPUT_TIMEOUT, intervals: [100] },
      )
      .toBe(true);
    const observed = await page.evaluate(() => (window as ProbeWindow).laundryImeDiagnostic?.());
    if (observed === undefined || !isAcceptedImeComposition(observed, versions))
      throw new Error("WINDOWS_IME_OBSERVATION_UNAVAILABLE");
    await test.info().attach("native-ime-engine-and-audit", {
      body: JSON.stringify({
        versions,
        allowsUntrustedNativeEnd: allowsUntrustedNativeImeEnd(versions),
        diagnostic: projectImeDiagnostics(observed),
      }),
      contentType: "application/json",
    });
    return Object.freeze({
      hasExpectedText: observed.hasExpectedText,
      overflow: observed.overflow,
      events: observed.events,
    });
  } catch {
    // DOM snapshots, raw unexpected input and native diagnostics are excluded from failures.
    throw new Error("WINDOWS_IME_REAL_COMPOSITION_UNVERIFIED");
  }
}

test("installed Windows Counter observes external Chinese input-method composition", async () => {
  expect(process.platform).toBe("win32");
  const requestedExecutable = requiredAbsoluteEnvironment("LAUNDRY_WINDOWS_INSTALLED_EXE");
  const executable = await realpath(requestedExecutable);
  expect(executable.toLowerCase()).toBe(requestedExecutable.toLowerCase());
  const metadata = await lstat(executable);
  expect(metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1).toBe(true);
  const readyPath = requiredAbsoluteEnvironment("LAUNDRY_WINDOWS_IME_READY_FILE");
  const evidencePath = requiredAbsoluteEnvironment("LAUNDRY_WINDOWS_IME_EVIDENCE_FILE");
  const diagnosticPath = `${evidencePath}.failure.json`;
  if ([evidencePath, diagnosticPath].some((path) => readyPath.toLowerCase() === path.toLowerCase()))
    throw new Error("WINDOWS_IME_RECORD_PATHS_CONFLICT");
  const credentials = await loadWindowsRuntimeCredentials();
  const runId = randomUUID();
  const userDataPath = await mkdtemp(join(await realpath(tmpdir()), "laundry-win-ime-"));
  let application: ElectronApplication | null = null;
  let page: Page | null = null;
  let failureStage: FailureStage = "launch";
  try {
    application = await electron.launch({
      executablePath: executable,
      args: [`--user-data-dir=${userDataPath}`],
      env: credentialFreeEnvironment(),
    });
    page = await application.firstWindow();
    const versions = await application.evaluate(() => ({
      electron: process.versions.electron,
      chrome: process.versions.chrome,
    }));
    failureStage = "observer_setup";
    await page.waitForURL("app://local/index.html", { waitUntil: "load", timeout: 20_000 });
    await expect(page.locator('[data-page="login"]')).toBeVisible({ timeout: 20_000 });
    await page.addInitScript(installImeDispatchAudit);
    await page.reload();
    failureStage = "login";
    await login(page, credentials.adminUsername, credentials.adminPassword);
    expect(page.url()).toBe("app://local/index.html");
    failureStage = "observer_setup";
    await page.locator('[data-nav-id="customers"]').click();
    const input = page.locator('[data-testid="customers-name-input"]');
    await expect(input).toBeVisible();
    await expect(input).toHaveValue("");
    await observeInputMethod(page);
    await input.click();
    await expect(input).toBeFocused();
    // On Windows Playwright's launched process is the command shell, not Electron's main process.
    const targetProcessId = await application.evaluate(() => process.pid);
    if (
      targetProcessId === undefined ||
      !Number.isSafeInteger(targetProcessId) ||
      targetProcessId < 1
    )
      throw new Error("WINDOWS_IME_COUNTER_PROCESS_UNAVAILABLE");
    const common = Object.freeze({
      schema_version: 1,
      run_id: runId,
      pid: targetProcessId,
      probe: "native_chinese_ime",
      input_dispatch: "external_physical_or_isolated_vm",
      observer_only: true,
      expected_text: "你好",
      customer_saved: false,
    });
    failureStage = "ready_record";
    await writeNewRecord(
      readyPath,
      Object.freeze({
        ...common,
        status: "ready_for_external_input",
        stage: "awaiting_real_ime_input",
        input_target: "unsaved_customer_name",
      }),
      "WINDOWS_IME_READY_RECORD_WRITE_FAILED",
    );
    process.stdout.write(
      `${JSON.stringify({ schema_version: 1, run_id: runId, pid: targetProcessId, status: "ready_for_external_input", stage: "awaiting_real_ime_input", probe: "native_chinese_ime" })}\n`,
    );

    // Keys must come from physical input or the isolated guest's virtual keyboard, outside this test.
    failureStage = "composition_wait";
    const observed = await waitForExternalComposition(page, versions);
    failureStage = "workbench_navigation";
    await page.locator('[data-nav-id="workbench"]').click();
    failureStage = "evidence_write";
    await writeNewRecord(
      evidencePath,
      Object.freeze({ ...common, status: "passed", stage: "composition_verified", observed }),
      "WINDOWS_IME_EVIDENCE_RECORD_WRITE_FAILED",
    );
    process.stdout.write(
      `${JSON.stringify({ schema_version: 1, run_id: runId, status: "passed", probe: "native_chinese_ime", committed_text: "你好", customer_saved: false })}\n`,
    );
  } catch (error) {
    const failurePage = page;
    const diagnostic = await captureImeDiagnostics(async () => {
      if (failurePage === null) throw new Error("WINDOWS_IME_PAGE_UNAVAILABLE");
      return failurePage.evaluate(() => (window as ProbeWindow).laundryImeDiagnostic?.());
    });
    try {
      await writeNewRecord(
        diagnosticPath,
        Object.freeze({
          schema_version: 1,
          run_id: runId,
          status: "failed",
          stage: failureStage,
          diagnostic,
        }),
        "WINDOWS_IME_DIAGNOSTIC_RECORD_WRITE_FAILED",
      );
    } catch (diagnosticError) {
      throw new AggregateError([error, diagnosticError], "WINDOWS_IME_TEST_AND_DIAGNOSTIC_FAILED");
    }
    throw error;
  } finally {
    try {
      await application?.close();
    } finally {
      await rm(userDataPath, { force: true, recursive: true });
    }
  }
});
