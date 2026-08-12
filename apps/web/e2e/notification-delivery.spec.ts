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
  username: "e2e-staff-b",
  password: requiredEnvironment("LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD"),
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

test.beforeAll(async ({ request }) => {
  const health = await request.get(`${API}/health`);
  expect(health.ok()).toBeTruthy();
});

test("software-only notification batch proves queue state without claiming delivery", async ({
  page,
}) => {
  await signIn(page);
  await page.locator('[data-nav-id="reminders"]').click();

  const panel = page.getByTestId("notification-delivery-panel");
  await expect(panel.getByText("软件模拟模式")).toBeVisible({ timeout: 15_000 });
  await expect(panel).toContainText("不会发出短信");
  await expect(panel).not.toContainText(/已发送|送达|通知成功/u);

  const row = page.locator('[data-testid="pickup-reminder-row"]', {
    hasText: "E2E 催取顾客",
  });
  await expect(row).toHaveCount(1, { timeout: 15_000 });
  await row.getByRole("checkbox").check();
  await panel.getByRole("button", { name: "加入软件模拟队列（1）" }).click();

  const dialog = page.getByRole("dialog", { name: "确认创建通知批次" });
  await expect(dialog).toContainText("入队不代表发送或送达");
  await dialog.getByRole("button", { name: "确认入队" }).click();

  await expect(page.locator(".ld-toast").last()).toContainText(
    "批次已进入软件模拟队列；没有发送短信",
    { timeout: 15_000 },
  );
  const detail = page.getByTestId("notification-delivery-detail");
  await expect(detail).toBeVisible({ timeout: 15_000 });
  await expect(detail).toContainText("E2E-REMINDER-0001");

  await expect
    .poll(
      async () => {
        await detail.getByRole("button", { name: "刷新详情" }).click();
        return detail.textContent();
      },
      { timeout: 15_000 },
    )
    .toContain("软件模拟已接单（未发送）");

  await expect(panel).not.toContainText("13400000000");
  await expect(panel).not.toContainText("尊敬的");
  await expect(panel).not.toContainText(/已发送|送达|通知成功/u);
  await expect(panel).toContainText("¥0.00");
});
