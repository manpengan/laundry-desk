import { spawn } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";

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

const APP_PATH = requiredEnvironment("LAUNDRY_MAC_APP_PATH");
const USER_DATA_PATH = requiredEnvironment("LAUNDRY_MAC_USER_DATA_DIR");
const CONFIG_PATH = requiredEnvironment("LAUNDRY_LOCAL_CONFIG_DIR");
const COMPOSE_PROJECT = requiredEnvironment("COMPOSE_PROJECT_NAME");
const LOGIN = Object.freeze({
  orgCode: requiredEnvironment("LAUNDRY_LOCAL_ORG_CODE"),
  storeCode: requiredEnvironment("LAUNDRY_LOCAL_STORE_CODE"),
  username: requiredEnvironment("LAUNDRY_BOOTSTRAP_ADMIN_USERNAME"),
  displayName: requiredEnvironment("LAUNDRY_BOOTSTRAP_ADMIN_DISPLAY_NAME"),
  password: requiredEnvironment("LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD"),
});
requiredEnvironment("LAUNDRY_BOOTSTRAP_ADMIN_PIN");

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
    const body = (await response.json()) as {
      ok?: unknown;
      data?: { status?: unknown };
    };
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
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`API health ${expected} timed out; last state was ${lastState}`);
}

test("packaged app recovers from an unavailable local service with a token-free bridge", async () => {
  assertAcceptanceInputs();
  const canonicalApp = await realpath(APP_PATH);
  const executablePath = join(canonicalApp, "Contents", "MacOS", "laundry-desk V2");
  await access(executablePath);
  let application: ElectronApplication | null = null;

  try {
    application = await electron.launch({
      executablePath,
      args: [`--user-data-dir=${USER_DATA_PATH}`],
      env: credentialFreeEnvironment(),
    });
    const page = await application.firstWindow();
    await expect(page.getByRole("heading", { name: "本地服务尚未就绪" })).toBeVisible({
      timeout: 15_000,
    });

    await runLifecycle("local:up");
    await waitForHealth("ready");
    await page.getByRole("button", { name: "重试" }).click();
    await expect(page.locator('[data-page="login"]')).toBeVisible({ timeout: 15_000 });

    await page.locator('input[name="org_code"]').fill(LOGIN.orgCode);
    await page.locator('input[name="store_code"]').fill(LOGIN.storeCode);
    await page.locator('input[name="username"]').fill(LOGIN.username);
    await page.locator('input[name="password"]').fill(LOGIN.password);
    await page.getByRole("button", { name: "登录" }).click();
    await expect(page.locator('[data-shell="counter"]')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(LOGIN.displayName, { exact: true })).toBeVisible();

    const audit = await page.evaluate(async () => {
      const bridge = (
        window as Window & {
          laundryDesktop?: {
            auth: { refresh: () => Promise<unknown>; logout: () => Promise<unknown> };
            command: { execute: (...args: unknown[]) => Promise<unknown> };
            query: { execute: (...args: unknown[]) => Promise<unknown> };
            health: { get: () => Promise<unknown> };
          };
        }
      ).laundryDesktop;
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
            JSON.stringify(["auth", "command", "health", "query"]) &&
          JSON.stringify(Object.keys(bridge.auth).sort()) ===
            JSON.stringify(["login", "logout", "pinChallenge", "pinVerify", "refresh"]) &&
          Object.keys(bridge.command).join() === "execute" &&
          Object.keys(bridge.query).join() === "execute" &&
          Object.keys(bridge.health).join() === "get",
        refreshOk:
          !containsCredentialKey(refresh) &&
          JSON.stringify(Object.keys(refresh as object).sort()) ===
            JSON.stringify(["data", "ok"]) &&
          (refresh as { ok?: unknown }).ok === true,
        logoutOk:
          !containsCredentialKey(logout) &&
          (logout as { ok?: unknown; data?: { logged_out?: unknown } }).ok === true &&
          (logout as { data?: { logged_out?: unknown } }).data?.logged_out === true,
      };
    });
    expect(audit).toEqual({ bridgeValid: true, refreshOk: true, logoutOk: true });
  } finally {
    try {
      await application?.close();
    } finally {
      await runLifecycle("local:down");
      await waitForHealth("down");
    }
  }
});
