import { expect, test, type Page } from "@playwright/test";

const WEB = "http://127.0.0.1:5173";
const API = "http://127.0.0.1:8787";
const BUSINESS_DATE = "2097-08-07";

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) throw new Error(name + " is required");
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

async function selectRange(page: Page, mode: "history" | "staff"): Promise<void> {
  await page.locator('[data-testid="accounting-mode"]').selectOption(mode);
  await page.locator('[data-testid="accounting-date-from"]').fill(BUSINESS_DATE);
  await page.locator('[data-testid="accounting-date-to"]').fill(BUSINESS_DATE);
  await page.locator('[data-testid="accounting-load"]').click();
  await expect(page.locator('[data-testid="accounting-report-result"]')).toBeVisible({
    timeout: 15_000,
  });
}

function metric(page: Page, label: string) {
  return page.locator(".ld-accounting .ld-stats-card").filter({ hasText: label }).first();
}

test.beforeAll(async ({ request }) => {
  const health = await request.get(API + "/health");
  expect(health.ok()).toBeTruthy();
});

test("dual-basis day, month, and staff reports export verified real ledger evidence", async ({
  page,
}) => {
  await signIn(page);
  await page.locator('[data-nav-id="stats"]').click();
  await expect(page.locator('[data-testid="accounting-report-panel"]')).toBeVisible();

  await selectRange(page, "history");
  await expect(metric(page, "实收").locator('[data-fen="13000"]')).toHaveCount(1);
  await expect(metric(page, "业绩").locator('[data-fen="8000"]')).toHaveCount(1);
  await expect(metric(page, "会员本金现金流").locator('[data-fen="8000"]')).toHaveCount(1);
  await expect(metric(page, "会员余额消费").locator('[data-fen="3000"]')).toHaveCount(1);
  const daily = page.locator('section[aria-label="营业日汇总"]');
  await expect(daily).toContainText(BUSINESS_DATE);

  await page.locator('[data-testid="accounting-mode"]').selectOption("month");
  await page.locator('[data-testid="accounting-month"]').fill("2097-08");
  await page.locator('[data-testid="accounting-load"]').click();
  await expect(page.locator('[data-testid="accounting-report-result"]')).toContainText(
    "2097-08-01 至 2097-08-31",
    { timeout: 15_000 },
  );
  await expect(metric(page, "实收").locator('[data-fen="13000"]')).toHaveCount(1);

  await selectRange(page, "staff");
  const staff = page
    .locator('section[aria-label="职员汇总"] tbody tr')
    .filter({ hasText: "E2E Staff One" });
  await expect(staff).toHaveCount(1);
  await expect(staff.locator('[data-fen="-2000"]')).toHaveCount(2);
  await expect(staff.locator('[data-fen="3000"]')).toHaveCount(2);

  await page.locator('[data-testid="accounting-export"]').click();
  const confirmation = page.getByRole("dialog", { name: "确认导出账目报表" });
  await expect(confirmation).toBeVisible();
  await expect(confirmation).toContainText("营业日 2097-08-07 至 2097-08-07");
  await expect(confirmation.locator('[data-fen="13000"]')).toHaveCount(1);
  await expect(confirmation.locator('[data-fen="8000"]')).toHaveCount(1);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    confirmation.getByRole("button", { name: "确认导出" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("accounting-2097-08-07-2097-08-07-staff.csv");
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const csv = Buffer.concat(chunks).toString("utf8");
  expect(csv).toContain('"totals","all","合计","13000","8000","5000","8000","3000","4"');
  expect(csv).toContain("E2E Staff One");
  await expect(page.locator(".ld-toast").last()).toContainText("账目 CSV 已完成完整性校验");
});
