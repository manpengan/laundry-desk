import { expect, test, type Page } from "@playwright/test";
import { yuanText } from "./money-input.js";

const WEB = "http://127.0.0.1:5173";
const API = "http://127.0.0.1:8787";

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

const LOGIN = Object.freeze({
  orgCode: requiredEnvironment("LAUNDRY_LOCAL_ORG_CODE"),
  storeCode: requiredEnvironment("LAUNDRY_LOCAL_STORE_CODE"),
  username: requiredEnvironment("LAUNDRY_BOOTSTRAP_ADMIN_USERNAME"),
  password: requiredEnvironment("LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD"),
  pin: requiredEnvironment("LAUNDRY_BOOTSTRAP_ADMIN_PIN"),
});
const SUFFIX = `${process.pid.toString(36)}${Date.now().toString(36).slice(-6)}`.toLowerCase();
const FIXTURE = Object.freeze({
  catalogCode: `e2e_profile_${SUFFIX}`,
  catalogName: `E2E 档案洗护 ${SUFFIX}`,
  customerName: `E2E 档案顾客 ${SUFFIX}`,
  customerPhone: `132${Date.now().toString().slice(-8)}`,
  tierCode: `profile_tier_${SUFFIX}`,
  tierName: `E2E 档案银卡 ${SUFFIX}`,
  identifier: `E2E-${SUFFIX}`,
  normalizedIdentifier: `e2e${SUFFIX}`,
});

async function signIn(page: Page): Promise<void> {
  await page.goto(WEB);
  await page.locator('input[name="org_code"]').fill(LOGIN.orgCode);
  await page.locator('input[name="store_code"]').fill(LOGIN.storeCode);
  await page.locator('input[name="username"]').fill(LOGIN.username);
  await page.locator('input[name="password"]').fill(LOGIN.password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.locator('[data-shell="counter"]')).toBeVisible({ timeout: 15_000 });
}

async function createCatalogAndTier(page: Page): Promise<void> {
  await page.locator('[data-nav-id="settings"]').click();
  const catalog = page.locator('[data-testid="catalog-admin"]');
  await catalog.locator('input[name="catalog-code"]').fill(FIXTURE.catalogCode);
  await catalog.locator('input[name="catalog-name"]').fill(FIXTURE.catalogName);
  await catalog.locator('input[name="catalog-service"]').fill("dry");
  await catalog.locator('input[name="catalog-category"]').fill(`profile_${SUFFIX}`);
  await catalog.locator('input[name="catalog-price"]').fill(yuanText("2600"));
  await catalog.locator('[data-testid="catalog-save-btn"]').click();
  await expect(
    catalog.locator('[data-testid="catalog-admin-row"]', { hasText: FIXTURE.catalogCode }),
  ).toBeVisible({ timeout: 15_000 });

  const definitions = page.locator('[data-testid="benefit-definitions"]');
  await definitions.getByLabel("类型").selectOption("tier");
  await definitions.getByLabel("代码").fill(FIXTURE.tierCode);
  await definitions.getByLabel("名称").fill(FIXTURE.tierName);
  await definitions.getByLabel("等级序号").fill("8");
  await definitions.getByLabel("等级折扣（%）").fill("8");
  await definitions.getByLabel("备注（可选）").fill("ADR-42 Chromium 验收");
  await definitions.getByRole("button", { name: "新增定义" }).click();
  const dialog = page.getByRole("dialog", { name: "确认修改会员权益定义" });
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await dialog.getByRole("button", { name: "确认保存" }).click();
  await expect(page.locator(".ld-toast").last()).toContainText("会员权益定义已保存", {
    timeout: 15_000,
  });
}

async function createCustomerAndAssignTier(page: Page): Promise<void> {
  await page.locator('[data-nav-id="customers"]').click();
  await page.locator('[data-testid="customers-phone-input"]').fill(FIXTURE.customerPhone);
  await page.locator('[data-testid="customers-name-input"]').fill(FIXTURE.customerName);
  await page.locator('[data-testid="customers-upsert-btn"]').click();
  await page.locator('[data-testid="customers-search-input"]').fill(FIXTURE.customerName);
  await page.locator('[data-testid="customers-search-btn"]').click();
  await page.locator('[data-testid="customers-row"]', { hasText: FIXTURE.customerName }).click();

  const storedValue = page.locator('[aria-label="会员储值"]');
  await storedValue.getByRole("button", { name: "开通会员账户" }).click();
  await expect(page.locator(".ld-toast").last()).toContainText("会员账户已开通", {
    timeout: 15_000,
  });
  const benefits = page.locator('[data-testid="member-benefits-panel"]');
  const reloadBenefits = page.locator(".ld-member-benefits").getByRole("button", {
    name: "重新读取",
  });
  if (await reloadBenefits.isVisible()) await reloadBenefits.click();
  await expect(benefits).toBeVisible({ timeout: 15_000 });
  await benefits.getByLabel("等级").selectOption({ label: `${FIXTURE.tierName}（L8）` });
  await benefits.getByLabel("有效至").fill("2099-12-31");
  await benefits.getByLabel("变更原因").fill("ADR-42 等级折扣验收");
  await benefits.getByRole("button", { name: "保存等级" }).click();
  const dialog = page.getByRole("dialog", { name: "确认会员等级变更" });
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await dialog.getByRole("button", { name: "确认执行" }).click();
  await expect(page.locator(".ld-toast").last()).toContainText("会员等级已更新", {
    timeout: 15_000,
  });
}

async function saveExtendedProfile(page: Page): Promise<void> {
  const profile = page.locator('[data-testid="customer-profile-panel"]');
  await expect(profile).toBeVisible({ timeout: 15_000 });
  await profile.getByLabel("称谓 / 性别").selectOption("female");
  await profile.getByLabel("首选联系渠道").selectOption("wechat");
  await profile.getByLabel("服务偏好（内部）").fill("低温精洗，独立包装");
  await profile.getByLabel("跳过小票打印").check();
  await profile.getByLabel("跳过衣物标签打印").check();
  await profile.getByLabel("跳过上挂分配").check();

  await profile.locator('[data-testid="customer-profile-address-add"]').click();
  const address = profile.getByRole("group", { name: "地址 1" });
  await address.getByLabel("标签").fill("公司");
  await address.getByLabel("收件人（可选）").fill(FIXTURE.customerName);
  await address.getByLabel("联系电话（可选）").fill(FIXTURE.customerPhone);
  await address.getByLabel("地址", { exact: true }).fill(`ADR-42 Road ${SUFFIX}`);

  await profile.locator('[data-testid="customer-profile-identifier-add"]').click();
  const identifier = profile.getByRole("group", { name: "标识 1" });
  await identifier.getByLabel("类型").selectOption("vehicle_plate");
  await identifier.getByLabel("值").fill(FIXTURE.identifier);
  await profile.locator('[data-testid="customer-profile-reason"]').fill("ADR-42 档案验收");
  await profile.locator('[data-testid="customer-profile-save"]').click();

  const dialog = page.getByRole("dialog", { name: "确认顾客档案变更" });
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await dialog.getByRole("button", { name: "确认保存" }).click();
  await expect(page.locator(".ld-toast").last()).toContainText("顾客扩展档案更新完成", {
    timeout: 15_000,
  });
  await expect(profile).toContainText("版本 1");
  await expect(profile.getByLabel("服务偏好（内部）")).toHaveValue("低温精洗，独立包装");
}

async function receiveOrder(page: Page): Promise<string> {
  await page.locator('[data-nav-id="receive"]').click();
  await page
    .locator('[data-testid="catalog-picker"]')
    .getByRole("option", { name: new RegExp(FIXTURE.catalogName, "u") })
    .click();
  await page.locator('input[name="customer-phone"]').fill(FIXTURE.customerPhone);
  await page.locator('input[name="customer-name"]').fill(FIXTURE.customerName);
  await page.getByRole("button", { name: "确认开单" }).click();
  const ticket = (await page.locator('[data-testid="receive-ticket"]').innerText()).trim();
  expect(ticket).not.toHaveLength(0);
  return ticket;
}

async function openOrderDetail(page: Page, ticket: string): Promise<void> {
  await page.locator('[data-nav-id="orders"]').click();
  await page.locator('[data-testid="debt-load-btn"]').click();
  const row = page.locator('[data-testid="debt-row"]', { hasText: ticket });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.locator('[data-testid="debt-row-detail-btn"]').click();
  await expect(page.locator('[data-testid="order-detail-drawer"]')).toBeVisible({
    timeout: 15_000,
  });
}

async function approveDiscountPolicy(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "需要现场复核" });
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await dialog.locator(".ld-step-up__select").selectOption({ label: "E2E Staff Two（店长）" });
  await dialog.locator('input[name="step-up-pin"]').fill(LOGIN.pin);
  await dialog.getByRole("button", { name: "确认 PIN" }).click();
  await expect(page.getByText("顾客折扣政策更新完成", { exact: true })).toBeVisible({
    timeout: 15_000,
  });
}

test.beforeAll(async ({ request }) => {
  const health = await request.get(`${API}/health`);
  expect(health.ok(), `API ${API}/health must be up`).toBeTruthy();
});

test.setTimeout(150_000);

test("customer profiles, identifier search, pricing snapshots and waivers complete a real PostgreSQL browser journey", async ({
  page,
}) => {
  await signIn(page);
  await createCatalogAndTier(page);
  await createCustomerAndAssignTier(page);
  await saveExtendedProfile(page);

  await page.locator('[data-testid="customer-detail-close"]').click();
  await page.locator('[data-testid="customers-search-input"]').fill(FIXTURE.normalizedIdentifier);
  await page.locator('[data-testid="customers-search-btn"]').click();
  await expect(
    page.locator('[data-testid="customers-row"]', { hasText: FIXTURE.customerName }),
  ).toBeVisible({ timeout: 15_000 });

  const tierTicket = await receiveOrder(page);
  await expect(page.locator('[data-testid="receive-discount-source"]')).toHaveText("会员等级 8%");
  await expect(page.locator('[data-testid="receive-waivers"]')).toHaveText(
    "跳过小票打印、跳过衣物标签打印、跳过上挂分配",
  );
  await expect(page.locator('[data-testid="ticket-print-button"]')).toBeDisabled();
  await expect(page.locator('[data-testid="ticket-print-waiver"]')).toHaveText(
    "小票打印已按顾客档案豁免跳过。",
  );

  await openOrderDetail(page, tierTicket);
  await expect(page.locator('[data-testid="order-detail-discount-source"]')).toHaveText(
    `${FIXTURE.tierName} 8%`,
  );
  await expect(page.locator('[data-testid="order-detail-waivers"]')).toHaveText(
    "跳过小票打印、跳过衣物标签打印、跳过上挂分配",
  );
  await page.locator('[data-testid="order-detail-close-btn"]').click();

  await page.locator('[data-nav-id="customers"]').click();
  await page.locator('[data-testid="customers-search-input"]').fill(FIXTURE.customerName);
  await page.locator('[data-testid="customers-search-btn"]').click();
  await page.locator('[data-testid="customers-row"]', { hasText: FIXTURE.customerName }).click();
  const profile = page.locator('[data-testid="customer-profile-panel"]');
  const discountPolicy = profile.getByRole("region", { name: "顾客折扣政策" });
  await discountPolicy.getByRole("combobox").selectOption("customer");
  await profile.locator('[data-testid="customer-discount-percent"]').fill("12.5");
  await profile.getByLabel("折扣变更原因").fill("ADR-42 顾客专属折扣验收");
  await profile.locator('[data-testid="customer-discount-save"]').click();
  await approveDiscountPolicy(page);
  await expect(profile).toContainText("顾客专属 12.5%");

  const customerTicket = await receiveOrder(page);
  await expect(page.locator('[data-testid="receive-discount-source"]')).toHaveText(
    "顾客专属 12.5%",
  );
  await openOrderDetail(page, customerTicket);
  await expect(page.locator('[data-testid="order-detail-discount-source"]')).toHaveText(
    "顾客专属 12.5%",
  );
  await expect(page.locator('[data-testid="order-detail-payable"]')).toContainText("¥22.75");
});
