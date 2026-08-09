import { randomInt, randomUUID } from "node:crypto";
import { access, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
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
const BOOTSTRAP = Object.freeze({
  orgCode: requiredEnvironment("LAUNDRY_LOCAL_ORG_CODE"),
  storeCode: requiredEnvironment("LAUNDRY_LOCAL_STORE_CODE"),
  adminUsername: requiredEnvironment("LAUNDRY_BOOTSTRAP_ADMIN_USERNAME"),
  adminDisplayName: requiredEnvironment("LAUNDRY_BOOTSTRAP_ADMIN_DISPLAY_NAME"),
  adminPassword: requiredSecretEnvironment("LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD"),
  adminPin: requiredSecretEnvironment("LAUNDRY_BOOTSTRAP_ADMIN_PIN"),
  approverUsername: requiredEnvironment("LAUNDRY_BOOTSTRAP_APPROVER_USERNAME"),
  approverDisplayName: requiredEnvironment("LAUNDRY_BOOTSTRAP_APPROVER_DISPLAY_NAME"),
  approverPassword: requiredSecretEnvironment("LAUNDRY_BOOTSTRAP_APPROVER_PASSWORD"),
  approverPin: requiredSecretEnvironment("LAUNDRY_BOOTSTRAP_APPROVER_PIN"),
});
function distinctPins(): readonly [string, string] {
  const first = String(randomInt(100_000, 1_000_000));
  let second = String(randomInt(100_000, 1_000_000));
  while (second === first) second = String(randomInt(100_000, 1_000_000));
  return Object.freeze([first, second]);
}
const [NEW_STAFF_PIN, RESET_STAFF_PIN] = distinctPins();
const NEW_STAFF = Object.freeze({
  username: `mac-staff-${randomUUID().slice(0, 8)}`,
  displayName: `macOS 新员工 ${randomUUID().slice(0, 8)}`,
  password: `Mac-staff-${randomUUID()}`,
  pin: NEW_STAFF_PIN,
  resetPassword: `Mac-reset-${randomUUID()}`,
  resetPin: RESET_STAFF_PIN,
});

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

function assertOwnedInputs(): void {
  const releaseRelative = relative(RELEASE_ROOT, APP_PATH);
  const userDataRelative = relative(REPOSITORY_ROOT, USER_DATA_PATH);
  if (
    !isAbsolute(APP_PATH) ||
    releaseRelative.startsWith("..") ||
    isAbsolute(releaseRelative) ||
    !/[/\\]mac-[A-Za-z0-9._-]+[/\\]laundry-desk V2\.app$/u.test(APP_PATH) ||
    !isAbsolute(USER_DATA_PATH) ||
    userDataRelative === "" ||
    (!userDataRelative.startsWith("..") && !isAbsolute(userDataRelative))
  ) {
    throw new Error("packaged commissioning inputs are invalid");
  }
}

async function submitLogin(page: Page, username: string, password: string): Promise<void> {
  await expect(page.locator('[data-page="login"]')).toBeVisible({ timeout: 15_000 });
  await page.locator('input[name="org_code"]').fill(BOOTSTRAP.orgCode);
  await page.locator('input[name="store_code"]').fill(BOOTSTRAP.storeCode);
  await page.locator('input[name="username"]').fill(username);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole("button", { name: "登录" }).click();
}

async function login(page: Page, username: string, password: string): Promise<void> {
  await submitLogin(page, username, password);
  await expect(page.locator('[data-shell="counter"]')).toBeVisible({ timeout: 15_000 });
}

async function logoutAndReload(page: Page): Promise<void> {
  const logoutOk = await page.evaluate(async () => {
    const bridge = (
      window as Window & {
        laundryDesktop?: { auth?: { logout?: () => Promise<unknown> } };
      }
    ).laundryDesktop;
    if (bridge?.auth?.logout === undefined) return false;
    const result = await bridge.auth.logout();
    return (
      typeof result === "object" && result !== null && (result as { ok?: unknown }).ok === true
    );
  });
  expect(logoutOk).toBe(true);
  await page.reload();
  await expect(page.locator('[data-page="login"]')).toBeVisible({ timeout: 15_000 });
}

async function quickSwitch(
  page: Page,
  displayName: string,
  pin: string,
  role: "admin" | "staff",
): Promise<void> {
  await page.getByRole("button", { name: "切换员工" }).click();
  const dialog = page.getByRole("dialog", { name: "切换员工" });
  await dialog.getByLabel("目标员工").selectOption({ label: displayName });
  await dialog.getByLabel("PIN").fill(pin);
  await dialog.getByRole("button", { name: "确认切换" }).click();
  await expect(page.locator(".ld-shell-topbar__staff")).toHaveText(displayName, {
    timeout: 15_000,
  });
  await expect(page.locator('[data-shell="counter"]')).toHaveAttribute("data-role", role);
}

async function expectQuickSwitchRejected(
  page: Page,
  displayName: string,
  pin: string,
  currentDisplayName: string,
  currentRole: "admin" | "staff",
): Promise<void> {
  const currentStaff = page.locator(".ld-shell-topbar__staff");
  const shell = page.locator('[data-shell="counter"]');
  await expect(currentStaff).toHaveText(currentDisplayName);
  await expect(shell).toHaveAttribute("data-role", currentRole);

  await page.getByRole("button", { name: "切换员工" }).click();
  const dialog = page.getByRole("dialog", { name: "切换员工" });
  await dialog.getByLabel("目标员工").selectOption({ label: displayName });
  await dialog.getByLabel("PIN").fill(pin);
  await dialog.getByRole("button", { name: "确认切换" }).click();

  await expect(dialog.getByRole("alert")).toHaveText("Authentication failed", {
    timeout: 15_000,
  });
  await expect(dialog.getByLabel("PIN")).toHaveValue("");
  await expect(dialog.getByRole("button", { name: "确认切换" })).toBeEnabled();
  await expect(currentStaff).toHaveText(currentDisplayName);
  await expect(shell).toHaveAttribute("data-role", currentRole);
  await dialog.getByRole("button", { name: "取消" }).click();
  await expect(dialog).toBeHidden();
}

async function approveWithBootstrap(page: Page): Promise<void> {
  const approval = page.getByRole("dialog", { name: "需要现场复核" });
  await expect(approval.getByRole("combobox", { name: "复核人" })).toContainText(
    BOOTSTRAP.approverDisplayName,
  );
  await approval.getByLabel("复核人 PIN").fill(BOOTSTRAP.approverPin);
  await approval.getByRole("button", { name: "确认 PIN" }).click();
}

async function completeCredentials(page: Page, password: string, pin: string): Promise<void> {
  const credentials = page.locator(".ld-staff-credential-form");
  await expect(credentials).toBeVisible({ timeout: 15_000 });
  await credentials.getByLabel("新密码", { exact: true }).fill(password);
  await credentials.getByLabel("再次输入新密码").fill(password);
  await credentials.getByLabel("新 PIN（6–8 位数字）").fill(pin);
  await credentials.getByLabel("再次输入新 PIN").fill(pin);
  await credentials.getByRole("button", { name: "设置并启用" }).click();
  await expect(page.locator(".ld-toast").last()).toContainText("员工凭据已设置并启用", {
    timeout: 15_000,
  });
}

async function createResetAndVerifyStaff(page: Page): Promise<void> {
  await page.locator('[data-nav-id="settings"]').click();
  const staffPanel = page.locator('[data-testid="staff-access"]');
  await expect(staffPanel.locator('[data-testid="staff-access-list"] > li')).toHaveCount(2, {
    timeout: 15_000,
  });
  await expect(staffPanel).toContainText(BOOTSTRAP.approverDisplayName);
  await expect(page.getByRole("region", { name: "充值赠送档位" })).toBeVisible();
  await page.locator('[data-nav-id="stats"]').click();
  await expect(page.locator('[data-testid="shift-close-panel"]')).toBeVisible();
  await page.locator('[data-nav-id="settings"]').click();

  await staffPanel.getByRole("button", { name: "新增员工" }).click();
  await staffPanel.getByLabel("登录名").fill(NEW_STAFF.username);
  await staffPanel.getByLabel("员工姓名").fill(NEW_STAFF.displayName);
  await staffPanel.getByLabel("新增原因").fill("packaged macOS 独立空卷投产验收");
  await staffPanel.getByRole("button", { name: "提交并复核" }).click();
  await approveWithBootstrap(page);
  await completeCredentials(page, NEW_STAFF.password, NEW_STAFF.pin);

  const row = staffPanel.locator('[data-testid="staff-access-list"] > li', {
    hasText: NEW_STAFF.displayName,
  });
  await expect(row).toContainText("在职", { timeout: 15_000 });
  await quickSwitch(page, NEW_STAFF.displayName, NEW_STAFF.pin, "staff");
  await quickSwitch(page, BOOTSTRAP.adminDisplayName, BOOTSTRAP.adminPin, "admin");
  await row.getByRole("button", { name: "重置凭据" }).click();
  const reset = page.locator('[data-testid="staff-credential-reset"]');
  await reset.getByLabel("重置原因").fill("packaged macOS 独立空卷凭据重置验收");
  await reset.getByRole("button", { name: "撤销并复核" }).click();
  await approveWithBootstrap(page);
  await completeCredentials(page, NEW_STAFF.resetPassword, NEW_STAFF.resetPin);
  await expectQuickSwitchRejected(
    page,
    NEW_STAFF.displayName,
    NEW_STAFF.pin,
    BOOTSTRAP.adminDisplayName,
    "admin",
  );
  await quickSwitch(page, NEW_STAFF.displayName, NEW_STAFF.resetPin, "staff");

  await logoutAndReload(page);
  await submitLogin(page, NEW_STAFF.username, NEW_STAFF.password);
  const rejectedLogin = page.locator('[data-page="login"]');
  await expect(rejectedLogin.getByRole("alert")).toHaveText("Authentication failed", {
    timeout: 15_000,
  });
  await expect(rejectedLogin.getByRole("button", { name: "登录" })).toBeEnabled();
  await expect(page.locator('[data-shell="counter"]')).toHaveCount(0);
  await expect(rejectedLogin.locator('input[name="password"]')).toHaveValue("");
  await login(page, NEW_STAFF.username, NEW_STAFF.resetPassword);
  await expect(page.getByText(NEW_STAFF.displayName, { exact: true })).toBeVisible();
}

test.beforeAll(async ({ request }) => {
  const health = await request.get(HEALTH_URL);
  expect(health.ok(), "fresh production bootstrap must already be ready").toBeTruthy();
});

test("packaged app commissions staff from an independent production-bootstrap volume", async () => {
  test.setTimeout(240_000);
  assertOwnedInputs();
  const canonicalApp = await realpath(APP_PATH);
  const executablePath = join(canonicalApp, "Contents", "MacOS", "laundry-desk V2");
  await access(executablePath);
  let application: ElectronApplication | null = null;
  try {
    application = await electron.launch({
      executablePath,
      args: [`--user-data-dir=${USER_DATA_PATH}`, "--use-mock-keychain"],
      env: credentialFreeEnvironment(),
    });
    const page = await application.firstWindow();
    await login(page, BOOTSTRAP.adminUsername, BOOTSTRAP.adminPassword);
    await expect(page.getByText(BOOTSTRAP.adminDisplayName, { exact: true })).toBeVisible();
    await logoutAndReload(page);
    await login(page, BOOTSTRAP.approverUsername, BOOTSTRAP.approverPassword);
    await expect(page.getByText(BOOTSTRAP.approverDisplayName, { exact: true })).toBeVisible();
    await logoutAndReload(page);
    await login(page, BOOTSTRAP.adminUsername, BOOTSTRAP.adminPassword);
    await createResetAndVerifyStaff(page);
  } finally {
    await application?.close();
  }
});
