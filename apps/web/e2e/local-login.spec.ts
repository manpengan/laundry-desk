/**
 * SPA walkthrough against local:server(:pg) + local:web.
 * Opt-in only — CI does not start compose/Vite.
 *
 *   LAUNDRY_SPA_E2E=1 pnpm --filter @laundry/web test:e2e:local
 */
import { expect, test } from "@playwright/test";

const WEB = process.env.LAUNDRY_WEB_URL ?? "http://127.0.0.1:5173";
const API = process.env.LAUNDRY_API_URL ?? "http://127.0.0.1:8787";

test.beforeAll(async ({ request }) => {
  const health = await request.get(`${API}/health`);
  expect(health.ok(), `API ${API}/health must be up`).toBeTruthy();
});

test("login with demo credentials reaches counter shell", async ({ page }) => {
  await page.goto(WEB);
  await expect(page.locator('[data-page="login"]')).toBeVisible();

  // Host prefills local demo values; assert and submit.
  await expect(page.locator('input[name="org_code"]')).toHaveValue("hongfa");
  await expect(page.locator('input[name="username"]')).toHaveValue("admin");

  await page.getByRole("button", { name: "登录" }).click();

  await expect(page.locator('[data-shell="counter"]')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("宏发·总店")).toBeVisible();
  await expect(page.getByText("店长")).toBeVisible();
  await expect(page.getByRole("button", { name: "切换员工" })).toBeVisible();
});

test("PIN quick-switch to 店员甲", async ({ page }) => {
  await page.goto(WEB);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.locator('[data-shell="counter"]')).toBeVisible({ timeout: 15_000 });

  await page.getByRole("button", { name: "切换员工" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();

  const staffSelect = page.getByLabel("目标员工");
  // Prefer label text match via option value lookup
  const staffA = "11111111-1111-4111-8111-111111111101";
  await staffSelect.selectOption(staffA);
  await page.locator('input[name="pin"]').fill("1234");
  await page.getByRole("button", { name: "确认切换" }).click();

  await expect(page.locator(".ld-shell-topbar__staff")).toHaveText("店员甲", { timeout: 15_000 });
  await expect(page.locator('[data-shell="counter"]')).toBeVisible();
});
