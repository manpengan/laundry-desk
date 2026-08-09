import { spawn } from "node:child_process";
import { access, realpath } from "node:fs/promises";
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
const VALID_JPEG = Buffer.from(
  "/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAACAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAABf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AIgAAaf/2Q==",
  "base64",
);

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
const MAC_CATALOG = Object.freeze({
  code: "mac_wash_shirt",
  name: "macOS 水洗衬衫",
  service: "wash",
  category: "macshirt",
  priceCents: "1500",
});
const MAC_MEMBER = Object.freeze({
  phone: "13900000042",
  name: "macOS 顾客",
  topupYuan: "50",
  remainingBalance: "¥35.00",
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

/**
 * Same counter money path the browser E2E proves, driven inside the packaged
 * app. The SPA and contracts are shared, so what this adds is evidence that the
 * desktop IPC transport carries a real workday — not just a login.
 *
 * Bootstrapping the price list is part of it: a fresh install ships an empty
 * catalog and order.receive refuses a line that matches no active item.
 */
async function runCounterWorkday(page: Page): Promise<void> {
  await page.locator('[data-nav-id="settings"]').click();
  const catalogPanel = page.locator('[data-testid="catalog-admin"]');
  await expect(catalogPanel).toBeVisible({ timeout: 15_000 });
  await page.locator('input[name="catalog-code"]').fill(MAC_CATALOG.code);
  await page.locator('input[name="catalog-name"]').fill(MAC_CATALOG.name);
  await page.locator('input[name="catalog-service"]').fill(MAC_CATALOG.service);
  await page.locator('input[name="catalog-category"]').fill(MAC_CATALOG.category);
  await page.locator('input[name="catalog-price"]').fill(MAC_CATALOG.priceCents);
  await page.locator('[data-testid="catalog-save-btn"]').click();
  await expect(
    catalogPanel.locator('[data-testid="catalog-admin-row"]', { hasText: MAC_CATALOG.name }),
  ).toBeVisible({ timeout: 15_000 });

  // Receive two garments at ¥15.00 paying ¥10.00, leaving ¥20.00 owed.
  await page.locator('[data-nav-id="receive"]').click();
  const picker = page.locator('[data-testid="catalog-picker"]');
  await expect(picker).toBeVisible();
  await picker.getByRole("option", { name: new RegExp(MAC_CATALOG.name, "u") }).click();
  await page.getByLabel("数量").fill("2");
  await page.locator('input[name="customer-phone"]').fill(MAC_MEMBER.phone);
  await page.locator('input[name="customer-name"]').fill(MAC_MEMBER.name);
  await page.locator('input[name="initial-payment"]').fill("1000");
  await page.getByRole("button", { name: "确认开单" }).click();

  const ticketCell = page.locator('[data-testid="receive-ticket"]');
  await expect(ticketCell).toBeVisible({ timeout: 15_000 });
  const ticketNo = (await ticketCell.innerText()).trim();
  const receiveResult = page.locator(".ld-order-result");
  await expect(receiveResult).toContainText("¥30.00");
  await expect(receiveResult).toContainText("¥20.00");

  // Upload one real photo through the named desktop IPC capability and verify
  // that reopening the server-backed order shows the durable metadata.
  await page.locator('[data-nav-id="orders"]').click();
  await page.locator('[data-testid="debt-load-btn"]').click();
  const debtRow = page.locator('[data-testid="debt-row"]').filter({ hasText: ticketNo }).first();
  await expect(debtRow).toBeVisible({ timeout: 15_000 });
  await debtRow.locator('[data-testid="debt-row-detail-btn"]').click();
  const drawer = page.locator('[data-testid="order-detail-drawer"]');
  await drawer.locator('[data-testid="order-detail-register-photo-btn"]').setInputFiles({
    name: "mac-receive.jpg",
    mimeType: "image/jpeg",
    buffer: VALID_JPEG,
  });
  await expect(drawer.locator('[data-testid="order-detail-photo-count"]')).toHaveText("1 张", {
    timeout: 15_000,
  });
  await drawer.locator('[data-testid="order-detail-close-btn"]').click();

  // Pick up, collecting the remainder.
  await page.locator('[data-nav-id="pickup"]').click();
  await page.locator('input[name="pickup-key"]').fill(ticketNo);
  await page.getByRole("button", { name: "加载订单" }).click();
  await expect(page.locator('[data-testid="pickup-loaded-ticket"]')).toHaveText(ticketNo, {
    timeout: 15_000,
  });
  await expect(page.locator('[data-testid="pickup-loaded-balance"]')).toContainText("¥20.00");
  await page.locator('input[name="collect-cents"]').fill("2000");
  await page.getByRole("button", { name: "确认取衣" }).click();

  await expect(page.locator('[data-testid="pickup-ticket"]')).toHaveText(ticketNo, {
    timeout: 15_000,
  });
  const pickupResult = page.locator(".ld-order-result").last();
  await expect(pickupResult).toContainText("¥30.00");
  await expect(pickupResult).toContainText("¥0.00");
}

async function selectMacMember(page: Page): Promise<void> {
  await page.locator('[data-testid="customers-search-input"]').fill(MAC_MEMBER.name);
  await page.locator('[data-testid="customers-search-btn"]').click();
  const customer = page.locator('[data-testid="customers-row"]', { hasText: MAC_MEMBER.name });
  await expect(customer).toHaveCount(1, { timeout: 15_000 });
  await customer.click();
  await expect(page.locator('[aria-label="会员储值"]')).toBeVisible({ timeout: 15_000 });
}

async function openAndTopupMacMember(page: Page): Promise<void> {
  await page.locator('[data-nav-id="customers"]').click();
  await selectMacMember(page);
  const memberPanel = page.locator('[aria-label="会员储值"]');
  await expect(memberPanel.getByText("尚未开通会员")).toBeVisible({ timeout: 15_000 });
  await memberPanel.getByRole("button", { name: "开通会员账户" }).click();
  await expect(page.locator(".ld-toast").last()).toContainText("会员账户已开通", {
    timeout: 15_000,
  });
  await expect(memberPanel).toContainText("¥0.00", { timeout: 15_000 });

  await memberPanel.getByLabel("充值金额（元）").fill(MAC_MEMBER.topupYuan);
  await memberPanel.getByRole("button", { name: "充值", exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: "确认会员充值" });
  await expect(confirmation).toContainText("充值本金 ¥50.00", { timeout: 15_000 });
  await confirmation.getByRole("button", { name: "确认充值" }).click();
  await expect(page.locator(".ld-toast").last()).toContainText("充值已入账", {
    timeout: 15_000,
  });
  await expect(memberPanel).toContainText("¥50.00", { timeout: 15_000 });
  await expect(memberPanel).toContainText("充值");
}

async function createUnpaidMacMemberOrder(page: Page): Promise<string> {
  await page.locator('[data-nav-id="receive"]').click();
  const picker = page.locator('[data-testid="catalog-picker"]');
  await picker.getByRole("option", { name: new RegExp(MAC_CATALOG.name, "u") }).click();
  await page.locator('input[name="customer-phone"]').fill(MAC_MEMBER.phone);
  await page.locator('input[name="customer-name"]').fill(MAC_MEMBER.name);
  await page.getByRole("button", { name: "确认开单" }).click();
  const ticketNo = (await page.locator('[data-testid="receive-ticket"]').innerText()).trim();
  await expect(page.locator(".ld-order-result")).toContainText("¥15.00");
  return ticketNo;
}

async function settleMacOrderFromBalance(page: Page, ticketNo: string): Promise<void> {
  await page.locator('[data-nav-id="orders"]').click();
  await page.locator('[data-testid="debt-load-btn"]').click();
  const debtRow = page.locator('[data-testid="debt-row"]', { hasText: ticketNo });
  await expect(debtRow).toBeVisible({ timeout: 15_000 });
  await debtRow.locator('[data-testid="debt-row-detail-btn"]').click();
  const drawer = page.locator('[data-testid="order-detail-drawer"]');
  await drawer.locator('[data-testid="order-detail-payment-btn"]').click();
  const payment = page.locator('[data-testid="payment-collection-dialog"]');
  const method = payment.getByLabel("付款方式");
  await expect(method.getByRole("option", { name: "会员余额" })).toHaveCount(1, {
    timeout: 15_000,
  });
  await method.selectOption({ label: "会员余额" });
  await expect(payment).toContainText("会员可用余额 ¥50.00");
  await page.getByRole("button", { name: "确认收款" }).click();
  await expect(page.locator(".ld-toast").last()).toContainText("已从会员余额扣款", {
    timeout: 15_000,
  });
  await expect(drawer.locator('[data-testid="order-detail-balance"]')).toContainText("¥0.00", {
    timeout: 15_000,
  });
  await drawer.locator('[data-testid="order-detail-close-btn"]').click();
}

async function assertMacMemberSettlement(page: Page): Promise<void> {
  await page.locator('[data-nav-id="customers"]').click();
  await selectMacMember(page);
  await expect(page.locator('[aria-label="会员储值"]')).toContainText(MAC_MEMBER.remainingBalance, {
    timeout: 15_000,
  });

  await page.locator('[data-nav-id="stats"]').click();
  await page.locator('[data-testid="stats-load-btn"]').click();
  const snapshot = page.locator('[data-testid="reconciliation-snapshot"]');
  await expect(snapshot).toBeVisible({ timeout: 15_000 });
  const balanceBucket = snapshot.getByRole("row").filter({ hasText: "会员余额" });
  await expect(balanceBucket).toHaveCount(1);
  await expect(balanceBucket).toContainText("收款");
  await expect(balanceBucket).toContainText("¥15.00");
}

/** Prove the packaged SPA contains the latest stored-value counter slice. */
async function runPackagedMemberSettlement(page: Page): Promise<void> {
  await openAndTopupMacMember(page);
  const ticketNo = await createUnpaidMacMemberOrder(page);
  await settleMacOrderFromBalance(page, ticketNo);
  await assertMacMemberSettlement(page);
}

/** Prove a packaged Edge queues an ordinary grant command and never widens denied commands. */
async function runPackagedOfflineGrantReplay(
  page: Page,
  rejectionDiagnostics: readonly string[],
): Promise<void> {
  const suffix = Date.now().toString().slice(-8);
  const customerName = `macOS 离线 ${suffix}`;
  const customerPhone = `136${suffix}`;
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
      { name: customerName, phone: customerPhone, catalogCode: `denied_${suffix}` },
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

  await page.locator('[data-nav-id="customers"]').click();
  await page.locator('[data-testid="customers-search-input"]').fill(customerName);
  await page.locator('[data-testid="customers-search-btn"]').click();
  await expect(
    page.locator('[data-testid="customers-row"]', { hasText: customerName }),
  ).toHaveCount(1, { timeout: 15_000 });
}

async function runPackagedGovernanceSmoke(page: Page): Promise<void> {
  const suffix = Date.now().toString().slice(-8);
  const duplicateName = `macOS 合并 ${suffix}`;
  await page.locator('[data-nav-id="customers"]').click();

  for (const prefix of ["137", "138"]) {
    await page.locator('[data-testid="customers-phone-input"]').fill(`${prefix}${suffix}`);
    await page.locator('[data-testid="customers-name-input"]').fill(duplicateName);
    await page.locator('[data-testid="customers-upsert-btn"]').click();
    await expect(page.locator(".ld-toast").last()).toContainText("客户已保存", {
      timeout: 15_000,
    });
  }

  await page.locator('[data-testid="customers-search-input"]').fill(duplicateName);
  await page.locator('[data-testid="customers-search-btn"]').click();
  const matches = page.locator('[data-testid="customers-row"]', { hasText: duplicateName });
  await expect(matches).toHaveCount(2, { timeout: 15_000 });
  await matches.first().click();
  const governance = page.locator('[aria-label="客户资料治理"]');
  await governance.getByRole("button", { name: "检查重复" }).click();
  await expect(governance.getByLabel("保留客户")).toHaveCount(1, { timeout: 15_000 });
  await governance.locator('input[name="customer-merge-reason"]').fill("packaged macOS E2E");
  await governance.getByRole("button", { name: "合并到保留客户" }).click();
  await page.locator(".ld-step-up__select").selectOption({ label: "E2E Staff Two（店长）" });
  await page.locator('input[name="step-up-pin"]').fill(LOGIN.pin);
  await page.getByRole("button", { name: "确认 PIN" }).click();
  await expect(matches).toHaveCount(1, { timeout: 15_000 });

  await page.locator('[data-nav-id="stats"]').click();
  await page.locator('[data-testid="stats-date-input"]').fill("1999-12-30");
  await page.locator('[data-testid="stats-load-btn"]').click();
  const reconciliation = page.locator(
    '[data-testid="reconciliation-snapshot"][data-business-date="1999-12-30"]',
  );
  await expect(reconciliation).toBeVisible({ timeout: 15_000 });
  await expect(reconciliation.getByRole("heading", { name: "支付账本" })).toBeVisible();
  await page.getByRole("button", { name: "查询历史" }).click();
  await expect(page.getByRole("cell", { name: "1999-12-30" })).toBeVisible({ timeout: 15_000 });
}

test("packaged app recovers from an unavailable local service with a token-free bridge", async () => {
  assertAcceptanceInputs();
  const canonicalApp = await realpath(APP_PATH);
  const executablePath = join(canonicalApp, "Contents", "MacOS", "laundry-desk V2");
  await access(executablePath);
  let application: ElectronApplication | null = null;
  const rejectionDiagnostics: string[] = [];
  try {
    application = await electron.launch({
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

    await runCounterWorkday(page);
    await runPackagedMemberSettlement(page);
    await runPackagedOfflineGrantReplay(page, rejectionDiagnostics);
    await runPackagedGovernanceSmoke(page);

    const audit = await page.evaluate(async () => {
      const bridge = (
        window as Window & {
          laundryDesktop?: {
            auth: { refresh: () => Promise<unknown>; logout: () => Promise<unknown> };
            command: { execute: (...args: unknown[]) => Promise<unknown> };
            query: { execute: (...args: unknown[]) => Promise<unknown> };
            photo: {
              upload: (...args: unknown[]) => Promise<unknown>;
              read: (...args: unknown[]) => Promise<unknown>;
              delete: (...args: unknown[]) => Promise<unknown>;
            };
            offline: {
              resume: () => Promise<unknown>;
              status: () => Promise<unknown>;
              resolve: (...args: unknown[]) => Promise<unknown>;
            };
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
            JSON.stringify(["auth", "command", "health", "offline", "photo", "query"]) &&
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
