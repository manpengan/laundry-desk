import { randomBytes, randomInt } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { inspectPrivateFile, securePrivateFile } from "@laundry/platform-fs";

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
const ORG_CODE = "local";
const STORE_CODE = "main";
const WRONG_PASSWORD_PROBE = "intentionally-wrong-windows-qa-password";

type BootstrapCredentials = Readonly<{
  adminUsername: string;
  adminDisplayName: string;
  adminPassword: string;
  adminPin: string;
  approverDisplayName: string;
  approverPin: string;
}>;

type FunctionalAccount = Readonly<{
  username: string;
  displayName: string;
  password: string;
  pin: string;
}>;

type NavigationCheck = Readonly<{
  id: string;
  heading: string;
  level: 1 | 2;
}>;

const NAVIGATION_CHECKS: readonly NavigationCheck[] = Object.freeze([
  Object.freeze({ id: "workbench", heading: "工作台", level: 1 }),
  Object.freeze({ id: "receive", heading: "开单", level: 1 }),
  Object.freeze({ id: "pickup", heading: "取衣", level: 1 }),
  Object.freeze({ id: "delivery", heading: "取送订单", level: 1 }),
  Object.freeze({ id: "fulfillment", heading: "生产工作台", level: 1 }),
  Object.freeze({ id: "orders", heading: "欠款", level: 2 }),
  Object.freeze({ id: "customers", heading: "客户", level: 1 }),
  Object.freeze({ id: "reminders", heading: "催取工作台", level: 1 }),
  Object.freeze({ id: "stats", heading: "账目 / 对账", level: 1 }),
  Object.freeze({ id: "settings", heading: "设置", level: 1 }),
]);

function requiredAbsoluteEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || !isAbsolute(value) || value.includes("\0")) {
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

function requiredString(record: Readonly<Record<string, unknown>>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length < 1 || /[\0\r\n]/u.test(value)) {
    throw new Error("Windows development credential handoff is invalid");
  }
  return value;
}

async function loadBootstrapCredentials(path: string): Promise<BootstrapCredentials> {
  await inspectPrivateFile(path);
  const metadata = await lstat(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    metadata.size > 8192
  ) {
    throw new Error("Windows development credential handoff is invalid");
  }
  const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  if (value.development_only !== true) {
    throw new Error("Windows development credential handoff is invalid");
  }
  return Object.freeze({
    adminUsername: requiredString(value, "admin_username"),
    adminDisplayName: requiredString(value, "admin_display_name"),
    adminPassword: requiredString(value, "admin_password"),
    adminPin: requiredString(value, "admin_pin"),
    approverDisplayName: requiredString(value, "approver_display_name"),
    approverPin: requiredString(value, "approver_pin"),
  });
}

async function loadFunctionalAccount(path: string): Promise<FunctionalAccount | null> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  await inspectPrivateFile(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    metadata.size > 8192
  ) {
    throw new Error("Windows functional credential handoff is invalid");
  }
  const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  if (
    value.development_only !== true ||
    value.org_code !== ORG_CODE ||
    value.store_code !== STORE_CODE ||
    value.role !== "admin" ||
    value.privacy_admin !== false
  ) {
    throw new Error("Windows functional credential handoff is invalid");
  }
  return Object.freeze({
    username: requiredString(value, "username"),
    displayName: requiredString(value, "display_name"),
    password: requiredString(value, "password"),
    pin: requiredString(value, "pin"),
  });
}

function createFunctionalAccount(): FunctionalAccount {
  const suffix = randomBytes(4).toString("hex");
  return Object.freeze({
    username: `codex-qa-${suffix}`,
    displayName: `Codex 全功能测试 ${suffix}`,
    password: `Win-QA-${randomBytes(24).toString("base64url")}`,
    pin: String(randomInt(100_000, 1_000_000)),
  });
}

async function persistFunctionalAccount(path: string, account: FunctionalAccount): Promise<void> {
  const payload = Object.freeze({
    development_only: true,
    org_code: ORG_CODE,
    store_code: STORE_CODE,
    username: account.username,
    display_name: account.displayName,
    password: account.password,
    pin: account.pin,
    role: "admin",
    privacy_admin: false,
    created_at: new Date().toISOString(),
  });
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  try {
    await securePrivateFile(path);
    await inspectPrivateFile(path);
  } catch (error) {
    await rm(path, { force: true });
    throw error;
  }
}

async function launchInstalled(executable: string, userDataPath: string) {
  return await electron.launch({
    executablePath: executable,
    args: [`--user-data-dir=${userDataPath}`],
    env: credentialFreeEnvironment(),
  });
}

async function closeApplication(application: ElectronApplication | null): Promise<void> {
  await application?.close();
}

async function login(page: Page, username: string, password: string): Promise<void> {
  await expect(page.locator('[data-page="login"]')).toBeVisible({ timeout: 20_000 });
  await page.locator('input[name="org_code"]').fill(ORG_CODE);
  await page.locator('input[name="store_code"]').fill(STORE_CODE);
  await page.locator('input[name="username"]').fill(username);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.locator('[data-shell="counter"]')).toBeVisible({ timeout: 20_000 });
}

async function logout(page: Page): Promise<void> {
  const result = await page.evaluate(async () => {
    const bridge = (
      window as Window & { laundryDesktop?: { auth?: { logout?: () => Promise<unknown> } } }
    ).laundryDesktop;
    return await bridge?.auth?.logout?.();
  });
  expect(result).toEqual({ ok: true, data: { logged_out: true } });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator('[data-page="login"]')).toBeVisible({ timeout: 20_000 });
}

async function selectApprover(page: Page, displayName: string, pin: string): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "需要现场复核" });
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  const select = dialog.getByRole("combobox", { name: "复核人" });
  const option = select.locator("option").filter({ hasText: displayName });
  const value = await option.getAttribute("value");
  if (value === null) throw new Error("Windows functional approver is unavailable");
  await select.selectOption(value);
  await dialog.getByLabel("复核人 PIN").fill(pin);
  await dialog.getByRole("button", { name: "确认 PIN" }).click();
}

async function switchStaff(page: Page, displayName: string, pin: string): Promise<void> {
  await page.getByRole("button", { name: "切换员工" }).click();
  const dialog = page.getByRole("dialog", { name: "切换员工" });
  const select = dialog.getByRole("combobox", { name: "目标员工" });
  const option = select.locator("option").filter({ hasText: displayName });
  const value = await option.getAttribute("value");
  if (value === null) {
    const available = await select.locator("option").allTextContents();
    throw new Error(`Windows functional switch target is unavailable: ${available.join(", ")}`);
  }
  await select.selectOption(value);
  await dialog.getByLabel("PIN").fill(pin);
  await dialog.getByRole("button", { name: "确认切换" }).click();
  await expect(page.getByText(displayName, { exact: true })).toBeVisible({ timeout: 20_000 });
}

async function completeCredentials(page: Page, account: FunctionalAccount): Promise<void> {
  const form = page.locator(".ld-staff-credential-form");
  await expect(form).toBeVisible({ timeout: 20_000 });
  await form.getByLabel("新密码", { exact: true }).fill(account.password);
  await form.getByLabel("再次输入新密码").fill(account.password);
  await form.getByLabel("新 PIN（6–8 位数字）").fill(account.pin);
  await form.getByLabel("再次输入新 PIN").fill(account.pin);
  await form.getByRole("button", { name: "设置并启用" }).click();
  await expect(page.locator(".ld-toast").last()).toContainText("员工凭据已设置并启用", {
    timeout: 20_000,
  });
}

async function capture(page: Page, path: string): Promise<void> {
  await page.screenshot({ path, type: "png" });
}

async function verifyNavigation(page: Page): Promise<void> {
  for (const item of NAVIGATION_CHECKS) {
    await page.locator(`[data-nav-id="${item.id}"]`).click();
    await expect(page.locator('[data-shell="counter"]')).toHaveAttribute("data-nav", item.id);
    await expect(page.getByRole("heading", { name: item.heading, level: item.level })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByRole("heading", { name: "本地服务尚未就绪" })).toHaveCount(0);
  }
}

async function verifyAsLaunchedLayout(page: Page) {
  const layout = await page.evaluate(() => {
    const bounds = (selector: string) => {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement)) return null;
      const rect = element.getBoundingClientRect();
      return Object.freeze({
        top: rect.top,
        left: rect.left,
        right: rect.right,
        bottom: rect.bottom,
      });
    };
    return Object.freeze({
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      canScrollX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      sidebar: bounds(".ld-shell-sidebar"),
      settingsNav: bounds('[data-nav-id="settings"]'),
      topbar: bounds(".ld-shell-topbar"),
      title: bounds(".ld-shell-main__title"),
    });
  });
  expect(layout.innerWidth).toBeGreaterThanOrEqual(900);
  expect(layout.innerHeight).toBeGreaterThanOrEqual(640);
  expect(layout.canScrollX).toBe(false);
  expect(layout.sidebar).not.toBeNull();
  expect(layout.sidebar?.left).toBeGreaterThanOrEqual(0);
  expect(layout.sidebar?.top).toBeGreaterThanOrEqual(0);
  expect(layout.sidebar?.right).toBeLessThanOrEqual(layout.innerWidth + 1);
  for (const bounds of [layout.settingsNav, layout.topbar, layout.title]) {
    expect(bounds).not.toBeNull();
    expect(bounds?.left).toBeGreaterThanOrEqual(0);
    expect(bounds?.top).toBeGreaterThanOrEqual(0);
    expect(bounds?.right).toBeLessThanOrEqual(layout.innerWidth + 1);
    expect(bounds?.bottom).toBeLessThanOrEqual(layout.innerHeight + 1);
  }
  return layout;
}

test.setTimeout(360_000);

test("created test admin completes the installed Windows desktop functional journey", async () => {
  expect(process.platform).toBe("win32");
  const executable = await realpath(requiredAbsoluteEnvironment("LAUNDRY_WINDOWS_INSTALLED_EXE"));
  const bootstrapPath = await realpath(
    requiredAbsoluteEnvironment("LAUNDRY_WINDOWS_RUNTIME_CREDENTIALS_FILE"),
  );
  const accountPath = requiredAbsoluteEnvironment("LAUNDRY_WINDOWS_FUNCTIONAL_ACCOUNT_FILE");
  const runtimeRoot = await realpath(dirname(bootstrapPath));
  if (resolve(dirname(accountPath)).toLowerCase() !== runtimeRoot.toLowerCase()) {
    throw new Error("functional account handoff must stay inside the private Runtime root");
  }
  const evidenceRoot = requiredAbsoluteEnvironment("LAUNDRY_WINDOWS_FUNCTIONAL_EVIDENCE_DIR");
  await mkdir(evidenceRoot, { recursive: true });
  const evidenceRootReal = await realpath(evidenceRoot);
  const bootstrap = await loadBootstrapCredentials(bootstrapPath);
  const existingAccount = await loadFunctionalAccount(accountPath);
  const account = existingAccount ?? createFunctionalAccount();
  const accountCreatedThisRun = existingAccount === null;
  const suffix = randomBytes(4).toString("hex");
  const fixtures = Object.freeze({
    catalogCode: `qa_wash_${suffix}`,
    catalogName: `QA 精洗衬衫 ${suffix}`,
    catalogCategory: `qa_${suffix}`,
    customerName: `QA 合成顾客 ${suffix}`,
    customerPhone: `139${randomInt(10_000_000, 100_000_000)}`,
  });
  const screenshots = Object.freeze({
    workbench: join(evidenceRootReal, "01-test-account-workbench.png"),
    settings: join(evidenceRootReal, "02-account-and-printer-settings.png"),
    order: join(evidenceRootReal, "03-order-refund-detail.png"),
    settled: join(evidenceRootReal, "04-pickup-settled.png"),
    stats: join(evidenceRootReal, "05-reconciliation.png"),
    restarted: join(evidenceRootReal, "06-restarted-session.png"),
  });
  const userDataPath = await mkdtemp(join(await realpath(tmpdir()), "laundry-win-functional-"));
  let application: ElectronApplication | null = null;
  const rendererErrors: string[] = [];
  const serverFailures: string[] = [];
  let ticketNo = "";
  let layout: Awaited<ReturnType<typeof verifyAsLaunchedLayout>> | null = null;

  const observe = (page: Page): void => {
    page.on("pageerror", (error) => rendererErrors.push(error.message));
    page.on("response", (response) => {
      if (response.status() >= 500) serverFailures.push(`${response.status()} ${response.url()}`);
    });
  };

  try {
    application = await launchInstalled(executable, userDataPath);
    let page = await application.firstWindow();
    observe(page);
    if (accountCreatedThisRun) {
      await login(page, bootstrap.adminUsername, bootstrap.adminPassword);
      await page.locator('[data-nav-id="settings"]').click();
      const staffPanel = page.locator('[data-testid="staff-access"]');
      await expect(staffPanel).toBeVisible({ timeout: 20_000 });
      await staffPanel.getByRole("button", { name: "新增员工" }).click();
      await staffPanel.getByLabel("登录名").fill(account.username);
      await staffPanel.getByLabel("员工姓名").fill(account.displayName);
      await staffPanel.locator("#staff-create-role").selectOption("admin");
      await staffPanel.getByLabel("新增原因").fill("Windows 安装版合成全功能验收");
      await staffPanel.getByRole("button", { name: "提交并复核" }).click();
      await selectApprover(page, bootstrap.approverDisplayName, bootstrap.approverPin);
      await completeCredentials(page, account);
      const accountRow = staffPanel.locator('[data-testid="staff-access-list"] > li', {
        hasText: account.displayName,
      });
      await expect(accountRow).toContainText("店长", { timeout: 20_000 });
      await expect(accountRow).toContainText("在职");
      await persistFunctionalAccount(accountPath, account);
      await logout(page);
    }
    await page.locator('input[name="org_code"]').fill(ORG_CODE);
    await page.locator('input[name="store_code"]').fill(STORE_CODE);
    await page.locator('input[name="username"]').fill(account.username);
    const passwordInput = page.locator('input[name="password"]');
    await passwordInput.fill(WRONG_PASSWORD_PROBE);
    await page.getByRole("button", { name: "登录" }).click();
    await expect(page.locator(".ld-login__error")).toBeVisible({ timeout: 20_000 });
    const remainingPasswordLength = await passwordInput.evaluate((element) => {
      if (!(element instanceof HTMLInputElement)) throw new Error("password control is invalid");
      return element.value.length;
    });
    expect(remainingPasswordLength).toBe(0);
    await login(page, account.username, account.password);
    await expect(page.locator('[data-shell="counter"]')).toHaveAttribute("data-role", "admin");
    await expect(page.getByText(account.displayName, { exact: true })).toBeVisible();
    await expect(page.locator(".ld-toast--error")).toHaveCount(0);

    const desktopSecurity = await application.evaluate(
      ({ app, BrowserWindow, safeStorage, session }) => {
        const window = BrowserWindow.getAllWindows()[0];
        if (window === undefined) throw new Error("installed Windows main window is unavailable");
        return Object.freeze({
          dedicatedSession:
            window.webContents.session === session.fromPartition("persist:laundry-v2-local"),
          encryptionAvailable: safeStorage.isEncryptionAvailable(),
          isPackaged: app.isPackaged,
          platform: process.platform,
        });
      },
    );
    expect(desktopSecurity).toEqual({
      dedicatedSession: true,
      encryptionAvailable: true,
      isPackaged: true,
      platform: "win32",
    });
    const health = await page.evaluate(async () => {
      const bridge = (
        window as Window & { laundryDesktop?: { health?: { get?: () => Promise<unknown> } } }
      ).laundryDesktop;
      return await bridge?.health?.get?.();
    });
    expect(health).toEqual({ ok: true, data: { status: "ready" } });
    layout = await verifyAsLaunchedLayout(page);
    await capture(page, screenshots.workbench);

    await verifyNavigation(page);
    const theme = page.getByRole("button", { name: /^主题：/u });
    await theme.click();
    await expect(theme).toHaveText("主题：浅色");
    await theme.click();
    await expect(theme).toHaveText("主题：深色");
    await theme.click();
    await expect(theme).toHaveText("主题：跟随系统");
    await page.locator(".ld-print-indicator").click();
    await expect(page.getByRole("dialog", { name: "打印队列" })).toBeVisible({ timeout: 20_000 });
    await page
      .getByRole("dialog", { name: "打印队列" })
      .getByRole("contentinfo")
      .getByRole("button", { name: "关闭" })
      .click();

    await page.locator('[data-nav-id="settings"]').click();
    const catalog = page.locator('[data-testid="catalog-admin"]');
    await catalog.getByRole("button", { name: "新建 / 清空" }).click();
    await catalog.locator('input[name="catalog-code"]').fill(fixtures.catalogCode);
    await catalog.locator('input[name="catalog-name"]').fill(fixtures.catalogName);
    await catalog.locator('input[name="catalog-service"]').fill("wash");
    await catalog.locator('input[name="catalog-category"]').fill(fixtures.catalogCategory);
    await catalog.locator('input[name="catalog-price"]').fill("2000");
    await catalog.locator('[data-testid="catalog-save-btn"]').click();
    const catalogRow = catalog.locator('[data-testid="catalog-admin-row"]', {
      hasText: fixtures.catalogCode,
    });
    await expect(catalogRow).toContainText("在架", { timeout: 20_000 });
    await catalogRow.getByRole("button", { name: "停用" }).click();
    await expect(catalogRow).toContainText("已停用", { timeout: 20_000 });
    await catalogRow.getByRole("button", { name: "启用" }).click();
    await expect(catalogRow).toContainText("在架", { timeout: 20_000 });
    const printer = page.locator('[data-testid="printer-settings"]');
    await expect(printer).toBeVisible();
    await printer.getByRole("button", { name: "刷新队列" }).click();
    await expect(page.locator(".ld-toast").last()).toContainText("已刷新本机打印队列", {
      timeout: 20_000,
    });
    await capture(page, screenshots.settings);

    await page.locator('[data-nav-id="customers"]').click();
    await page.locator('[data-testid="customers-phone-input"]').fill(fixtures.customerPhone);
    await page.locator('[data-testid="customers-name-input"]').fill(fixtures.customerName);
    await page.locator('[data-testid="customers-upsert-btn"]').click();
    await expect(page.locator(".ld-toast").last()).toContainText("客户已保存", { timeout: 20_000 });
    await page.locator('[data-testid="customers-search-input"]').fill(fixtures.customerPhone);
    await page.locator('[data-testid="customers-search-btn"]').click();
    await page.locator('[data-testid="customers-row"]', { hasText: fixtures.customerName }).click();
    const profile = page.locator('[data-testid="customer-profile-panel"]');
    await expect(profile).toBeVisible({ timeout: 20_000 });
    await profile.getByLabel("首选联系渠道").selectOption("wechat");
    await profile.getByLabel("服务偏好（内部）").fill("Windows 合成验收，低温精洗");
    await profile.getByLabel("跳过小票打印").check();
    await profile.locator('[data-testid="customer-profile-reason"]').fill("Windows 全功能合成验收");
    await profile.locator('[data-testid="customer-profile-save"]').click();
    const profileDialog = page.getByRole("dialog", { name: "确认顾客档案变更" });
    await expect(profileDialog).toBeVisible({ timeout: 20_000 });
    await profileDialog.getByRole("button", { name: "确认保存" }).click();
    await expect(page.locator(".ld-toast").last()).toContainText("顾客扩展档案更新完成", {
      timeout: 20_000,
    });

    await page.locator('[data-nav-id="receive"]').click();
    await page
      .locator('[data-testid="catalog-picker"]')
      .getByRole("option", { name: new RegExp(fixtures.catalogName, "u") })
      .click();
    await page.locator('input[name="customer-phone"]').fill(fixtures.customerPhone);
    await page.locator('input[name="customer-name"]').fill(fixtures.customerName);
    await page.locator('input[name="initial-payment"]').fill("500");
    await page.getByRole("button", { name: "确认开单" }).click();
    ticketNo = (await page.locator('[data-testid="receive-ticket"]').innerText()).trim();
    expect(ticketNo.length).toBeGreaterThan(0);
    const receiveResult = page.locator(".ld-order-result").last();
    await expect(
      receiveResult.getByText("应付", { exact: true }).locator("..").locator("dd"),
    ).toContainText("¥20.00");
    await expect(
      receiveResult.getByText("欠款", { exact: true }).locator("..").locator("dd"),
    ).toContainText("¥15.00");
    await expect(page.locator('[data-testid="ticket-print-button"]')).toBeDisabled();

    await page.locator('[data-nav-id="workbench"]').click();
    await page.getByRole("button", { name: "刷新" }).click();
    await expect(page.locator('[data-testid="counter-workbench-orders"]')).toContainText(ticketNo, {
      timeout: 20_000,
    });
    await page.locator('[data-nav-id="orders"]').click();
    await page.locator('[data-testid="debt-load-btn"]').click();
    const debtRow = page.locator('[data-testid="debt-row"]', { hasText: ticketNo });
    await expect(debtRow).toContainText("¥15.00", { timeout: 20_000 });
    await debtRow.locator('[data-testid="debt-row-detail-btn"]').click();
    const drawer = page.locator('[data-testid="order-detail-drawer"]');
    await expect(drawer.locator('[data-testid="order-detail-ticket"]')).toHaveText(ticketNo);
    const payment = drawer.locator('[data-testid="payment-ledger-row"]', { hasText: "收款" });
    await payment.locator('[data-testid="payment-refund-open-btn"]').click();
    const refund = page.locator('[data-testid="payment-refund-dialog"]');
    await refund.locator('[data-testid="payment-refund-amount"]').fill("100");
    await refund.locator('[data-testid="payment-refund-reason"]').fill("Windows 合成验收退款");
    await page
      .getByRole("dialog", { name: "原路退款" })
      .getByRole("button", { name: "申请退款" })
      .click();
    await selectApprover(page, bootstrap.approverDisplayName, bootstrap.approverPin);
    await expect(page.locator(".ld-toast").last()).toContainText("退款已追加到支付流水", {
      timeout: 20_000,
    });
    await expect(drawer.locator('[data-testid="order-detail-balance"]')).toContainText("¥16.00");
    await capture(page, screenshots.order);

    await drawer.locator('[data-testid="order-detail-pickup-btn"]').click();
    await page.locator('input[name="pickup-key"]').fill(ticketNo);
    await page.getByRole("button", { name: "加载订单" }).click();
    await expect(page.locator('[data-testid="pickup-loaded-ticket"]')).toHaveText(ticketNo, {
      timeout: 20_000,
    });
    await page.locator('input[name="collect-cents"]').fill("1600");
    await page.getByRole("button", { name: "确认取衣" }).click();
    await expect(page.locator('[data-testid="pickup-ticket"]')).toHaveText(ticketNo, {
      timeout: 20_000,
    });
    await capture(page, screenshots.settled);

    await page.locator('[data-nav-id="stats"]').click();
    await page.locator('[data-testid="stats-load-btn"]').click();
    await expect(page.locator('[data-testid="reconciliation-snapshot"]')).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByRole("heading", { name: "支付账本" })).toBeVisible();
    await capture(page, screenshots.stats);

    await closeApplication(application);
    application = await launchInstalled(executable, userDataPath);
    page = await application.firstWindow();
    observe(page);
    await expect(page.locator('[data-shell="counter"]')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(account.displayName, { exact: true })).toBeVisible();
    const restartedMetrics = page.locator('[data-testid="counter-workbench-metrics"]');
    await expect(restartedMetrics).not.toContainText("—", { timeout: 20_000 });
    await capture(page, screenshots.restarted);

    await switchStaff(page, bootstrap.approverDisplayName, bootstrap.approverPin);
    await switchStaff(page, account.displayName, account.pin);
    await logout(page);

    expect(rendererErrors).toEqual([]);
    expect(serverFailures).toEqual([]);
    const evidence = Object.freeze({
      status: "passed",
      account: Object.freeze({
        username: account.username,
        display_name: account.displayName,
        role: "admin",
        created_this_run: accountCreatedThisRun,
      }),
      fixtures: Object.freeze({ ...fixtures, ticket_no: ticketNo }),
      navigation: NAVIGATION_CHECKS.map((item) => item.id),
      layout,
      screenshots: Object.values(screenshots),
      renderer_errors: rendererErrors.length,
      server_failures: serverFailures.length,
    });
    await writeFile(
      join(evidenceRootReal, "functional-evidence.json"),
      `${JSON.stringify(evidence, null, 2)}\n`,
      "utf8",
    );
    process.stdout.write(
      `${JSON.stringify({ status: "passed", username: account.username, ticket_no: ticketNo, evidence: evidenceRootReal })}\n`,
    );
  } finally {
    await closeApplication(application);
    await rm(userDataPath, { force: true, recursive: true });
  }
});
