import { spawn } from "node:child_process";
import { access, mkdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";

import {
  runPackagedMemberParity,
  runPackagedOrderParity,
  runPackagedReportsParity,
  runPackagedSettingsParity,
} from "./packaged-counter-parity.js";

const PASSTHROUGH_ENV_KEYS = Object.freeze([
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
]);
const REPOSITORY_ROOT = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const RELEASE_ROOT = join(REPOSITORY_ROOT, "apps", "edge-agent", "release");
const HEALTH_URL = "http://127.0.0.1:8787/health";
const HEALTH_TIMEOUT_MS = 90_000;
const COMMAND_TIMEOUT_MS = 180_000;
const PROCESS_EXIT_GRACE_MS = 5_000;

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function requiredSecretEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

const APP_PATH = requiredEnvironment("LAUNDRY_MAC_APP_PATH");
const USER_DATA_PATH = requiredEnvironment("LAUNDRY_MAC_USER_DATA_DIR");
const DOWNLOAD_PATH = join(USER_DATA_PATH, "downloads");
const CONFIG_PATH = requiredEnvironment("LAUNDRY_LOCAL_CONFIG_DIR");
const COMPOSE_PROJECT = requiredEnvironment("COMPOSE_PROJECT_NAME");
const LOGIN = Object.freeze({
  orgCode: requiredEnvironment("LAUNDRY_LOCAL_ORG_CODE"),
  storeCode: requiredEnvironment("LAUNDRY_LOCAL_STORE_CODE"),
  username: requiredEnvironment("LAUNDRY_BOOTSTRAP_ADMIN_USERNAME"),
  displayName: requiredEnvironment("LAUNDRY_BOOTSTRAP_ADMIN_DISPLAY_NAME"),
  password: requiredSecretEnvironment("LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD"),
  pin: requiredSecretEnvironment("LAUNDRY_BOOTSTRAP_ADMIN_PIN"),
});

type OfflineAcceptanceBridge = Readonly<{
  command: Readonly<{ execute: (input: unknown) => Promise<unknown> }>;
  offline: Readonly<{
    resume: () => Promise<unknown>;
    status: () => Promise<unknown>;
  }>;
}>;

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

function assertAcceptanceInputs(): void {
  const releaseRelative = relative(RELEASE_ROOT, APP_PATH);
  if (
    !isAbsolute(APP_PATH) ||
    releaseRelative.startsWith("..") ||
    isAbsolute(releaseRelative) ||
    !/[/\\]mac-[A-Za-z0-9._-]+[/\\]laundry-desk V2\.app$/u.test(APP_PATH) ||
    !isAbsolute(USER_DATA_PATH) ||
    !isAbsolute(CONFIG_PATH) ||
    dirname(USER_DATA_PATH) !== dirname(CONFIG_PATH) ||
    !/^laundry-acceptance-[a-f0-9]{24}$/u.test(COMPOSE_PROJECT)
  ) {
    throw new Error("Electron acceptance inputs are invalid");
  }
}

async function configurePackagedDownloads(application: ElectronApplication): Promise<void> {
  await mkdir(DOWNLOAD_PATH, { recursive: true, mode: 0o700 });
  await application.evaluate(({ BrowserWindow }, outputDirectory) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) throw new Error("packaged download window is unavailable");
    window.webContents.session.on("will-download", (_event, item) => {
      const filename = item.getFilename();
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u.test(filename)) {
        item.cancel();
        return;
      }
      item.setSavePath(`${outputDirectory}/${filename}`);
    });
  }, DOWNLOAD_PATH);
}

function processGroupExists(processId: number): boolean {
  try {
    process.kill(-processId, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

function signalProcessGroup(processId: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-processId, signal);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}

async function waitForProcessGroupExit(processId: number): Promise<boolean> {
  const deadline = Date.now() + PROCESS_EXIT_GRACE_MS;
  while (Date.now() < deadline) {
    if (!processGroupExists(processId)) return true;
    await delay(50);
  }
  return !processGroupExists(processId);
}

async function terminateProcessGroup(processId: number): Promise<void> {
  signalProcessGroup(processId, "SIGTERM");
  if (await waitForProcessGroupExit(processId)) return;
  signalProcessGroup(processId, "SIGKILL");
  if (!(await waitForProcessGroupExit(processId))) {
    throw new Error("timed-out lifecycle process group did not exit");
  }
}

async function runLifecycle(script: "local:up" | "local:down"): Promise<void> {
  const environment = {
    ...credentialFreeEnvironment(),
    COMPOSE_PROJECT_NAME: COMPOSE_PROJECT,
    LAUNDRY_LOCAL_CONFIG_DIR: CONFIG_PATH,
  };
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn("pnpm", [script], {
      cwd: REPOSITORY_ROOT,
      env: environment,
      detached: true,
      shell: false,
      stdio: "inherit",
    });
    let settled = false;
    let timedOut = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error === undefined) resolveRun();
      else rejectRun(error);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      const processId = child.pid;
      if (processId === undefined) {
        finish(new Error(`${script} timed out before its process group was created`));
        return;
      }
      void terminateProcessGroup(processId).then(
        () => finish(new Error(`${script} timed out after ${COMMAND_TIMEOUT_MS}ms`)),
        () => finish(new Error(`${script} timed out and its process group cleanup failed`)),
      );
    }, COMMAND_TIMEOUT_MS);
    child.once("error", () => finish(new Error(`${script} failed to start`)));
    child.once("exit", (code) => {
      if (timedOut) return;
      if (code === 0) finish();
      else finish(new Error(`${script} exited unsuccessfully`));
    });
  });
}

async function healthState(): Promise<"ready" | "reachable" | "down"> {
  let response: Response;
  try {
    response = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(2_000) });
  } catch {
    return "down";
  }
  if (!response.ok) return "reachable";
  try {
    const body = (await response.json()) as { ok?: unknown; data?: { status?: unknown } };
    return body.ok === true && body.data?.status === "ready" ? "ready" : "reachable";
  } catch {
    return "reachable";
  }
}

async function waitForHealth(expected: "ready" | "down"): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let lastState: "ready" | "reachable" | "down" = "down";
  while (Date.now() < deadline) {
    lastState = await healthState();
    if (lastState === expected) return;
    await delay(250);
  }
  throw new Error(`API health ${expected} timed out; last state was ${lastState}`);
}

async function signIn(page: Page): Promise<void> {
  await page.locator('input[name="org_code"]').fill(LOGIN.orgCode);
  await page.locator('input[name="store_code"]').fill(LOGIN.storeCode);
  await page.locator('input[name="username"]').fill(LOGIN.username);
  await page.locator('input[name="password"]').fill(LOGIN.password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.locator('[data-shell="counter"]')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(LOGIN.displayName, { exact: true })).toBeVisible();
}

async function runPackagedOfflineGrantReplay(
  page: Page,
  rejectionDiagnostics: readonly string[],
): Promise<void> {
  const id = Date.now().toString().slice(-8);
  const customerName = `macOS 离线 ${id}`;
  const authority = await page.evaluate(async () =>
    (
      window as Window & { laundryDesktop?: OfflineAcceptanceBridge }
    ).laundryDesktop?.offline.resume(),
  );
  expect((authority as { ok?: unknown } | undefined)?.ok).toBe(true);
  let offlineEvidence: unknown;
  await runLifecycle("local:down");
  await waitForHealth("down");
  try {
    offlineEvidence = await page.evaluate(
      async ({ name, phone, catalogCode }) => {
        const bridge = (window as Window & { laundryDesktop?: OfflineAcceptanceBridge })
          .laundryDesktop;
        if (bridge === undefined) throw new Error("desktop bridge unavailable");
        const queued = await bridge.command.execute({
          name: "customer.upsert",
          body: { phone, name },
        });
        const denied = await bridge.command.execute({
          name: "catalog.item.upsert",
          body: {
            code: catalogCode,
            name: "Denied offline price",
            service_code: "wash",
            category_code: "offline",
            unit_price_cents: 1,
            is_active: true,
          },
        });
        return { queued, denied, status: await bridge.offline.status() };
      },
      { name: customerName, phone: `136${id}`, catalogCode: `denied_${id}` },
    );
  } finally {
    await runLifecycle("local:up");
    await waitForHealth("ready");
  }
  await delay(50);
  expect(
    offlineEvidence,
    `offline queue rejection diagnostics: ${rejectionDiagnostics.join(",") || "none"}`,
  ).toMatchObject({
    queued: { ok: true, data: { result: { offline_queued: true } } },
    denied: { ok: false, error: { code: "RESOURCE_UNAVAILABLE" } },
    status: { ok: true, data: { pending_count: 1, inflight_count: 0, conflicts: [] } },
  });
  await expectReplayDrained(page);
  await page.locator('[data-nav-id="customers"]').click();
  await page.locator('[data-testid="customers-search-input"]').fill(customerName);
  await page.locator('[data-testid="customers-search-btn"]').click();
  await expect(
    page.locator('[data-testid="customers-row"]', { hasText: customerName }),
  ).toHaveCount(1, { timeout: 15_000 });
}

async function expectReplayDrained(page: Page): Promise<void> {
  const resumed = await page.evaluate(async () =>
    (
      window as Window & { laundryDesktop?: OfflineAcceptanceBridge }
    ).laundryDesktop?.offline.resume(),
  );
  expect(resumed).toMatchObject({ ok: true, data: { mode: "online" } });
  const status = await page.evaluate(async () =>
    (
      window as Window & { laundryDesktop?: OfflineAcceptanceBridge }
    ).laundryDesktop?.offline.status(),
  );
  expect(status).toMatchObject({
    ok: true,
    data: { pending_count: 0, inflight_count: 0, conflicts: [] },
  });
}

async function auditDesktopBridge(page: Page): Promise<void> {
  const audit = await page.evaluate(async () => {
    type Bridge = Readonly<{
      auth: Readonly<{
        refresh: () => Promise<unknown>;
        logout: () => Promise<unknown>;
      }>;
      command: Readonly<{ execute: (...args: unknown[]) => Promise<unknown> }>;
      query: Readonly<{ execute: (...args: unknown[]) => Promise<unknown> }>;
      photo: Readonly<{
        upload: (...args: unknown[]) => Promise<unknown>;
        read: (...args: unknown[]) => Promise<unknown>;
        delete: (...args: unknown[]) => Promise<unknown>;
      }>;
      offline: Readonly<{
        resume: () => Promise<unknown>;
        status: () => Promise<unknown>;
        resolve: (...args: unknown[]) => Promise<unknown>;
      }>;
      printer: Readonly<{
        discover: () => Promise<unknown>;
        status: () => Promise<unknown>;
        configure: (...args: unknown[]) => Promise<unknown>;
        test: () => Promise<unknown>;
      }>;
      health: Readonly<{ get: () => Promise<unknown> }>;
    }>;
    const bridge = (window as Window & { laundryDesktop?: Bridge }).laundryDesktop;
    if (bridge === undefined) return { bridgeValid: false };
    const forbidden = /token|cookie|headers?|authorization/iu;
    const containsCredentialKey = (value: unknown): boolean => {
      const pending = [value];
      const seen = new WeakSet<object>();
      while (pending.length > 0) {
        const current = pending.pop();
        if (current === null || typeof current !== "object" || seen.has(current)) continue;
        seen.add(current);
        for (const [key, child] of Object.entries(current)) {
          if (forbidden.test(key)) return true;
          pending.push(child);
        }
      }
      return false;
    };
    const refresh = await bridge.auth.refresh();
    const logout = await bridge.auth.logout();
    return {
      bridgeValid:
        JSON.stringify(Object.keys(bridge).sort()) ===
          JSON.stringify(["auth", "command", "health", "offline", "photo", "printer", "query"]) &&
        JSON.stringify(Object.keys(bridge.auth).sort()) ===
          JSON.stringify([
            "credentialComplete",
            "login",
            "logout",
            "pinChallenge",
            "pinVerify",
            "refresh",
          ]) &&
        Object.keys(bridge.command).join() === "execute" &&
        Object.keys(bridge.query).join() === "execute" &&
        JSON.stringify(Object.keys(bridge.photo).sort()) ===
          JSON.stringify(["delete", "read", "upload"]) &&
        JSON.stringify(Object.keys(bridge.offline).sort()) ===
          JSON.stringify(["resolve", "resume", "status"]) &&
        JSON.stringify(Object.keys(bridge.printer).sort()) ===
          JSON.stringify(["configure", "discover", "status", "test"]) &&
        Object.keys(bridge.health).join() === "get",
      refreshOk:
        !containsCredentialKey(refresh) &&
        JSON.stringify(Object.keys(refresh as object).sort()) === JSON.stringify(["data", "ok"]) &&
        (refresh as { ok?: unknown }).ok === true,
      logoutOk:
        !containsCredentialKey(logout) &&
        (logout as { ok?: unknown; data?: { logged_out?: unknown } }).ok === true &&
        (logout as { data?: { logged_out?: unknown } }).data?.logged_out === true,
    };
  });
  expect(audit).toEqual({ bridgeValid: true, refreshOk: true, logoutOk: true });
}

test.describe.serial("packaged Counter product parity", () => {
  let application: ElectronApplication | null = null;
  let page: Page | null = null;
  let lifecycleOwned = false;
  const rejectionDiagnostics: string[] = [];
  const activePage = (): Page => {
    if (page === null) throw new Error("packaged application is not ready");
    return page;
  };

  test.afterAll(async () => {
    try {
      await application?.close();
    } finally {
      if (lifecycleOwned) {
        await runLifecycle("local:down");
        await waitForHealth("down");
      }
    }
  });

  test("recovers from an unavailable local service and signs in", async () => {
    assertAcceptanceInputs();
    const canonicalApp = await realpath(APP_PATH);
    const executablePath = join(canonicalApp, "Contents", "MacOS", "laundry-desk V2");
    await access(executablePath);
    application = await electron.launch({
      acceptDownloads: true,
      executablePath,
      args: [`--user-data-dir=${USER_DATA_PATH}`, "--use-mock-keychain"],
      env: {
        ...credentialFreeEnvironment(),
        LAUNDRY_ACCEPTANCE_DIAGNOSTICS: "offline_queue",
      },
    });
    const captureDiagnostics = (chunk: Buffer | string): void => {
      for (const match of chunk.toString().matchAll(/\[edge-agent\] offline diagnostic (\w+)/gu)) {
        if (match[1] !== undefined) rejectionDiagnostics.push(match[1]);
      }
    };
    application.process().stdout?.on("data", captureDiagnostics);
    application.process().stderr?.on("data", captureDiagnostics);
    page = await application.firstWindow();
    await configurePackagedDownloads(application);
    await expect(activePage().getByRole("heading", { name: "本地服务尚未就绪" })).toBeVisible({
      timeout: 15_000,
    });
    lifecycleOwned = true;
    await runLifecycle("local:up");
    await waitForHealth("ready");
    await activePage().getByRole("button", { name: "重试" }).click();
    await expect(activePage().locator('[data-page="login"]')).toBeVisible({ timeout: 15_000 });
    await signIn(activePage());
  });

  test("orders cover hold, cancel, repayment and fulfillment barcode verification", async () => {
    test.setTimeout(300_000);
    await runPackagedOrderParity(activePage());
  });

  test("members cover tiers, refund, freeze, unfreeze, close and privacy", async () => {
    test.setTimeout(300_000);
    await runPackagedMemberParity(activePage(), LOGIN, DOWNLOAD_PATH);
  });

  test("reminders, accounting and shift reports export verified CSV", async () => {
    test.setTimeout(240_000);
    await runPackagedReportsParity(activePage(), DOWNLOAD_PATH);
  });

  test("settings exposes the current packaged product surface", async () => {
    test.setTimeout(120_000);
    await runPackagedSettingsParity(activePage(), LOGIN);
  });

  test("ordinary offline grants replay without widening denied commands", async () => {
    test.setTimeout(420_000);
    await runPackagedOfflineGrantReplay(activePage(), rejectionDiagnostics);
  });

  test("the token-free desktop bridge exposes only named capabilities", async () => {
    await auditDesktopBridge(activePage());
  });
});
