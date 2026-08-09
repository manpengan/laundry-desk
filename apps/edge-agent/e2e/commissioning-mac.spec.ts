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
  approverUsername: requiredEnvironment("LAUNDRY_BOOTSTRAP_APPROVER_USERNAME"),
  approverDisplayName: requiredEnvironment("LAUNDRY_BOOTSTRAP_APPROVER_DISPLAY_NAME"),
  approverPassword: requiredSecretEnvironment("LAUNDRY_BOOTSTRAP_APPROVER_PASSWORD"),
  approverPin: requiredSecretEnvironment("LAUNDRY_BOOTSTRAP_APPROVER_PIN"),
});
const NEW_STAFF = Object.freeze({
  username: `mac-staff-${randomUUID().slice(0, 8)}`,
  displayName: `macOS 新员工 ${randomUUID().slice(0, 8)}`,
  password: `Mac-staff-${randomUUID()}`,
  pin: String(randomInt(100_000, 1_000_000)),
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

async function login(page: Page, username: string, password: string): Promise<void> {
  await expect(page.locator('[data-page="login"]')).toBeVisible({ timeout: 15_000 });
  await page.locator('input[name="org_code"]').fill(BOOTSTRAP.orgCode);
  await page.locator('input[name="store_code"]').fill(BOOTSTRAP.storeCode);
  await page.locator('input[name="username"]').fill(username);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole("button", { name: "登录" }).click();
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

async function createAndSwitchStaff(page: Page): Promise<void> {
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

  const approval = page.getByRole("dialog", { name: "需要现场复核" });
  await expect(approval.getByRole("combobox", { name: "复核人" })).toContainText(
    BOOTSTRAP.approverDisplayName,
  );
  await approval.getByLabel("复核人 PIN").fill(BOOTSTRAP.approverPin);
  await approval.getByRole("button", { name: "确认 PIN" }).click();

  const credentials = page.locator(".ld-staff-credential-form");
  await expect(credentials).toBeVisible({ timeout: 15_000 });
  await credentials.getByLabel("新密码", { exact: true }).fill(NEW_STAFF.password);
  await credentials.getByLabel("再次输入新密码").fill(NEW_STAFF.password);
  await credentials.getByLabel("新 PIN（6–8 位数字）").fill(NEW_STAFF.pin);
  await credentials.getByLabel("再次输入新 PIN").fill(NEW_STAFF.pin);
  await credentials.getByRole("button", { name: "设置并启用" }).click();
  await expect(page.locator(".ld-toast").last()).toContainText("员工凭据已设置并启用", {
    timeout: 15_000,
  });

  await page.getByRole("button", { name: "切换员工" }).click();
  const switchDialog = page.getByRole("dialog", { name: "切换员工" });
  await switchDialog.getByLabel("目标员工").selectOption({ label: NEW_STAFF.displayName });
  await switchDialog.getByLabel("PIN").fill(NEW_STAFF.pin);
  await switchDialog.getByRole("button", { name: "确认切换" }).click();
  await expect(
    page.getByRole("banner").getByText(NEW_STAFF.displayName, { exact: true }),
  ).toBeVisible({
    timeout: 15_000,
  });
}

test.beforeAll(async ({ request }) => {
  const health = await request.get(HEALTH_URL);
  expect(health.ok(), "fresh production bootstrap must already be ready").toBeTruthy();
});

test("packaged app commissions staff from an independent production-bootstrap volume", async () => {
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
    await createAndSwitchStaff(page);
  } finally {
    await application?.close();
  }
});
