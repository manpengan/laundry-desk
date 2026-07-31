/**
 * Browser acceptance for production/rack/pickup, R4 customer merge and shift
 * history CSV. Every flow uses the public SPA against isolated real PostgreSQL.
 */
import { readFile } from "node:fs/promises";

import { expect, test, type Page } from "@playwright/test";

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
const CATALOG = Object.freeze({
  code: "e2e_operations_jacket",
  name: "E2E 运营夹克",
  service: "dry",
  category: "operations",
  priceCents: "2600",
});
const SHIFT_DATE = "1999-12-30";

async function signIn(page: Page): Promise<void> {
  await page.goto(WEB);
  await expect(page.locator('[data-page="login"]')).toBeVisible();
  await page.locator('input[name="org_code"]').fill(LOGIN.orgCode);
  await page.locator('input[name="store_code"]').fill(LOGIN.storeCode);
  await page.locator('input[name="username"]').fill(LOGIN.username);
  await page.locator('input[name="password"]').fill(LOGIN.password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.locator('[data-shell="counter"]')).toBeVisible({ timeout: 15_000 });
}

async function ensureCatalogItem(page: Page): Promise<void> {
  await page.locator('[data-nav-id="settings"]').click();
  const panel = page.locator('[data-testid="catalog-admin"]');
  await expect(panel).toBeVisible();
  await page.locator('input[name="catalog-code"]').fill(CATALOG.code);
  await page.locator('input[name="catalog-name"]').fill(CATALOG.name);
  await page.locator('input[name="catalog-service"]').fill(CATALOG.service);
  await page.locator('input[name="catalog-category"]').fill(CATALOG.category);
  await page.locator('input[name="catalog-price"]').fill(CATALOG.priceCents);
  await page.locator('[data-testid="catalog-save-btn"]').click();
  await expect(
    panel.locator('[data-testid="catalog-admin-row"]', { hasText: CATALOG.name }),
  ).toBeVisible({ timeout: 15_000 });
}

async function saveCustomer(page: Page, phone: string, name: string): Promise<void> {
  await page.locator('[data-testid="customers-phone-input"]').fill(phone);
  await page.locator('[data-testid="customers-name-input"]').fill(name);
  await page.locator('[data-testid="customers-upsert-btn"]').click();
  await expect(page.locator(".ld-toast").last()).toContainText("客户已保存", {
    timeout: 15_000,
  });
}

test.beforeAll(async ({ request }) => {
  const health = await request.get(`${API}/health`);
  expect(health.ok(), `API ${API}/health must be up`).toBeTruthy();
});

test("production workbench racks and verifies a real garment before pickup", async ({ page }) => {
  await signIn(page);
  await ensureCatalogItem(page);

  await page.locator('[data-nav-id="receive"]').click();
  const picker = page.locator('[data-testid="catalog-picker"]');
  await picker.getByRole("option", { name: new RegExp(CATALOG.name, "u") }).click();
  await page.locator('input[name="customer-phone"]').fill(`133${Date.now().toString().slice(-8)}`);
  await page.locator('input[name="customer-name"]').fill("E2E 生产顾客");
  await page.getByRole("button", { name: "确认开单" }).click();
  const ticketNo = (await page.locator('[data-testid="receive-ticket"]').innerText()).trim();

  await page.locator('[data-nav-id="fulfillment"]').click();
  await page.locator('input[name="fulfillment-key"]').fill(ticketNo);
  await page.getByRole("button", { name: "刷新" }).click();
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
  await page.locator('input[name="rack-zone"]').fill("A");
  await page.locator('input[name="rack-slot"]').fill("01");
  await page.getByRole("button", { name: "扫码上架" }).click();
  await expect(row).toContainText("待取", { timeout: 15_000 });
  await expect(row).toContainText("A-01");

  await page.locator('[data-nav-id="pickup"]').click();
  await page.locator('input[name="pickup-key"]').fill(ticketNo);
  await page.getByRole("button", { name: "加载订单" }).click();
  await expect(page.locator('[data-testid="pickup-loaded-ticket"]')).toHaveText(ticketNo);
  const pickupButton = page.getByRole("button", { name: "确认取衣" });
  await expect(pickupButton).toBeDisabled();

  await page.locator('input[name="pickup-verification-barcode"]').fill("WRONG");
  await page.getByRole("button", { name: "确认扫码" }).click();
  await expect(page.locator(".ld-toast").last()).toContainText("条码不属于");
  await expect(pickupButton).toBeDisabled();

  await page.locator('input[name="pickup-verification-barcode"]').fill(barcode);
  await page.getByRole("button", { name: "确认扫码" }).click();
  await expect(page.getByText("已扫码复核")).toBeVisible();
  await expect(pickupButton).toBeEnabled();
  await pickupButton.click();
  await expect(page.locator('[data-testid="pickup-ticket"]')).toHaveText(ticketNo);
});

test("duplicate customers require another staff PIN and leave one active profile", async ({
  page,
}) => {
  await signIn(page);
  await page.locator('[data-nav-id="customers"]').click();
  const suffix = Date.now().toString().slice(-8);
  const duplicateName = `E2E 合并 ${suffix}`;
  await saveCustomer(page, `135${suffix}`, duplicateName);
  await saveCustomer(page, `136${suffix}`, duplicateName);

  await page.locator('[data-testid="customers-search-input"]').fill(duplicateName);
  await page.locator('[data-testid="customers-search-btn"]').click();
  const matches = page.locator('[data-testid="customers-row"]', { hasText: duplicateName });
  await expect(matches).toHaveCount(2, { timeout: 15_000 });
  await matches.first().click();

  const governance = page.locator('[aria-label="客户资料治理"]');
  await governance.getByRole("button", { name: "检查重复" }).click();
  await expect(governance.getByLabel("保留客户")).toHaveCount(1, { timeout: 15_000 });
  await governance.locator('input[name="customer-merge-reason"]').fill("E2E 重复资料清理");
  await governance.getByRole("button", { name: "合并到保留客户" }).click();

  await expect(page.getByRole("dialog", { name: "需要现场复核" })).toBeVisible({
    timeout: 15_000,
  });
  await page.locator(".ld-step-up__select").selectOption({ label: "E2E Staff One" });
  await page.locator('input[name="step-up-pin"]').fill(LOGIN.pin);
  await page.getByRole("button", { name: "确认 PIN" }).click();

  await expect(matches).toHaveCount(1, { timeout: 15_000 });
  await expect(page.locator(".ld-toast").last()).toContainText("重复客户合并完成");
});

test("customer export is audited before irreversible anonymization", async ({ page }) => {
  await signIn(page);
  await page.locator('[data-nav-id="customers"]').click();
  const suffix = Date.now().toString().slice(-8);
  const customerName = `E2E 隐私 ${suffix}`;
  const customerPhone = `137${suffix}`;
  await saveCustomer(page, customerPhone, customerName);

  await page.locator('[data-testid="customers-search-input"]').fill(customerName);
  await page.locator('[data-testid="customers-search-btn"]').click();
  const match = page.locator('[data-testid="customers-row"]', { hasText: customerName });
  await expect(match).toHaveCount(1, { timeout: 15_000 });
  await match.click();

  const privacy = page.locator('[aria-label="客户隐私与留存"]');
  await expect(privacy.locator('[data-testid="customer-privacy-status"]')).toContainText(
    "活动订单 0",
    { timeout: 15_000 },
  );
  await privacy.locator('[data-testid="customer-privacy-reason"]').fill("E2E 客户数据请求");
  await privacy.locator('[data-testid="customer-privacy-export"]').click();
  await expect(page.getByRole("dialog", { name: "需要现场复核" })).toBeVisible({
    timeout: 15_000,
  });
  await page.locator(".ld-step-up__select").selectOption({ label: "E2E Staff Two（店长）" });
  await page.locator('input[name="step-up-pin"]').fill(LOGIN.pin);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "确认 PIN" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^customer-privacy-.*\.json$/u);
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  const exported = JSON.parse(await readFile(downloadPath!, "utf8")) as {
    customer: { phone: string; name: string };
    order_count: number;
    truncated: boolean;
  };
  expect(exported.customer).toEqual(
    expect.objectContaining({ phone: customerPhone, name: customerName }),
  );
  expect(exported.order_count).toBe(0);
  expect(exported.truncated).toBe(false);
  await expect(privacy.locator('[data-testid="customer-privacy-events"]')).toContainText("已导出", {
    timeout: 15_000,
  });

  await privacy.locator('[data-testid="customer-privacy-reason"]').fill("E2E 客户确认匿名化");
  await privacy.locator('[data-testid="customer-privacy-confirmation"]').fill("ANONYMIZE");
  await privacy.locator('[data-testid="customer-privacy-anonymize"]').click();
  await expect(page.getByRole("dialog", { name: "需要现场复核" })).toBeVisible({
    timeout: 15_000,
  });
  await page.locator(".ld-step-up__select").selectOption({ label: "E2E Staff Two（店长）" });
  await page.locator('input[name="step-up-pin"]').fill(LOGIN.pin);
  await page.getByRole("button", { name: "确认 PIN" }).click();

  await expect(page.locator('[data-testid="customer-detail"]')).toHaveCount(0, {
    timeout: 15_000,
  });
  await expect(
    page.locator('[data-testid="customers-row"]', { hasText: customerName }),
  ).toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator(".ld-toast").last()).toContainText("不可逆匿名化");
});

test("historic shift close is queryable and exported as bounded CSV", async ({ page }) => {
  await signIn(page);
  await page.locator('[data-nav-id="stats"]').click();
  await page.locator('[data-testid="stats-date-input"]').fill(SHIFT_DATE);
  await page.locator('[data-testid="stats-load-btn"]').click();
  const snapshot = page.locator(
    `[data-testid="reconciliation-snapshot"][data-business-date="${SHIFT_DATE}"]`,
  );
  await expect(snapshot).toBeVisible({ timeout: 15_000 });
  await expect(snapshot.getByRole("heading", { name: "支付账本" })).toBeVisible();

  const reconciliationDownloadPromise = page.waitForEvent("download");
  await page.locator('[data-testid="stats-export-csv-btn"]').click();
  const reconciliationDownload = await reconciliationDownloadPromise;
  expect(reconciliationDownload.suggestedFilename()).toBe(`reconciliation-${SHIFT_DATE}.csv`);
  const reconciliationDownloadPath = await reconciliationDownload.path();
  expect(reconciliationDownloadPath).not.toBeNull();
  const reconciliationCsv = await readFile(reconciliationDownloadPath!, "utf8");
  expect(reconciliationCsv).toContain('"section","key_1","key_2","value"');
  expect(reconciliationCsv).toContain(`"meta","business_date","","${SHIFT_DATE}"`);

  const closed = page.locator('[data-testid="shift-closed-status"]');
  const signature = page.locator('[data-testid="shift-signature-input"]');
  await expect(closed.or(signature)).toBeVisible({ timeout: 15_000 });
  if (await signature.isVisible()) {
    await signature.fill("E2E 历史复核");
    await page.locator('[data-testid="shift-note-input"]').fill("E2E 历史 CSV");
    await page.locator('[data-testid="shift-close-btn"]').click();
  }
  await expect(closed).toBeVisible({ timeout: 15_000 });

  await page.locator('input[name="shift-history-from"]').fill(SHIFT_DATE);
  await page.locator('input[name="shift-history-to"]').fill(SHIFT_DATE);
  await page.getByRole("button", { name: "查询历史" }).click();
  const history = page.locator('[aria-label="交班历史"]');
  await expect(history.getByRole("cell", { name: SHIFT_DATE })).toBeVisible({ timeout: 15_000 });

  const downloadPromise = page.waitForEvent("download");
  await history.getByRole("button", { name: "导出历史 CSV" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(`shift-history-${SHIFT_DATE}-${SHIFT_DATE}.csv`);
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  const csv = await readFile(downloadPath!, "utf8");
  expect(csv).toContain("business_date,signature_name");
  expect(csv).toContain(`\"${SHIFT_DATE}\",\"E2E 历史复核\"`);
});
