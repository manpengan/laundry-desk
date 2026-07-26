/**
 * SPA walkthrough against local:up + local:web.
 * Opt-in locally; integration CI starts Compose and Vite explicitly.
 *
 *   LAUNDRY_SPA_E2E=1 pnpm --filter @laundry/web test:e2e:local
 */
import { expect, test } from "@playwright/test";

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
    throw new Error(`${name} is required for the local login smoke`);
  }
  return value;
};
const LOGIN = Object.freeze({
  orgCode: requiredEnvironment("LAUNDRY_LOCAL_ORG_CODE"),
  storeCode: requiredEnvironment("LAUNDRY_LOCAL_STORE_CODE"),
  username: requiredEnvironment("LAUNDRY_BOOTSTRAP_ADMIN_USERNAME"),
  password: requiredEnvironment("LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD"),
});

test.beforeAll(async ({ request }) => {
  const health = await request.get(`${API}/health`);
  expect(health.ok(), `API ${API}/health must be up`).toBeTruthy();
});

test("generic local administrator login reaches the counter shell", async ({ page }) => {
  await page.goto(WEB);
  await expect(page.locator('[data-page="login"]')).toBeVisible();

  await expect(page.locator('input[name="org_code"]')).toHaveValue("");
  await expect(page.locator('input[name="store_code"]')).toHaveValue("");
  await expect(page.locator('input[name="username"]')).toHaveValue("");
  await expect(page.locator('input[name="password"]')).toHaveValue("");

  await page.locator('input[name="org_code"]').fill(LOGIN.orgCode);
  await page.locator('input[name="store_code"]').fill(LOGIN.storeCode);
  await page.locator('input[name="username"]').fill(LOGIN.username);
  await page.locator('input[name="password"]').fill(LOGIN.password);

  await page.getByRole("button", { name: "登录" }).click();

  await expect(page.locator('[data-shell="counter"]')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "切换员工" })).toBeVisible();
});
