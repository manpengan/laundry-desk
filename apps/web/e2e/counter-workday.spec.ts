/**
 * Browser acceptance for the counter money path against real PostgreSQL.
 *
 * The server-side acceptance (apps/server/src/order/pg-workday.test.ts) proves
 * the commands settle correctly. This proves an operator can actually reach
 * them: catalog pick -> authoritative pricing -> partial payment -> debt ->
 * pickup collecting the remainder.
 *
 * Requires local:up + the seeded catalog from global-setup.mjs.
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
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required for the counter workday E2E`);
  }
  return value;
};
const LOGIN = Object.freeze({
  orgCode: requiredEnvironment("LAUNDRY_LOCAL_ORG_CODE"),
  storeCode: requiredEnvironment("LAUNDRY_LOCAL_STORE_CODE"),
  username: requiredEnvironment("LAUNDRY_BOOTSTRAP_ADMIN_USERNAME"),
  password: requiredEnvironment("LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD"),
});

/** Seeded by global-setup.mjs: 水洗衬衫 at ¥15.00. */
const CATALOG_ITEM_NAME = "水洗衬衫";
const QTY = 2;
const PAYABLE_TEXT = "¥30.00";
const INITIAL_PAYMENT_CENTS = "1000";
const DEBT_TEXT = "¥20.00";
const SETTLED_TEXT = "¥0.00";

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

test.beforeAll(async ({ request }) => {
  const health = await request.get(`${API}/health`);
  expect(health.ok(), `API ${API}/health must be up`).toBeTruthy();
});

test("counter takes an order with a partial payment and settles it at pickup", async ({ page }) => {
  await signIn(page);

  // --- 开单 ---------------------------------------------------------------
  await page.locator('[data-nav-id="receive"]').click();
  const picker = page.locator('[data-testid="catalog-picker"]');
  await expect(picker).toBeVisible();

  // A visible chip proves the seeded price list actually reached the browser.
  await picker.getByRole("option", { name: new RegExp(CATALOG_ITEM_NAME, "u") }).click();

  await page.getByLabel("数量").fill(String(QTY));
  const phone = `139${Date.now().toString().slice(-8)}`;
  await page.locator('input[name="customer-phone"]').fill(phone);
  await page.locator('input[name="customer-name"]').fill("E2E 顾客");
  await page.locator('input[name="initial-payment"]').fill(INITIAL_PAYMENT_CENTS);

  await page.getByRole("button", { name: "确认开单" }).click();

  const ticketCell = page.locator('[data-testid="receive-ticket"]');
  await expect(ticketCell).toBeVisible({ timeout: 15_000 });
  const ticketNo = (await ticketCell.innerText()).trim();
  expect(ticketNo.length).toBeGreaterThan(0);

  // Server-authoritative pricing: 2 x ¥15.00, ¥10.00 paid, ¥20.00 owed.
  const receiveResult = page.locator(".ld-order-result");
  await expect(receiveResult).toContainText(PAYABLE_TEXT);
  await expect(receiveResult).toContainText(DEBT_TEXT);

  // --- 取衣 + 补款 --------------------------------------------------------
  await page.locator('[data-nav-id="pickup"]').click();
  await page.locator('input[name="pickup-key"]').fill(ticketNo);
  await page.getByRole("button", { name: "加载订单" }).click();

  await expect(page.locator('[data-testid="pickup-loaded-ticket"]')).toHaveText(ticketNo, {
    timeout: 15_000,
  });
  await expect(page.locator('[data-testid="pickup-loaded-balance"]')).toContainText(DEBT_TEXT);

  await page.locator('input[name="collect-cents"]').fill("2000");
  await page.getByRole("button", { name: "确认取衣" }).click();

  await expect(page.locator('[data-testid="pickup-ticket"]')).toHaveText(ticketNo, {
    timeout: 15_000,
  });
  const pickupResult = page.locator(".ld-order-result").last();
  await expect(pickupResult).toContainText(PAYABLE_TEXT);
  await expect(pickupResult).toContainText(SETTLED_TEXT);
});
