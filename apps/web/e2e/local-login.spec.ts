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
  pin: requiredEnvironment("LAUNDRY_BOOTSTRAP_ADMIN_PIN"),
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

  const cookieCycle = await page.evaluate(async (apiBase) => {
    const csrfCookie = (): string | null => {
      const prefix = "laundry_csrf=";
      const match = document.cookie.split("; ").find((cookie) => cookie.startsWith(prefix));
      return match === undefined ? null : match.slice(prefix.length);
    };
    const initialCsrf = csrfCookie();
    if (initialCsrf === null) {
      return { refreshStatus: 0, rotated: false, logoutStatus: 0, cleared: false };
    }

    const refresh = await fetch(`${apiBase}/api/v2/auth/refresh`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": initialCsrf,
      },
      body: "{}",
    });
    const rotatedCsrf = csrfCookie();
    if (!refresh.ok || rotatedCsrf === null) {
      return {
        refreshStatus: refresh.status,
        rotated: false,
        logoutStatus: 0,
        cleared: false,
      };
    }

    const logout = await fetch(`${apiBase}/api/v2/auth/logout`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": rotatedCsrf,
      },
      body: "{}",
    });
    return {
      refreshStatus: refresh.status,
      rotated: rotatedCsrf !== initialCsrf,
      logoutStatus: logout.status,
      cleared: csrfCookie() === null,
    };
  }, API);

  expect(cookieCycle).toEqual({
    refreshStatus: 200,
    rotated: true,
    logoutStatus: 200,
    cleared: true,
  });
});

test("an administrator can quick-switch to a fixture staff member with PIN", async ({ page }) => {
  await page.goto(WEB);
  await page.locator('input[name="org_code"]').fill(LOGIN.orgCode);
  await page.locator('input[name="store_code"]').fill(LOGIN.storeCode);
  await page.locator('input[name="username"]').fill(LOGIN.username);
  await page.locator('input[name="password"]').fill(LOGIN.password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.locator('[data-shell="counter"]')).toBeVisible({ timeout: 15_000 });

  await page.getByRole("button", { name: "切换员工" }).click();
  const staffSelect = page.getByLabel("目标员工");
  await expect(staffSelect).toBeVisible();
  await staffSelect.selectOption({ label: "E2E Staff One" });
  await page.locator('input[name="pin"]').fill(LOGIN.pin);
  await page.getByRole("button", { name: "确认切换" }).click();

  await expect(page.locator(".ld-shell-topbar__staff")).toHaveText("E2E Staff One", {
    timeout: 15_000,
  });
  await expect(page.locator('[data-shell="counter"]')).toHaveAttribute("data-role", "staff");
});
