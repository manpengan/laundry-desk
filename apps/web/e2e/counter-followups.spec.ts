/**
 * Browser coverage for the counter paths the milestone record flagged as
 * server-only: hold, cancel, standalone repayment, order list/detail and the
 * stats page and an isolated historic-day shift close.
 */
import { expect, test, type Page } from "@playwright/test";

const exactLocalUrl = (name: "LAUNDRY_WEB_URL" | "LAUNDRY_API_URL", expected: string): string => {
  const configured = process.env[name];
  if (configured !== undefined && configured !== expected) {
    throw new Error(`${name} must equal its local loopback endpoint`);
  }
  return expected;
};
const WEB = exactLocalUrl("LAUNDRY_WEB_URL", "http://127.0.0.1:5173");
const API = exactLocalUrl("LAUNDRY_API_URL", "http://127.0.0.1:8787");

const requiredEnvironment = (name: string): string => {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
};
const LOGIN = Object.freeze({
  orgCode: requiredEnvironment("LAUNDRY_LOCAL_ORG_CODE"),
  storeCode: requiredEnvironment("LAUNDRY_LOCAL_STORE_CODE"),
  username: requiredEnvironment("LAUNDRY_BOOTSTRAP_ADMIN_USERNAME"),
  password: requiredEnvironment("LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD"),
});

/** Own code and category so this spec never competes with the workday spec. */
const CATALOG = Object.freeze({
  code: "e2e_followup_coat",
  name: "E2E 干洗大衣",
  service: "dry",
  category: "e2ecoat",
  priceCents: "2000",
});
const ISOLATED_SHIFT_DATE = "1999-12-31";

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

/** order.receive prices from the catalog, so every spec must seed its own. */
async function ensureCatalogItem(page: Page): Promise<void> {
  await page.locator('[data-nav-id="settings"]').click();
  const panel = page.locator('[data-testid="catalog-admin"]');
  await expect(panel).toBeVisible({ timeout: 15_000 });
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

/** Fill the receive form without submitting; the caller decides hold vs receive. */
async function fillReceiveForm(page: Page, phone: string, paymentCents: string): Promise<void> {
  await page.locator('[data-nav-id="receive"]').click();
  const picker = page.locator('[data-testid="catalog-picker"]');
  await expect(picker).toBeVisible();
  await picker.getByRole("option", { name: new RegExp(CATALOG.name, "u") }).click();
  await page.locator('input[name="customer-phone"]').fill(phone);
  await page.locator('input[name="customer-name"]').fill("E2E 跟进顾客");
  await page.locator('input[name="initial-payment"]').fill(paymentCents);
}

test.beforeAll(async ({ request }) => {
  const health = await request.get(`${API}/health`);
  expect(health.ok(), `API ${API}/health must be up`).toBeTruthy();
});

test("a held draft is listed as 挂单 with no ticket number", async ({ page }) => {
  await signIn(page);
  await ensureCatalogItem(page);
  await fillReceiveForm(page, `137${Date.now().toString().slice(-8)}`, "0");

  await page.getByRole("button", { name: "暂存挂单" }).click();

  // 订单与欠款 is the only route that reaches the order detail drawer; the
  // workbench list is 今日待取 and its rows open pickup instead.
  await page.locator('[data-nav-id="orders"]').click();
  await page.locator('[data-testid="debt-load-btn"]').click();
  const held = page.locator('[data-testid="debt-row"]').filter({ hasText: "挂单" }).first();
  await expect(held).toBeVisible({ timeout: 15_000 });
  await expect(held).toContainText("¥20.00", { timeout: 15_000 });

  await held.locator('[data-testid="debt-row-detail-btn"]').click();
  const drawer = page.locator('[data-testid="order-detail-drawer"]');
  await expect(drawer).toBeVisible({ timeout: 15_000 });
  await expect(drawer.locator('[data-testid="order-detail-ticket"]')).toHaveText("挂单");
  await expect(drawer.locator('[data-testid="order-detail-register-photo-btn"]')).toBeDisabled();
  // A draft is not cancellable — cancelOrderTxn requires status 'open', so the
  // drawer correctly offers no cancel action here.
  await expect(drawer.locator('[data-testid="order-detail-cancel-btn"]')).toHaveCount(0);
});

test("an open order is cancelled with a reason and a second confirmation", async ({ page }) => {
  await signIn(page);
  await ensureCatalogItem(page);
  await fillReceiveForm(page, `136${Date.now().toString().slice(-8)}`, "0");
  await page.getByRole("button", { name: "确认开单" }).click();

  const ticketCell = page.locator('[data-testid="receive-ticket"]');
  await expect(ticketCell).toBeVisible({ timeout: 15_000 });
  const ticketNo = (await ticketCell.innerText()).trim();

  await page.locator('[data-nav-id="orders"]').click();
  await page.locator('[data-testid="debt-load-btn"]').click();
  const row = page.locator('[data-testid="debt-row"]').filter({ hasText: ticketNo }).first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.locator('[data-testid="debt-row-detail-btn"]').click();

  const drawer = page.locator('[data-testid="order-detail-drawer"]');
  await expect(drawer).toBeVisible({ timeout: 15_000 });

  const photoInput = drawer.locator('[data-testid="order-detail-register-photo-btn"]');
  await expect(photoInput).toBeEnabled();
  const uploadResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v2/photos",
  );
  await photoInput.setInputFiles({
    name: "receive.jpg",
    mimeType: "image/jpeg",
    buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]),
  });
  const uploadResponse = await uploadResponsePromise;
  expect(
    uploadResponse.ok(),
    `photo upload returned ${uploadResponse.status()}: ${await uploadResponse.text()}`,
  ).toBeTruthy();
  const photoToast = page.locator(".ld-toast").last();
  await expect(photoToast).toBeVisible({ timeout: 3_000 });
  await expect(photoToast).toContainText("照片已安全保存");
  await expect(drawer.locator('[data-testid="order-detail-photo-count"]')).toHaveText("1 张", {
    timeout: 15_000,
  });
  await drawer.locator('[data-testid="order-detail-close-btn"]').click();
  await row.locator('[data-testid="debt-row-detail-btn"]').click();
  await expect(drawer.locator('[data-testid="order-detail-photo-count"]')).toHaveText("1 张", {
    timeout: 15_000,
  });

  // order.cancel is R3: a reason is required, then the server asks again.
  await drawer.locator('[data-testid="order-detail-cancel-btn"]').click();
  await page.locator('input[name="danger-reason"]').fill("E2E 撤销开单");
  await page.getByRole("button", { name: "确认撤销" }).click();
  await page.getByRole("button", { name: "再次确认撤销" }).click();

  await expect(drawer.locator('[data-testid="order-detail-status"]')).toContainText("已撤销", {
    timeout: 15_000,
  });
});

test("a picked-up order with debt is settled by standalone repayment", async ({ page }) => {
  await signIn(page);
  await ensureCatalogItem(page);
  await fillReceiveForm(page, `138${Date.now().toString().slice(-8)}`, "500");
  await page.getByRole("button", { name: "确认开单" }).click();

  const ticketCell = page.locator('[data-testid="receive-ticket"]');
  await expect(ticketCell).toBeVisible({ timeout: 15_000 });
  const ticketNo = (await ticketCell.innerText()).trim();
  await expect(page.locator(".ld-order-result")).toContainText("¥15.00", { timeout: 15_000 });

  // Pick everything up without collecting, so the debt survives the pickup.
  await page.locator('[data-nav-id="pickup"]').click();
  await page.locator('input[name="pickup-key"]').fill(ticketNo);
  await page.getByRole("button", { name: "加载订单" }).click();
  await expect(page.locator('[data-testid="pickup-loaded-ticket"]')).toHaveText(ticketNo, {
    timeout: 15_000,
  });
  await page.locator('input[name="collect-cents"]').fill("0");
  await page.getByRole("button", { name: "确认取衣" }).click();
  await expect(page.locator('[data-testid="pickup-ticket"]')).toHaveText(ticketNo, {
    timeout: 15_000,
  });

  // Now the debt is repaid on its own — every garment is terminal, so the UI
  // issues payment.repay rather than payment.collect.
  await page.locator('[data-nav-id="orders"]').click();
  await page.locator('[data-testid="debt-load-btn"]').click();
  const row = page.locator('[data-testid="debt-row"]').filter({ hasText: ticketNo }).first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.locator('[data-testid="debt-row-detail-btn"]').click();

  const drawer = page.locator('[data-testid="order-detail-drawer"]');
  await expect(drawer).toBeVisible({ timeout: 15_000 });
  await expect(drawer.locator('[data-testid="order-detail-balance"]')).toContainText("¥15.00");
  await drawer.locator('[data-testid="order-detail-payment-btn"]').click();
  await page.locator('input[name="payment-amount-cents"]').fill("1500");
  await page.getByRole("button", { name: "确认补缴" }).click();

  await expect(drawer.locator('[data-testid="order-detail-balance"]')).toContainText("¥0.00", {
    timeout: 15_000,
  });
});

test("the stats page loads a day summary for the counter", async ({ page }) => {
  await signIn(page);
  await page.locator('[data-nav-id="stats"]').click();
  await page.locator('[data-testid="stats-load-btn"]').click();
  await expect(page.locator('[data-testid="stats-summary"]')).toBeVisible({ timeout: 15_000 });
});

test("a historic empty business day can be closed without freezing today's counter", async ({
  page,
}) => {
  await signIn(page);
  await page.locator('[data-nav-id="stats"]').click();
  await page.locator('[data-testid="stats-date-input"]').fill(ISOLATED_SHIFT_DATE);
  await page.locator('[data-testid="stats-load-btn"]').click();

  const summary = page.locator('[data-testid="stats-summary"]');
  await expect(summary).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-testid="stats-card-orders"]')).toContainText("0");

  const closed = page.locator('[data-testid="shift-closed-status"]');
  const form = page.locator('[data-testid="shift-signature-input"]');
  await expect(closed.or(form)).toBeVisible({ timeout: 15_000 });
  if (await form.isVisible()) {
    await form.fill("E2E 交班人");
    await page.locator('[data-testid="shift-note-input"]').fill("历史空营业日隔离验收");
    await page.locator('[data-testid="shift-close-btn"]').click();
  }

  await expect(closed).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-testid="shift-order-count"]')).toHaveText("0");
});
