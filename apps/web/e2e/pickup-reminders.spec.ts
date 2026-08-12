import { expect, test, type Page } from "@playwright/test";

const WEB = "http://127.0.0.1:5173";
const API = "http://127.0.0.1:8787";

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) throw new Error(name + " is required");
  return value;
}

const LOGIN = Object.freeze({
  orgCode: requiredEnvironment("LAUNDRY_LOCAL_ORG_CODE"),
  storeCode: requiredEnvironment("LAUNDRY_LOCAL_STORE_CODE"),
  // This fixture has the bootstrap password hash but its own account limiter,
  // so parallel administrator acceptance specs cannot starve this login.
  username: "e2e-staff-a",
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
  const health = await request.get(API + "/health");
  expect(health.ok()).toBeTruthy();
});

test("manual pickup list is confirmed, downloaded and recorded without claiming delivery", async ({
  page,
}) => {
  await signIn(page);
  await page.locator('[data-nav-id="reminders"]').click();
  await expect(page.getByText("人工名单只生成联系材料，不会自行发送短信或微信。")).toBeVisible();

  const row = page.locator('[data-testid="pickup-reminder-row"]', {
    hasText: "E2E 催取顾客",
  });
  await expect(row).toHaveCount(1, { timeout: 15_000 });
  await expect(row).toContainText("13400000000");
  await row.getByRole("checkbox").check();
  await page.getByRole("button", { name: /生成名单并复制号码/u }).click();

  const dialog = page.getByRole("dialog", { name: "确认生成催取名单" });
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await expect(dialog).toContainText("不会发送短信或微信");
  await expect(dialog).not.toContainText(/已发送|送达|通知成功/u);

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    dialog.getByRole("button", { name: "确认生成名单" }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^pickup-reminders-\d{8}-[0-9a-f]{8}\.csv$/u);
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const csv = Buffer.concat(chunks).toString("utf8");
  expect(csv).toContain("13400000000");
  expect(csv).toContain("E2E-REMINDER-0001");

  await expect(page.locator(".ld-toast").last()).toContainText("名单已生成", {
    timeout: 15_000,
  });
  await expect(row).not.toContainText("从未生成", { timeout: 15_000 });
});
