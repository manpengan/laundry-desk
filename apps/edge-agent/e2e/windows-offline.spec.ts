import { randomInt, randomUUID } from "node:crypto";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import {
  DesktopCommandExecuteResultSchema,
  DesktopOfflineResumeResultSchema,
  DesktopOfflineStatusResultSchema,
  DesktopQueryExecuteResultSchema,
} from "@laundry/contracts";
import { z } from "zod";

import { fillWindowsCredential, loadWindowsRuntimeCredentials } from "./windows-credentials.mjs";
import {
  acceptanceEnvironment,
  bindOfflineRuntime,
  installedExecutable,
  sealedQueueSnapshot,
  waitForRuntimeHealth,
} from "./windows-offline-runtime.js";

type Operation = "command" | "query" | "resume" | "status";
type Bridge = Readonly<{
  command: Readonly<{ execute: (input: unknown) => Promise<unknown> }>;
  query: Readonly<{ execute: (input: unknown) => Promise<unknown> }>;
  offline: Readonly<{ resume: () => Promise<unknown>; status: () => Promise<unknown> }>;
}>;

const CustomerRows = z.strictObject({
  customers: z
    .array(
      z.strictObject({
        customer_id: z.uuid(),
        phone_masked: z.string().max(32),
        name: z.string().max(64).nullable(),
        version: z.number().int().positive(),
        updated_at: z.number().int().nonnegative(),
      }),
    )
    .max(20),
});

async function desktop(page: Page, operation: Operation, input: unknown = null): Promise<unknown> {
  return await page.evaluate(
    async ({ operation, input }) => {
      const raw = (window as Window & { laundryDesktop?: unknown }).laundryDesktop;
      const exactFunctions = (value: unknown, fields: readonly string[]): boolean => {
        if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
        return (
          Reflect.ownKeys(value).length === fields.length &&
          fields.every(
            (field) => typeof Object.getOwnPropertyDescriptor(value, field)?.value === "function",
          )
        );
      };
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new Error("WINDOWS_OFFLINE_BRIDGE_UNAVAILABLE");
      }
      const command = Object.getOwnPropertyDescriptor(raw, "command")?.value as unknown;
      const query = Object.getOwnPropertyDescriptor(raw, "query")?.value as unknown;
      const offline = Object.getOwnPropertyDescriptor(raw, "offline")?.value as unknown;
      if (
        !exactFunctions(command, ["execute"]) ||
        !exactFunctions(query, ["execute"]) ||
        !exactFunctions(offline, ["resume", "status", "resolve"])
      ) {
        throw new Error("WINDOWS_OFFLINE_BRIDGE_UNAVAILABLE");
      }
      const bridge = raw as Bridge;
      if (operation === "command") return await bridge.command.execute(input);
      if (operation === "query") return await bridge.query.execute(input);
      if (operation === "resume") return await bridge.offline.resume();
      return await bridge.offline.status();
    },
    { operation, input },
  );
}

async function queueCount(page: Page, expected: number): Promise<void> {
  const parsed = DesktopOfflineStatusResultSchema.safeParse(await desktop(page, "status"));
  if (!parsed.success) throw new Error("WINDOWS_OFFLINE_STATUS_INVALID");
  expect(parsed.data).toEqual({
    ok: true,
    data: {
      pending_count: expected,
      inflight_count: 0,
      conflicts: [],
    },
  });
}

async function resumeOnline(page: Page): Promise<void> {
  const parsed = DesktopOfflineResumeResultSchema.safeParse(await desktop(page, "resume"));
  if (!parsed.success) throw new Error("WINDOWS_OFFLINE_RESUME_INVALID");
  expect(parsed.data.ok).toBe(true);
  if (!parsed.data.ok) throw new Error("WINDOWS_OFFLINE_RESUME_REJECTED");
  expect(parsed.data.data.mode).toBe("online");
}

async function customerRows(page: Page, name: string) {
  const parsed = DesktopQueryExecuteResultSchema.safeParse(
    await desktop(page, "query", {
      name: "customer.search",
      body: { query: name, limit: 20 },
    }),
  );
  if (!parsed.success || !parsed.data.ok) throw new Error("WINDOWS_OFFLINE_CUSTOMER_QUERY_FAILED");
  const rows = CustomerRows.safeParse(parsed.data.data.result);
  if (!rows.success) throw new Error("WINDOWS_OFFLINE_CUSTOMER_QUERY_INVALID");
  return rows.data.customers;
}

async function assertDenied(page: Page, input: unknown): Promise<void> {
  const parsed = DesktopCommandExecuteResultSchema.safeParse(await desktop(page, "command", input));
  if (!parsed.success) throw new Error("WINDOWS_OFFLINE_COMMAND_INVALID");
  expect(parsed.data.ok).toBe(false);
  if (parsed.data.ok) throw new Error("WINDOWS_OFFLINE_FORBIDDEN_WRITE_ACCEPTED");
  expect(parsed.data.error.code).toBe("RESOURCE_UNAVAILABLE");
}

async function assertNativeStorage(application: ElectronApplication): Promise<void> {
  const native = await application.evaluate(({ app, safeStorage }) => ({
    packaged: app.isPackaged,
    platform: process.platform,
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
  }));
  expect(native).toEqual({ packaged: true, platform: "win32", encryptionAvailable: true });
}

async function normalClose(application: ElectronApplication): Promise<void> {
  const closed = application.waitForEvent("close", { timeout: 15_000 });
  await application.evaluate(({ BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows();
    if (windows.length !== 1 || windows[0] === undefined)
      throw new Error("WINDOWS_OFFLINE_WINDOW_INVALID");
    setImmediate(() => windows[0]!.close());
  });
  await closed;
}

test("installed Windows DPAPI queue survives an offline restart and replays exactly once", async () => {
  expect(process.platform).toBe("win32");
  const runtime = await bindOfflineRuntime();
  const executable = await installedExecutable();
  const credentials = await loadWindowsRuntimeCredentials();
  await waitForRuntimeHealth("ready");
  const userData = await mkdtemp(join(await realpath(tmpdir()), "laundry-win-offline-"));
  const customerName = `Windows 离线 ${randomUUID().slice(0, 12)}`;
  const phone = `136${String(randomInt(0, 100_000_000)).padStart(8, "0")}`;
  const deniedCatalog = {
    name: "catalog.item.upsert",
    body: {
      code: `denied_${randomUUID().slice(0, 8)}`,
      name: "Denied offline price",
      service_code: "wash",
      category_code: "offline",
      unit_price_cents: 1,
      is_active: true,
    },
  };
  let application: ElectronApplication | null = null;
  let beforeSnapshot: Awaited<ReturnType<typeof sealedQueueSnapshot>> | null = null;
  let afterSnapshot: Awaited<ReturnType<typeof sealedQueueSnapshot>> | null = null;
  let runtimeNeedsStart = false;
  const launch = async (): Promise<ElectronApplication> =>
    await electron.launch({
      executablePath: executable,
      args: [`--user-data-dir=${userData}`],
      env: acceptanceEnvironment(),
    });

  try {
    application = await launch();
    let page = await application.firstWindow();
    await page.waitForURL("app://local/index.html", { timeout: 20_000 });
    expect(page.url()).toBe("app://local/index.html");
    await assertNativeStorage(application);
    await expect(page.locator('[data-page="login"]')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('input[name="org_code"], input[name="store_code"]')).toHaveCount(0);
    await fillWindowsCredential(page.locator('input[name="username"]'), credentials.adminUsername);
    await fillWindowsCredential(page.locator('input[name="password"]'), credentials.adminPassword);
    await page.getByRole("button", { name: "登录" }).click();
    await expect(page.locator('[data-shell="counter"]')).toBeVisible({ timeout: 20_000 });
    await resumeOnline(page);
    expect(await customerRows(page, customerName)).toEqual([]);
    await queueCount(page, 0);

    // Restore after ordinary failures only while the controller has confirmed its lifecycle actions.
    runtimeNeedsStart = true;
    await runtime.action("stop");
    await waitForRuntimeHealth("down");
    const queued = DesktopCommandExecuteResultSchema.safeParse(
      await desktop(page, "command", {
        name: "customer.upsert",
        body: { phone, name: customerName },
      }),
    );
    if (!queued.success) throw new Error("WINDOWS_OFFLINE_QUEUED_RESULT_INVALID");
    expect(queued.data).toMatchObject({ ok: true, data: { result: { offline_queued: true } } });
    await assertDenied(page, deniedCatalog);
    await queueCount(page, 1);
    await normalClose(application);
    application = null;
    beforeSnapshot = await sealedQueueSnapshot(userData, [customerName, phone]);

    application = await launch();
    page = await application.firstWindow();
    await page.waitForURL("app://local/index.html", { timeout: 20_000 });
    expect(page.url()).toBe("app://local/index.html");
    await assertNativeStorage(application);
    // Boot may resume a read-only cache or show the service gate. IPC status remains observable.
    await queueCount(page, 1);
    await assertDenied(page, {
      name: "customer.upsert",
      body: {
        phone: `137${phone.slice(3)}`,
        name: "Denied after offline restart",
      },
    });
    await assertDenied(page, deniedCatalog);
    await queueCount(page, 1);
    afterSnapshot = await sealedQueueSnapshot(userData, [customerName, phone]);
    expect(beforeSnapshot.queue.equals(afterSnapshot.queue)).toBe(true);
    expect(beforeSnapshot.key.equals(afterSnapshot.key)).toBe(true);

    await runtime.action("start");
    await waitForRuntimeHealth("ready");
    runtimeNeedsStart = false;
    await resumeOnline(page);
    await queueCount(page, 0);
    await resumeOnline(page);
    await queueCount(page, 0);
    const persisted = await customerRows(page, customerName);
    expect(persisted.length).toBe(1);
    expect(persisted[0]?.name).toBe(customerName);
    expect(persisted[0]?.version).toBe(1);
    // Reload applies the online resume view to the ordinary UI without creating another command.
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator('[data-shell="counter"]')).toBeVisible({ timeout: 20_000 });
    await page.locator('[data-nav-id="customers"]').click();
    await page.locator('[data-testid="customers-search-input"]').fill(customerName);
    await page.locator('[data-testid="customers-search-btn"]').click();
    await expect(
      page.locator('[data-testid="customers-row"]', { hasText: customerName }),
    ).toHaveCount(1, { timeout: 20_000 });
    await normalClose(application);
    application = null;
  } finally {
    try {
      if (runtimeNeedsStart) {
        if (runtime.recoveryRequired()) throw new Error("WINDOWS_OFFLINE_RECOVERY_REQUIRED");
        await runtime.action("start");
        await waitForRuntimeHealth("ready");
      }
    } finally {
      try {
        await application?.close();
      } finally {
        for (const snapshot of [beforeSnapshot, afterSnapshot]) {
          snapshot?.queue.fill(0);
          snapshot?.key.fill(0);
        }
        // Retain this exclusive synthetic userData for recovery; never delete an uncertain process's state.
      }
    }
  }
});
