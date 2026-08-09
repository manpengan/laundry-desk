import { expect, type Locator, type Page } from "@playwright/test";

export const PACKAGED_CATALOG = Object.freeze({
  code: "mac_wash_shirt",
  name: "macOS 水洗衬衫",
  service: "wash",
  category: "macshirt",
  priceCents: "1500",
});

export const PACKAGED_MEMBER = Object.freeze({
  phone: "13900000042",
  name: "macOS 顾客",
  topupYuan: "50",
  remainingBalance: "¥35.00",
});

const VALID_JPEG = Buffer.from(
  "/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAACAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAABf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AIgAAaf/2Q==",
  "base64",
);
if (VALID_JPEG.byteLength !== 268) throw new Error("packaged JPEG fixture is incomplete");

export type ReceiveDraft = Readonly<{
  phone: string;
  name: string;
  paymentCents?: string;
  quantity?: number;
}>;

export async function ensurePackagedCatalog(page: Page): Promise<void> {
  await page.locator('[data-nav-id="settings"]').click();
  const panel = page.locator('[data-testid="catalog-admin"]');
  await expect(panel).toBeVisible({ timeout: 15_000 });
  await page.locator('input[name="catalog-code"]').fill(PACKAGED_CATALOG.code);
  await page.locator('input[name="catalog-name"]').fill(PACKAGED_CATALOG.name);
  await page.locator('input[name="catalog-service"]').fill(PACKAGED_CATALOG.service);
  await page.locator('input[name="catalog-category"]').fill(PACKAGED_CATALOG.category);
  await page.locator('input[name="catalog-price"]').fill(PACKAGED_CATALOG.priceCents);
  await page.locator('[data-testid="catalog-save-btn"]').click();
  await expect(
    panel.locator('[data-testid="catalog-admin-row"]', { hasText: PACKAGED_CATALOG.name }),
  ).toBeVisible({ timeout: 15_000 });
}

export async function fillPackagedReceiveForm(page: Page, draft: ReceiveDraft): Promise<void> {
  await page.locator('[data-nav-id="receive"]').click();
  const picker = page.locator('[data-testid="catalog-picker"]');
  await expect(picker).toBeVisible({ timeout: 15_000 });
  await picker.getByRole("option", { name: new RegExp(PACKAGED_CATALOG.name, "u") }).click();
  if (draft.quantity !== undefined) {
    await page.getByLabel("数量").fill(String(draft.quantity));
  }
  await page.locator('input[name="customer-phone"]').fill(draft.phone);
  await page.locator('input[name="customer-name"]').fill(draft.name);
  await page.locator('input[name="initial-payment"]').fill(draft.paymentCents ?? "0");
}

export async function receivePackagedOrder(page: Page): Promise<string> {
  await page.getByRole("button", { name: /确认(?:挂单并)?开单/u }).click();
  const ticket = page.locator('[data-testid="receive-ticket"]');
  await expect(ticket).toBeVisible({ timeout: 15_000 });
  const ticketNo = (await ticket.innerText()).trim();
  expect(ticketNo.length).toBeGreaterThan(0);
  return ticketNo;
}

export async function openPackagedDebtOrder(page: Page, key: string): Promise<Locator> {
  await page.locator('[data-nav-id="orders"]').click();
  await page.locator('[data-testid="debt-load-btn"]').click();
  const row = page.locator('[data-testid="debt-row"]').filter({ hasText: key }).first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.locator('[data-testid="debt-row-detail-btn"]').click();
  const drawer = page.locator('[data-testid="order-detail-drawer"]');
  await expect(drawer).toBeVisible({ timeout: 15_000 });
  return drawer;
}

async function registerDurablePhoto(page: Page, ticketNo: string): Promise<void> {
  const drawer = await openPackagedDebtOrder(page, ticketNo);
  const photoCount = drawer.locator('[data-testid="order-detail-photo-count"]');
  const photoInput = drawer.locator('[data-testid="order-detail-register-photo-btn"]');
  await expect(photoCount).toHaveText("0 张", { timeout: 15_000 });
  await expect(photoInput).toBeEnabled();
  await photoInput.setInputFiles({
    name: "mac-receive.jpg",
    mimeType: "image/jpeg",
    buffer: VALID_JPEG,
  });
  await expect(page.locator(".ld-toast").last()).toContainText("照片已安全保存", {
    timeout: 15_000,
  });
  await expect(photoCount).toHaveText("1 张", {
    timeout: 15_000,
  });
  await drawer.locator('[data-testid="order-detail-close-btn"]').click();
}

async function settleAtPickup(page: Page, ticketNo: string): Promise<void> {
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
  const result = page.locator(".ld-order-result").last();
  await expect(result).toContainText("¥30.00");
  await expect(result).toContainText("¥0.00");
}

/** Shared packaged baseline: catalog -> partial payment -> photo -> pickup settlement. */
export async function runPackagedCounterWorkday(page: Page): Promise<void> {
  await ensurePackagedCatalog(page);
  await fillPackagedReceiveForm(page, {
    phone: PACKAGED_MEMBER.phone,
    name: PACKAGED_MEMBER.name,
    paymentCents: "1000",
    quantity: 2,
  });
  const ticketNo = await receivePackagedOrder(page);
  const result = page.locator(".ld-order-result");
  await expect(result).toContainText("¥30.00");
  await expect(result).toContainText("¥20.00");
  await registerDurablePhoto(page, ticketNo);
  await settleAtPickup(page, ticketNo);
}

async function selectPackagedMember(page: Page): Promise<Locator> {
  await page.locator('[data-testid="customers-search-input"]').fill(PACKAGED_MEMBER.name);
  await page.locator('[data-testid="customers-search-btn"]').click();
  const customer = page.locator('[data-testid="customers-row"]', {
    hasText: PACKAGED_MEMBER.name,
  });
  await expect(customer).toHaveCount(1, { timeout: 15_000 });
  await customer.click();
  const member = page.locator('[aria-label="会员储值"]');
  await expect(member).toBeVisible({ timeout: 15_000 });
  return member;
}

async function openAndTopupPackagedMember(page: Page): Promise<void> {
  await page.locator('[data-nav-id="customers"]').click();
  const member = await selectPackagedMember(page);
  await expect(member.getByText("尚未开通会员")).toBeVisible({ timeout: 15_000 });
  await member.getByRole("button", { name: "开通会员账户" }).click();
  await expect(page.locator(".ld-toast").last()).toContainText("会员账户已开通", {
    timeout: 15_000,
  });
  await member.getByLabel("充值金额（元）").fill(PACKAGED_MEMBER.topupYuan);
  await member.getByRole("button", { name: "充值", exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: "确认会员充值" });
  await expect(confirmation).toContainText("充值本金 ¥50.00", { timeout: 15_000 });
  await confirmation.getByRole("button", { name: "确认充值" }).click();
  await expect(page.locator(".ld-toast").last()).toContainText("充值已入账", {
    timeout: 15_000,
  });
  await expect(member).toContainText("¥50.00", { timeout: 15_000 });
}

async function createUnpaidPackagedMemberOrder(page: Page): Promise<string> {
  await fillPackagedReceiveForm(page, {
    phone: PACKAGED_MEMBER.phone,
    name: PACKAGED_MEMBER.name,
  });
  const ticketNo = await receivePackagedOrder(page);
  await expect(page.locator(".ld-order-result")).toContainText("¥15.00");
  return ticketNo;
}

async function settlePackagedOrderFromBalance(page: Page, ticketNo: string): Promise<void> {
  const drawer = await openPackagedDebtOrder(page, ticketNo);
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

async function assertPackagedMemberSettlement(page: Page): Promise<void> {
  await page.locator('[data-nav-id="customers"]').click();
  const member = await selectPackagedMember(page);
  await expect(member).toContainText(PACKAGED_MEMBER.remainingBalance, { timeout: 15_000 });
  await page.locator('[data-nav-id="stats"]').click();
  await page.locator('[data-testid="stats-load-btn"]').click();
  const snapshot = page.locator('[data-testid="reconciliation-snapshot"]');
  await expect(snapshot).toBeVisible({ timeout: 15_000 });
  const balance = snapshot.getByRole("row").filter({ hasText: "会员余额" });
  await expect(balance).toHaveCount(1);
  await expect(balance).toContainText("收款");
  await expect(balance).toContainText("¥15.00");
}

/** Shared packaged stored-value baseline retained from the original macOS smoke. */
export async function runPackagedMemberSettlement(page: Page): Promise<void> {
  await openAndTopupPackagedMember(page);
  const ticketNo = await createUnpaidPackagedMemberOrder(page);
  await settlePackagedOrderFromBalance(page, ticketNo);
  await assertPackagedMemberSettlement(page);
}
