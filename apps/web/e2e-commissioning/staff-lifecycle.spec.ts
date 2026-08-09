import { randomInt, randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

const WEB_URL = "http://127.0.0.1:5173";
const API_URL = "http://127.0.0.1:8787";

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

const BOOTSTRAP = Object.freeze({
  orgCode: requiredEnvironment("LAUNDRY_LOCAL_ORG_CODE"),
  storeCode: requiredEnvironment("LAUNDRY_LOCAL_STORE_CODE"),
  adminUsername: requiredEnvironment("LAUNDRY_BOOTSTRAP_ADMIN_USERNAME"),
  adminPassword: requiredSecretEnvironment("LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD"),
  approverUsername: requiredEnvironment("LAUNDRY_BOOTSTRAP_APPROVER_USERNAME"),
  approverDisplayName: requiredEnvironment("LAUNDRY_BOOTSTRAP_APPROVER_DISPLAY_NAME"),
  approverPassword: requiredSecretEnvironment("LAUNDRY_BOOTSTRAP_APPROVER_PASSWORD"),
  approverPin: requiredSecretEnvironment("LAUNDRY_BOOTSTRAP_APPROVER_PIN"),
});

function sixDigitPin(): string {
  return String(randomInt(100_000, 1_000_000));
}

async function login(page: Page, username: string, password: string): Promise<void> {
  await page.goto(WEB_URL);
  await page.locator('input[name="org_code"]').fill(BOOTSTRAP.orgCode);
  await page.locator('input[name="store_code"]').fill(BOOTSTRAP.storeCode);
  await page.locator('input[name="username"]').fill(username);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.locator('[data-shell="counter"]')).toBeVisible({ timeout: 15_000 });
}

async function approveWithBootstrapAdmin(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "需要现场复核" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("combobox", { name: "复核人" })).toContainText(
    BOOTSTRAP.approverDisplayName,
  );
  await dialog.getByLabel("复核人 PIN").fill(BOOTSTRAP.approverPin);
  await dialog.getByRole("button", { name: "确认 PIN" }).click();
}

async function completeCredentials(page: Page, password: string, pin: string): Promise<void> {
  const form = page.locator(".ld-staff-credential-form");
  await expect(form).toBeVisible({ timeout: 15_000 });
  await form.getByLabel("新密码", { exact: true }).fill(password);
  await form.getByLabel("再次输入新密码").fill(password);
  await form.getByLabel("新 PIN（6–8 位数字）").fill(pin);
  await form.getByLabel("再次输入新 PIN").fill(pin);
  await form.getByRole("button", { name: "设置并启用" }).click();
  await expect(page.locator(".ld-toast").last()).toContainText("员工凭据已设置并启用", {
    timeout: 15_000,
  });
}

test.beforeAll(async ({ request }) => {
  const health = await request.get(`${API_URL}/health`);
  expect(health.ok(), "production-bootstrap API must be ready").toBeTruthy();
});

test("empty-volume bootstrap supports staff create, reset, completion, and login", async ({
  page,
  browser,
}) => {
  const suffix = randomUUID().slice(0, 8);
  const username = `web-staff-${suffix}`;
  const displayName = `Web 新员工 ${suffix}`;
  const initialPassword = `Web-initial-${randomUUID()}`;
  const initialPin = sixDigitPin();
  const resetPassword = `Web-reset-${randomUUID()}`;
  const resetPin = sixDigitPin();

  await login(page, BOOTSTRAP.adminUsername, BOOTSTRAP.adminPassword);
  const approverContext = await browser.newContext();
  try {
    const approverPage = await approverContext.newPage();
    await login(approverPage, BOOTSTRAP.approverUsername, BOOTSTRAP.approverPassword);
    await expect(
      approverPage.getByText(BOOTSTRAP.approverDisplayName, { exact: true }),
    ).toBeVisible();
  } finally {
    await approverContext.close();
  }
  await page.locator('[data-nav-id="settings"]').click();
  const staffPanel = page.locator('[data-testid="staff-access"]');
  await expect(staffPanel.locator('[data-testid="staff-access-list"] > li')).toHaveCount(2, {
    timeout: 15_000,
  });
  await expect(staffPanel).toContainText(BOOTSTRAP.approverDisplayName, { timeout: 15_000 });
  await expect(page.getByRole("region", { name: "充值赠送档位" })).toBeVisible();
  await page.locator('[data-nav-id="stats"]').click();
  await expect(page.locator('[data-testid="shift-close-panel"]')).toBeVisible();
  await page.locator('[data-nav-id="settings"]').click();

  await staffPanel.getByRole("button", { name: "新增员工" }).click();
  await staffPanel.getByLabel("登录名").fill(username);
  await staffPanel.getByLabel("员工姓名").fill(displayName);
  await staffPanel.getByLabel("新增原因").fill("空库投产员工闭环验收");
  await staffPanel.getByRole("button", { name: "提交并复核" }).click();
  await approveWithBootstrapAdmin(page);
  await completeCredentials(page, initialPassword, initialPin);

  const row = staffPanel.locator('[data-testid="staff-access-list"] > li', {
    hasText: displayName,
  });
  await expect(row).toContainText("在职", { timeout: 15_000 });
  await row.getByRole("button", { name: "重置凭据" }).click();
  const reset = page.locator('[data-testid="staff-credential-reset"]');
  await reset.getByLabel("重置原因").fill("空库投产凭据重置验收");
  await reset.getByRole("button", { name: "撤销并复核" }).click();
  await approveWithBootstrapAdmin(page);
  await completeCredentials(page, resetPassword, resetPin);

  const verificationContext = await browser.newContext();
  try {
    const verificationPage = await verificationContext.newPage();
    await verificationPage.goto(WEB_URL);
    await verificationPage.locator('input[name="org_code"]').fill(BOOTSTRAP.orgCode);
    await verificationPage.locator('input[name="store_code"]').fill(BOOTSTRAP.storeCode);
    await verificationPage.locator('input[name="username"]').fill(username);
    await verificationPage.locator('input[name="password"]').fill(initialPassword);
    await verificationPage.getByRole("button", { name: "登录" }).click();
    await expect(verificationPage.locator('[data-page="login"]')).toBeVisible();
    await expect(verificationPage.locator('input[name="password"]')).toHaveValue("");

    await login(verificationPage, username, resetPassword);
    await expect(verificationPage.getByText(displayName, { exact: true })).toBeVisible();
  } finally {
    await verificationContext.close();
  }
});
