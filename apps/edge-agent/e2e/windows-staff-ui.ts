import { expect, type Locator, type Page } from "@playwright/test";

import { fillWindowsCredential } from "./windows-credentials.mjs";

export type StaffCredentials = Readonly<{
  password: string;
  pin: string;
}>;

export type StaffAccount = StaffCredentials & Readonly<{ username: string; displayName: string }>;

export type StaffApprover = Readonly<{ displayName: string; pin: string }>;

export async function loginStaff(page: Page, username: string, password: string): Promise<void> {
  await expect(page.locator('[data-page="login"]')).toBeVisible({ timeout: 20_000 });
  await fillWindowsCredential(page.locator('input[name="username"]'), username);
  await fillWindowsCredential(page.locator('input[name="password"]'), password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
}

export async function expectIdentity(
  page: Page,
  role: "staff" | "admin",
  displayName: string,
): Promise<void> {
  await expect(page.locator('[data-shell="counter"]')).toHaveAttribute("data-role", role, {
    timeout: 20_000,
  });
  await expect(page.locator(".ld-shell-topbar__staff")).toHaveText(displayName);
}

export async function openSettings(page: Page, section: "staff" | "backup"): Promise<void> {
  await page.locator('[data-nav-id="settings"]').click();
  const navigation = page.getByRole("navigation", { name: "设置分区" });
  const select = navigation.getByRole("combobox", { name: "查看分区" });
  if (await select.isVisible()) {
    await select.selectOption(`settings-${section}`);
  } else {
    await navigation
      .getByRole("button", {
        name: section === "staff" ? "员工与权限" : "备份与恢复",
        exact: true,
      })
      .click();
  }
}

async function selectStaff(select: Locator, displayName: string): Promise<void> {
  const option = select.locator("option").filter({ hasText: displayName });
  await expect(option).toHaveCount(1);
  const value = await option.getAttribute("value");
  if (value === null || value.length === 0) throw new Error("STAFF_OPTION_UNAVAILABLE");
  await select.selectOption(value);
}

async function approveStaffChange(page: Page, approver: StaffApprover): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "需要现场复核" });
  await expect(dialog).toBeVisible();
  await selectStaff(dialog.getByRole("combobox", { name: "复核人" }), approver.displayName);
  await fillWindowsCredential(dialog.getByLabel("复核人 PIN"), approver.pin);
  await dialog.getByRole("button", { name: "确认 PIN", exact: true }).click();
}

async function setCredentials(page: Page, credentials: StaffCredentials): Promise<void> {
  const form = page.locator(".ld-staff-credential-form");
  await expect(form).toBeVisible({ timeout: 20_000 });
  await fillWindowsCredential(form.getByLabel("新密码", { exact: true }), credentials.password);
  await fillWindowsCredential(form.getByLabel("再次输入新密码"), credentials.password);
  await fillWindowsCredential(form.getByLabel("新 PIN（6–8 位数字）"), credentials.pin);
  await fillWindowsCredential(form.getByLabel("再次输入新 PIN"), credentials.pin);
  await form.getByRole("button", { name: "设置并启用", exact: true }).click();
  await expect(page.locator(".ld-toast").last()).toContainText("员工凭据已设置并启用", {
    timeout: 20_000,
  });
}

export async function createStaff(
  page: Page,
  account: StaffAccount,
  approver: StaffApprover,
): Promise<void> {
  await openSettings(page, "staff");
  const panel = page.locator('[data-testid="staff-access"]');
  await panel.getByRole("button", { name: "新增员工", exact: true }).click();
  await panel.getByLabel("登录名").fill(account.username);
  await panel.getByLabel("员工姓名").fill(account.displayName);
  await panel.locator("#staff-create-role").selectOption("staff");
  const privacy = panel.getByLabel("隐私管理员", { exact: true });
  await expect(privacy).not.toBeChecked();
  await expect(privacy).toBeDisabled();
  await panel.getByLabel("新增原因").fill("隔离合成数据普通店员权限验收");
  await panel.getByRole("button", { name: "提交并复核", exact: true }).click();
  await approveStaffChange(page, approver);
  await setCredentials(page, account);
  const row = staffRow(page, account.displayName);
  await expect(row).toContainText("店员");
  await expect(row).toContainText("无隐私权限");
  await expect(row).toContainText("在职");
}

function staffRow(page: Page, displayName: string): Locator {
  return page.locator('[data-testid="staff-access-list"] > li').filter({
    hasText: displayName,
  });
}

export async function switchStaff(page: Page, displayName: string, pin: string): Promise<void> {
  await page.getByRole("button", { name: "切换员工", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "切换员工", exact: true });
  await selectStaff(dialog.getByRole("combobox", { name: "目标员工" }), displayName);
  await fillWindowsCredential(dialog.getByLabel("PIN", { exact: true }), pin);
  await dialog.getByRole("button", { name: "确认切换", exact: true }).click();
}

export async function resetStaffCredentials(
  page: Page,
  displayName: string,
  credentials: StaffCredentials,
  approver: StaffApprover,
): Promise<void> {
  await openSettings(page, "staff");
  await staffRow(page, displayName).getByRole("button", { name: "重置凭据", exact: true }).click();
  const panel = page.locator('[data-testid="staff-credential-reset"]');
  await panel.getByLabel("重置原因").fill("隔离合成数据旧凭据撤销验收");
  await panel.getByRole("button", { name: "撤销并复核", exact: true }).click();
  await approveStaffChange(page, approver);
  await setCredentials(page, credentials);
}

export async function expectSecretCleared(input: Locator): Promise<void> {
  // Never ask Playwright to render a password/PIN value in a failed assertion.
  await expect
    .poll(() => input.evaluate((element: HTMLInputElement) => element.value.length))
    .toBe(0);
}
