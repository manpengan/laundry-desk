import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";

import { expect, type Download, type Locator, type Page } from "@playwright/test";

import { yuanText } from "./money-input.js";

import {
  fillPackagedReceiveForm,
  openPackagedDebtOrder,
  receivePackagedOrder,
  runPackagedCounterWorkday,
  runPackagedMemberSettlement,
} from "./packaged-counter-workday.js";

const FIXTURE = Object.freeze({
  staff: "E2E Staff One",
  approver: "E2E Staff Two",
  approverLabel: "E2E Staff Two（店长）",
  reminderName: "E2E 催取顾客",
  reminderPhone: "13400000000",
  reminderTicket: "E2E-REMINDER-0001",
  accountingDate: "2097-08-07",
});
const SHIFT_DATE = "1999-12-28";

export type PackagedAdmin = Readonly<{
  displayName: string;
  pin: string;
}>;

function suffix(): string {
  return Date.now().toString().slice(-8);
}

function yuanInput(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

function money(cents: number): string {
  return `¥${yuanInput(cents)}`;
}

async function downloadText(download: Download, downloadDirectory: string): Promise<string> {
  const failure = await download.failure();
  if (failure !== null) throw new Error("packaged download failed");
  const filename = download.suggestedFilename();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u.test(filename)) {
    throw new Error("packaged download filename is invalid");
  }
  const handle = await open(
    join(downloadDirectory, filename),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 1_048_576) {
      throw new Error("packaged download file is invalid");
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
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

async function approveStepUp(page: Page, pin: string, approverLabel: string): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "需要现场复核" });
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  const select = dialog.getByRole("combobox", { name: "复核人" });
  await expect(select.getByRole("option", { name: approverLabel })).toHaveCount(1);
  await select.selectOption({ label: approverLabel });
  await dialog.getByLabel("复核人 PIN").fill(pin);
  await dialog.getByRole("button", { name: "确认 PIN" }).click();
}

async function assertHeldDraft(page: Page, id: string): Promise<void> {
  const customerName = `macOS 挂单 ${id}`;
  await fillPackagedReceiveForm(page, {
    phone: `137${id}`,
    name: customerName,
  });
  await page.getByRole("button", { name: "暂存挂单" }).click();
  await expect(page.locator(".ld-toast").last()).toContainText("已暂存挂单", {
    timeout: 15_000,
  });
  const drawer = await openPackagedDebtOrder(page, customerName);
  await expect(drawer.locator('[data-testid="order-detail-ticket"]')).toHaveText("挂单");
  await expect(drawer).toContainText("¥15.00");
  await expect(drawer.locator('[data-testid="order-detail-register-photo-btn"]')).toBeDisabled();
  await expect(drawer.locator('[data-testid="order-detail-cancel-btn"]')).toHaveCount(0);
  await drawer.locator('[data-testid="order-detail-close-btn"]').click();
}

async function cancelOpenOrder(page: Page, id: string): Promise<void> {
  await fillPackagedReceiveForm(page, {
    phone: `136${id}`,
    name: `macOS 撤单 ${id}`,
  });
  const ticketNo = await receivePackagedOrder(page);
  const drawer = await openPackagedDebtOrder(page, ticketNo);
  await drawer.locator('[data-testid="order-detail-cancel-btn"]').click();
  await page.locator('input[name="danger-reason"]').fill("packaged macOS 撤销开单");
  await page.getByRole("button", { name: "确认撤销" }).click();
  await page.getByRole("button", { name: "再次确认撤销" }).click();
  await expect(drawer.locator('[data-testid="order-detail-status"]')).toContainText("已撤销", {
    timeout: 15_000,
  });
  await drawer.locator('[data-testid="order-detail-close-btn"]').click();
}

async function rackAndVerifyPickup(page: Page, ticketNo: string): Promise<void> {
  await page.locator('[data-nav-id="fulfillment"]').click();
  await page.locator('input[name="fulfillment-key"]').fill(ticketNo);
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  const row = page.locator(".ld-fulfillment__row").filter({ hasText: ticketNo });
  await expect(row).toHaveCount(1, { timeout: 15_000 });
  const barcode = (await row.locator("small").first().innerText()).trim();
  await row.locator('input[type="checkbox"]').check();
  await page.getByRole("button", { name: "进入加工" }).click();
  await expect(row).toContainText("加工中", { timeout: 15_000 });
  await row.locator('input[type="checkbox"]').check();
  await page.getByRole("button", { name: "标记完成" }).click();
  await expect(row).toContainText("已完成", { timeout: 15_000 });
  await page.locator('input[name="rack-barcode"]').fill(barcode);
  await page.locator('input[name="rack-zone"]').fill("M");
  await page.locator('input[name="rack-slot"]').fill("01");
  await page.getByRole("button", { name: "扫码上架" }).click();
  await expect(row).toContainText("待取", { timeout: 15_000 });
  await expect(row).toContainText("M-01");
  await verifyPickupWithoutCollection(page, ticketNo, barcode);
}

async function verifyPickupWithoutCollection(
  page: Page,
  ticketNo: string,
  barcode: string,
): Promise<void> {
  await page.locator('[data-nav-id="pickup"]').click();
  await page.locator('input[name="pickup-key"]').fill(ticketNo);
  await page.getByRole("button", { name: "加载订单" }).click();
  await expect(page.locator('[data-testid="pickup-loaded-ticket"]')).toHaveText(ticketNo, {
    timeout: 15_000,
  });
  const pickup = page.getByRole("button", { name: "确认取衣" });
  await expect(pickup).toBeDisabled();
  await page.locator('input[name="pickup-verification-barcode"]').fill("WRONG");
  await page.getByRole("button", { name: "确认扫码" }).click();
  await expect(page.locator(".ld-toast").last()).toContainText("条码不属于");
  await page.locator('input[name="pickup-verification-barcode"]').fill(barcode);
  await page.getByRole("button", { name: "确认扫码" }).click();
  await expect(page.getByText("已扫码复核")).toBeVisible({ timeout: 15_000 });
  await page.locator('input[name="collect-cents"]').fill(yuanText("0"));
  await expect(pickup).toBeEnabled();
  await pickup.click();
  await expect(page.locator('[data-testid="pickup-ticket"]')).toHaveText(ticketNo, {
    timeout: 15_000,
  });
}

async function repayPickedUpOrder(page: Page, ticketNo: string): Promise<void> {
  const drawer = await openPackagedDebtOrder(page, ticketNo);
  await expect(drawer.locator('[data-testid="order-detail-balance"]')).toContainText("¥10.00");
  await drawer.locator('[data-testid="order-detail-payment-btn"]').click();
  await page.locator('input[name="payment-amount-cents"]').fill(yuanText("1000"));
  await page.getByRole("button", { name: "确认补缴" }).click();
  await expect(drawer.locator('[data-testid="order-detail-balance"]')).toContainText("¥0.00", {
    timeout: 15_000,
  });
  await drawer.locator('[data-testid="order-detail-close-btn"]').click();
}

async function fulfillAndRepayOrder(page: Page, id: string): Promise<void> {
  await fillPackagedReceiveForm(page, {
    phone: `138${id}`,
    name: `macOS 履约 ${id}`,
    paymentCents: "500",
  });
  const ticketNo = await receivePackagedOrder(page);
  await expect(page.locator(".ld-order-result")).toContainText("¥10.00", { timeout: 15_000 });
  await rackAndVerifyPickup(page, ticketNo);
  await repayPickedUpOrder(page, ticketNo);
}

/** Order parity: baseline workday plus hold, cancel, repayment and barcode fulfillment. */
export async function runPackagedOrderParity(page: Page): Promise<void> {
  const id = suffix();
  await runPackagedCounterWorkday(page);
  await assertHeldDraft(page, id);
  await cancelOpenOrder(page, id);
  await fulfillAndRepayOrder(page, id);
}

async function createBonusTier(
  page: Page,
  thresholdCents: number,
  bonusCents: number,
): Promise<Locator> {
  await page.locator('[data-nav-id="settings"]').click();
  const rules = page.locator('[data-testid="member-rules"]');
  await expect(rules).toBeVisible({ timeout: 15_000 });
  await rules.getByLabel("充满（元）").fill(yuanInput(thresholdCents));
  await rules.getByLabel("赠送（元）").fill(yuanInput(bonusCents));
  await rules.getByLabel("备注（可选）").fill("packaged macOS 会员验收");
  await rules.getByRole("button", { name: "新增档位" }).click();
  const confirmation = page.getByRole("dialog", { name: "确认修改赠送档位" });
  await expect(confirmation).toContainText(money(thresholdCents), { timeout: 15_000 });
  await expect(confirmation).toContainText(money(bonusCents));
  await confirmation.getByRole("button", { name: "确认保存" }).click();
  await expect(page.locator(".ld-toast").last()).toContainText("赠送档位已保存", {
    timeout: 15_000,
  });
  const row = rules.locator(".ld-member-rules__row").filter({
    hasText: money(thresholdCents),
  });
  await expect(row).toHaveCount(1, { timeout: 15_000 });
  return row;
}

async function createMemberCustomer(page: Page, id: string): Promise<Locator> {
  const name = `macOS 生命周期 ${id}`;
  await page.locator('[data-nav-id="customers"]').click();
  await page.locator('[data-testid="customers-phone-input"]').fill(`133${id}`);
  await page.locator('[data-testid="customers-name-input"]').fill(name);
  await page.locator('[data-testid="customers-upsert-btn"]').click();
  await expect(page.locator(".ld-toast").last()).toContainText("客户已保存", {
    timeout: 15_000,
  });
  await page.locator('[data-testid="customers-search-input"]').fill(name);
  await page.locator('[data-testid="customers-search-btn"]').click();
  const row = page.locator('[data-testid="customers-row"]', { hasText: name });
  await expect(row).toHaveCount(1, { timeout: 15_000 });
  await row.click();
  const member = page.locator('[aria-label="会员储值"]');
  await expect(member).toBeVisible({ timeout: 15_000 });
  await member.getByRole("button", { name: "开通会员账户" }).click();
  await expect(page.locator(".ld-toast").last()).toContainText("会员账户已开通", {
    timeout: 15_000,
  });
  return member;
}

async function topupMember(
  page: Page,
  member: Locator,
  thresholdCents: number,
  bonusCents: number,
): Promise<void> {
  await member.getByLabel("充值金额（元）").fill(yuanInput(thresholdCents));
  await member.getByRole("button", { name: "充值", exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: "确认会员充值" });
  await expect(confirmation).toContainText(money(thresholdCents), { timeout: 15_000 });
  await confirmation.getByRole("button", { name: "确认充值" }).click();
  await expect(page.locator(".ld-toast").last()).toContainText("充值已入账", {
    timeout: 15_000,
  });
  await expect(member.locator(".ld-member-panel__balance")).toContainText(
    money(thresholdCents + bonusCents),
  );
}

async function refundMember(
  page: Page,
  member: Locator,
  refundCents: number,
  admin: PackagedAdmin,
): Promise<void> {
  const refund = member.locator('[data-testid="member-refund"]');
  await refund.getByLabel("退款金额（元）").fill(yuanInput(refundCents));
  await refund.getByLabel("退款方式").selectOption("cash");
  await refund.getByLabel("退款原因").fill("packaged macOS 退款验收");
  await refund.getByRole("button", { name: "确认退款" }).click();
  await approveStepUp(page, admin.pin, FIXTURE.approverLabel);
  await expect(page.locator(".ld-toast").last()).toContainText("储值本金已退款", {
    timeout: 15_000,
  });
  await expect(
    member.locator(".ld-member-panel__row").filter({ hasText: "退款" }).first(),
  ).toContainText(`-${money(refundCents)}`);
}

async function freezeMember(page: Page, member: Locator, admin: PackagedAdmin): Promise<void> {
  await quickSwitch(page, FIXTURE.staff, admin.pin, "staff");
  await member.locator('[data-testid="member-freeze"]').click();
  const draft = page.getByRole("dialog", { name: "挂失并冻结会员账户" });
  await draft.getByLabel("操作原因").fill("packaged macOS 顾客报失");
  await draft.getByRole("button", { name: "继续确认" }).click();
  const confirmation = page.getByRole("dialog", { name: "确认挂失冻结" });
  await expect(confirmation).toContainText("禁止充值、余额消费和普通退款");
  await confirmation.getByRole("button", { name: "确认执行" }).click();
  await expect(member.locator('[data-testid="member-status"]')).toHaveText("挂失冻结", {
    timeout: 15_000,
  });
  await expect(member.getByLabel("充值金额（元）")).toHaveCount(0);
  await expect(member.locator('[data-testid="member-refund"]')).toHaveCount(0);
}

async function unfreezeAndCloseMember(
  page: Page,
  member: Locator,
  admin: PackagedAdmin,
): Promise<void> {
  await quickSwitch(page, FIXTURE.approver, admin.pin, "admin");
  await member.locator('[data-testid="member-unfreeze"]').click();
  const unfreeze = page.getByRole("dialog", { name: "解除会员账户挂失" });
  await unfreeze.getByLabel("操作原因").fill("packaged macOS 到店核验");
  await unfreeze.getByRole("button", { name: "继续确认" }).click();
  await page
    .getByRole("dialog", { name: "确认解除挂失" })
    .getByRole("button", {
      name: "确认执行",
    })
    .click();
  await expect(member.locator('[data-testid="member-status"]')).toHaveText("正常", {
    timeout: 15_000,
  });
  await member.locator('[data-testid="member-close"]').click();
  const close = page.getByRole("dialog", { name: "退卡并永久销户" });
  await close.getByLabel("本金退款渠道").selectOption("cash");
  await close.getByLabel("操作原因").fill("packaged macOS 退卡销户");
  await close.getByRole("button", { name: "继续确认" }).click();
  await approveStepUp(page, admin.pin, `${admin.displayName}（店长）`);
  await expect(member.locator('[data-testid="member-status"]')).toHaveText("已销户", {
    timeout: 15_000,
  });
  await expect(member.locator(".ld-member-panel__balance")).toContainText("¥0.00");
}

async function disableBonusTier(page: Page, row: Locator): Promise<void> {
  await page.locator('[data-nav-id="settings"]').click();
  await row.getByRole("button", { name: "停用" }).click();
  const confirmation = page.getByRole("dialog", { name: "确认修改赠送档位" });
  await expect(confirmation).toContainText("状态：停用", { timeout: 15_000 });
  await confirmation.getByRole("button", { name: "确认保存" }).click();
  await expect(row).toContainText("已停用", { timeout: 15_000 });
}

async function saveCustomer(page: Page, phone: string, name: string): Promise<void> {
  await page.locator('[data-testid="customers-phone-input"]').fill(phone);
  await page.locator('[data-testid="customers-name-input"]').fill(name);
  await page.locator('[data-testid="customers-upsert-btn"]').click();
  await expect(page.locator(".ld-toast").last()).toContainText("客户已保存", {
    timeout: 15_000,
  });
}

async function mergeDuplicateCustomers(
  page: Page,
  admin: PackagedAdmin,
  id: string,
): Promise<void> {
  await page.locator('[data-nav-id="customers"]').click();
  const name = `macOS 合并 ${id}`;
  await saveCustomer(page, `135${id}`, name);
  await saveCustomer(page, `131${id}`, name);
  await page.locator('[data-testid="customers-search-input"]').fill(name);
  await page.locator('[data-testid="customers-search-btn"]').click();
  const matches = page.locator('[data-testid="customers-row"]', { hasText: name });
  await expect(matches).toHaveCount(2, { timeout: 15_000 });
  await matches.first().click();
  const governance = page.locator('[aria-label="客户资料治理"]');
  await governance.getByRole("button", { name: "检查重复" }).click();
  await expect(governance.getByLabel("保留客户")).toHaveCount(1, { timeout: 15_000 });
  await governance.locator('input[name="customer-merge-reason"]').fill("packaged macOS 重复清理");
  await governance.getByRole("button", { name: "合并到保留客户" }).click();
  await approveStepUp(page, admin.pin, FIXTURE.approverLabel);
  await expect(matches).toHaveCount(1, { timeout: 15_000 });
}

async function exportAndAnonymizeCustomer(
  page: Page,
  admin: PackagedAdmin,
  id: string,
  downloadDirectory: string,
): Promise<void> {
  await page.locator('[data-nav-id="customers"]').click();
  const name = `macOS 隐私 ${id}`;
  const phone = `130${id}`;
  await saveCustomer(page, phone, name);
  await page.locator('[data-testid="customers-search-input"]').fill(name);
  await page.locator('[data-testid="customers-search-btn"]').click();
  const row = page.locator('[data-testid="customers-row"]', { hasText: name });
  await expect(row).toHaveCount(1, { timeout: 15_000 });
  await row.click();
  const privacy = page.locator('[aria-label="客户隐私与留存"]');
  await expect(privacy.locator('[data-testid="customer-privacy-status"]')).toContainText(
    "活动订单 0",
  );
  await privacy.locator('[data-testid="customer-privacy-reason"]').fill("packaged macOS 数据请求");
  await privacy.locator('[data-testid="customer-privacy-export"]').click();
  const [exportDownload] = await Promise.all([
    page.waitForEvent("download"),
    approveStepUp(page, admin.pin, FIXTURE.approverLabel),
  ]);
  const exported = JSON.parse(await downloadText(exportDownload, downloadDirectory)) as {
    customer?: { phone?: unknown; name?: unknown };
    order_count?: unknown;
  };
  expect(exported).toMatchObject({ customer: { phone, name }, order_count: 0 });
  await privacy.locator('[data-testid="customer-privacy-reason"]').fill("packaged macOS 匿名化");
  await privacy.locator('[data-testid="customer-privacy-confirmation"]').fill("ANONYMIZE");
  await privacy.locator('[data-testid="customer-privacy-anonymize"]').click();
  await approveStepUp(page, admin.pin, FIXTURE.approverLabel);
  await expect(page.locator('[data-testid="customer-detail"]')).toHaveCount(0, {
    timeout: 15_000,
  });
  await expect(page.locator('[data-testid="customers-row"]', { hasText: name })).toHaveCount(0);
}

/** Member parity: tier, balance pay, refund, freeze/unfreeze/close, merge and privacy. */
export async function runPackagedMemberParity(
  page: Page,
  admin: PackagedAdmin,
  downloadDirectory: string,
): Promise<void> {
  const id = suffix();
  const thresholdCents = 4_700_000 + (Number(id) % 90_000);
  const bonusCents = 12_345;
  await runPackagedMemberSettlement(page);
  const rule = await createBonusTier(page, thresholdCents, bonusCents);
  const member = await createMemberCustomer(page, id);
  await topupMember(page, member, thresholdCents, bonusCents);
  await refundMember(page, member, 5_000, admin);
  await freezeMember(page, member, admin);
  await unfreezeAndCloseMember(page, member, admin);
  await quickSwitch(page, admin.displayName, admin.pin, "admin");
  await disableBonusTier(page, rule);
  await mergeDuplicateCustomers(page, admin, id);
  await exportAndAnonymizeCustomer(page, admin, id, downloadDirectory);
}

async function exportPickupReminders(page: Page, downloadDirectory: string): Promise<void> {
  await page.locator('[data-nav-id="reminders"]').click();
  await expect(page.getByText("短信、微信未接入")).toBeVisible();
  const row = page.locator('[data-testid="pickup-reminder-row"]', {
    hasText: FIXTURE.reminderName,
  });
  await expect(row).toHaveCount(1, { timeout: 15_000 });
  await expect(row).toContainText(FIXTURE.reminderPhone);
  await row.getByRole("checkbox").check();
  await page.getByRole("button", { name: /生成名单并复制号码/u }).click();
  const dialog = page.getByRole("dialog", { name: "确认生成催取名单" });
  await expect(dialog).toContainText("不会发送短信或微信", { timeout: 15_000 });
  await expect(dialog).not.toContainText(/已发送|送达|通知成功/u);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    dialog.getByRole("button", { name: "确认生成名单" }).click(),
  ]);
  const csv = await downloadText(download, downloadDirectory);
  expect(download.suggestedFilename()).toMatch(/^pickup-reminders-\d{8}-[0-9a-f]{8}\.csv$/u);
  expect(csv).toContain(FIXTURE.reminderPhone);
  expect(csv).toContain(FIXTURE.reminderTicket);
  await expect(page.locator(".ld-toast").last()).toContainText("名单已生成", {
    timeout: 15_000,
  });
}

async function exportAccountingReport(page: Page, downloadDirectory: string): Promise<void> {
  await page.locator('[data-nav-id="stats"]').click();
  await expect(page.locator('[data-testid="accounting-report-panel"]')).toBeVisible();
  await page.locator('[data-testid="accounting-mode"]').selectOption("staff");
  await page.locator('[data-testid="accounting-date-from"]').fill(FIXTURE.accountingDate);
  await page.locator('[data-testid="accounting-date-to"]').fill(FIXTURE.accountingDate);
  await page.locator('[data-testid="accounting-load"]').click();
  const report = page.locator('[data-testid="accounting-report-result"]');
  await expect(report).toBeVisible({ timeout: 15_000 });
  const realIncome = report.locator(".ld-stats-card").filter({ hasText: "实收" }).first();
  const performance = report.locator(".ld-stats-card").filter({ hasText: "业绩" }).first();
  await expect(realIncome.locator('[data-fen="13000"]')).toHaveCount(1);
  await expect(performance.locator('[data-fen="8000"]')).toHaveCount(1);
  await page.locator('[data-testid="accounting-export"]').click();
  const confirmation = page.getByRole("dialog", { name: "确认导出账目报表" });
  await expect(confirmation).toContainText(`营业日 ${FIXTURE.accountingDate}`, {
    timeout: 15_000,
  });
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    confirmation.getByRole("button", { name: "确认导出" }).click(),
  ]);
  const csv = await downloadText(download, downloadDirectory);
  expect(download.suggestedFilename()).toBe(
    `accounting-${FIXTURE.accountingDate}-${FIXTURE.accountingDate}-staff.csv`,
  );
  expect(csv).toContain('"totals","all","合计","13000","8000"');
  expect(csv).toContain(FIXTURE.staff);
  await expect(page.locator(".ld-toast").last()).toContainText("账目 CSV 已完成完整性校验");
}

async function closeAndExportShift(page: Page, downloadDirectory: string): Promise<void> {
  await page.locator('[data-nav-id="stats"]').click();
  await page.locator('[data-testid="stats-date-input"]').fill(SHIFT_DATE);
  await page.locator('[data-testid="stats-load-btn"]').click();
  const snapshot = page.locator(
    `[data-testid="reconciliation-snapshot"][data-business-date="${SHIFT_DATE}"]`,
  );
  await expect(snapshot).toBeVisible({ timeout: 15_000 });
  const reconciliationDownload = page.waitForEvent("download");
  await page.locator('[data-testid="stats-export-csv-btn"]').click();
  const reconciliation = await reconciliationDownload;
  expect(reconciliation.suggestedFilename()).toBe(`reconciliation-${SHIFT_DATE}.csv`);
  expect(await downloadText(reconciliation, downloadDirectory)).toContain(
    `"meta","business_date","","${SHIFT_DATE}"`,
  );
  const signature = page.locator('[data-testid="shift-signature-input"]');
  await expect(signature).toBeVisible({ timeout: 15_000 });
  await signature.fill("packaged macOS 交班");
  await page.locator('[data-testid="shift-note-input"]').fill("packaged macOS 历史 CSV");
  await page.locator('[data-testid="shift-close-btn"]').click();
  await expect(page.locator('[data-testid="shift-closed-status"]')).toBeVisible({
    timeout: 15_000,
  });
  await page.locator('input[name="shift-history-from"]').fill(SHIFT_DATE);
  await page.locator('input[name="shift-history-to"]').fill(SHIFT_DATE);
  await page.getByRole("button", { name: "查询历史" }).click();
  const history = page.locator('[aria-label="交班历史"]');
  await expect(history.getByRole("cell", { name: SHIFT_DATE })).toBeVisible({ timeout: 15_000 });
  const [historyDownload] = await Promise.all([
    page.waitForEvent("download"),
    history.getByRole("button", { name: "导出历史 CSV" }).click(),
  ]);
  expect(historyDownload.suggestedFilename()).toBe(`shift-history-${SHIFT_DATE}-${SHIFT_DATE}.csv`);
  expect(await downloadText(historyDownload, downloadDirectory)).toContain(
    `"${SHIFT_DATE}","packaged macOS 交班"`,
  );
}

/** Reports parity reuses only the Browser fixtures installed by local:acceptance. */
export async function runPackagedReportsParity(
  page: Page,
  downloadDirectory: string,
): Promise<void> {
  await exportPickupReminders(page, downloadDirectory);
  await exportAccountingReport(page, downloadDirectory);
  await closeAndExportShift(page, downloadDirectory);
}

/** Settings parity checks and exercises the current packaged-only device surface. */
export async function runPackagedSettingsParity(page: Page, admin: PackagedAdmin): Promise<void> {
  await page.locator('[data-nav-id="settings"]').click();
  await expect(page.locator('[data-testid="catalog-admin"]')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-testid="member-rules"]')).toBeVisible();
  const staff = page.locator('[data-testid="staff-access"]');
  await expect(staff).toContainText(FIXTURE.staff);
  await expect(staff).toContainText(FIXTURE.approver);
  await expect(page.getByRole("region", { name: "离线同步" })).toContainText(
    "当前没有需要人工处理",
  );
  const printer = page.locator('[data-testid="printer-settings"]');
  await expect(printer).toBeVisible();
  await expect(printer.getByRole("status")).toHaveText(/已启用|未启用|不可用/u, {
    timeout: 15_000,
  });
  await printer.getByRole("button", { name: "刷新队列" }).click();
  await expect(page.locator(".ld-toast").last()).toContainText("已刷新本机打印队列", {
    timeout: 15_000,
  });
  await expect(printer).toContainText("系统打印后台接单不等于实际出纸");
  await expect(page.locator('[data-testid="printer-smoke-section"]')).toContainText(
    "旧版 USB / Windows CLI 诊断",
  );
  await expect(page.locator('[data-testid="printer-smoke-cli-hint"]')).toContainText("--validate");
  const setting = `${1_600 + (Number(suffix()) % 200)}`;
  await page.locator('input[name="min-order-cents"]').fill(setting);
  await page.getByRole("button", { name: "保存（可能需复核）" }).click();
  await approveStepUp(page, admin.pin, FIXTURE.approverLabel);
  await expect(page.locator(".ld-settings-form__saved")).toContainText(`${setting} 分`, {
    timeout: 15_000,
  });
}
