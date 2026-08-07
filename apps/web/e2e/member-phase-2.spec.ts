/**
 * Browser acceptance for the phase-2 member counter slice against real
 * PostgreSQL: maintain a bonus tier, top up, and complete an R4 refund.
 */
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
  username: requiredEnvironment("LAUNDRY_BOOTSTRAP_ADMIN_USERNAME"),
  password: requiredEnvironment("LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD"),
  pin: requiredEnvironment("LAUNDRY_BOOTSTRAP_ADMIN_PIN"),
});

function yuanInput(cents: number): string {
  const yuan = Math.floor(cents / 100);
  const fen = String(cents % 100).padStart(2, "0");
  return String(yuan) + "." + fen;
}

function money(cents: number): string {
  return "¥" + yuanInput(cents);
}

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
  const health = await request.get(API + "/health");
  expect(health.ok(), "API " + API + "/health must be up").toBeTruthy();
});

test("bonus tier top-up and R4 principal refund are durable", async ({ page }) => {
  const suffix = Date.now().toString().slice(-8);
  const thresholdCents = 4_900_000 + (Number(suffix) % 90_000);
  const bonusCents = 12_345;
  const refundCents = 5_000;
  const customerName = "E2E 会员 " + suffix;
  const customerPhone = "132" + suffix;

  await signIn(page);

  await page.locator('[data-nav-id="settings"]').click();
  const rules = page.locator('[data-testid="member-rules"]');
  await expect(rules).toBeVisible();
  await rules.getByLabel("充满（元）").fill(yuanInput(thresholdCents));
  await rules.getByLabel("赠送（元）").fill(yuanInput(bonusCents));
  await rules.getByLabel("备注（可选）").fill("真实 PostgreSQL 浏览器验收");
  await rules.getByRole("button", { name: "新增档位" }).click();

  const ruleConfirmation = page.getByRole("dialog", { name: "确认修改赠送档位" });
  await expect(ruleConfirmation).toContainText(money(thresholdCents), { timeout: 15_000 });
  await expect(ruleConfirmation).toContainText(money(bonusCents));
  await ruleConfirmation.getByRole("button", { name: "确认保存" }).click();
  await expect(page.locator(".ld-toast").last()).toContainText("赠送档位已保存", {
    timeout: 15_000,
  });
  const ruleRow = rules.locator(".ld-member-rules__row").filter({
    hasText: money(thresholdCents),
  });
  await expect(ruleRow).toHaveCount(1, { timeout: 15_000 });
  await expect(ruleRow).toContainText("启用");

  await page.locator('[data-nav-id="customers"]').click();
  await page.locator('[data-testid="customers-phone-input"]').fill(customerPhone);
  await page.locator('[data-testid="customers-name-input"]').fill(customerName);
  await page.locator('[data-testid="customers-upsert-btn"]').click();
  await expect(page.locator(".ld-toast").last()).toContainText("客户已保存", {
    timeout: 15_000,
  });
  await page.locator('[data-testid="customers-search-input"]').fill(customerName);
  await page.locator('[data-testid="customers-search-btn"]').click();
  const customer = page.locator('[data-testid="customers-row"]', { hasText: customerName });
  await expect(customer).toHaveCount(1, { timeout: 15_000 });
  await customer.click();

  const member = page.locator('[aria-label="会员储值"]');
  await expect(member.getByText("尚未开通会员")).toBeVisible({ timeout: 15_000 });
  await member.getByRole("button", { name: "开通会员账户" }).click();
  await expect(page.locator(".ld-toast").last()).toContainText("会员账户已开通", {
    timeout: 15_000,
  });
  await member.getByLabel("充值金额（元）").fill(yuanInput(thresholdCents));
  await member.getByRole("button", { name: "充值", exact: true }).click();
  const topupConfirmation = page.getByRole("dialog", { name: "确认会员充值" });
  await expect(topupConfirmation).toContainText(money(thresholdCents), { timeout: 15_000 });
  await expect(topupConfirmation).toContainText("收款渠道：现金");
  await topupConfirmation.getByRole("button", { name: "确认充值" }).click();
  await expect(page.locator(".ld-toast").last()).toContainText("充值已入账", {
    timeout: 15_000,
  });
  await expect(member.locator(".ld-member-panel__balance")).toContainText(
    money(thresholdCents + bonusCents),
  );
  await expect(member.locator(".ld-member-panel__split")).toContainText(
    "本金 " + money(thresholdCents),
  );
  await expect(member.locator(".ld-member-panel__split")).toContainText(
    "赠款 " + money(bonusCents),
  );

  const refund = member.locator('[data-testid="member-refund"]');
  await refund.getByLabel("退款金额（元）").fill(yuanInput(refundCents));
  await refund.getByLabel("退款方式").selectOption("cash");
  await refund.getByLabel("退款原因").fill("真实 R4 退款验收");
  await refund.getByRole("button", { name: "确认退款" }).click();

  const stepUp = page.getByRole("dialog", { name: "需要现场复核" });
  await expect(stepUp).toBeVisible({ timeout: 15_000 });
  await expect(stepUp).toContainText("退款本金 " + money(refundCents));
  await expect(stepUp).toContainText("退款渠道：现金");
  await expect(stepUp).toContainText("退款原因：真实 R4 退款验收");
  await stepUp.locator(".ld-step-up__select").selectOption({
    label: "E2E Staff Two（店长）",
  });
  await stepUp.locator('input[name="step-up-pin"]').fill(LOGIN.pin);
  await stepUp.getByRole("button", { name: "确认 PIN" }).click();
  await expect(page.locator(".ld-toast").last()).toContainText("储值本金已退款", {
    timeout: 15_000,
  });
  await expect(member.locator(".ld-member-panel__balance")).toContainText(
    money(thresholdCents + bonusCents - refundCents),
  );
  await expect(member.locator(".ld-member-panel__split")).toContainText(
    "本金 " + money(thresholdCents - refundCents),
  );
  await expect(member.locator(".ld-member-panel__split")).toContainText(
    "赠款 " + money(bonusCents),
  );
  const refundLedger = member.locator(".ld-member-panel__row").filter({ hasText: "退款" });
  await expect(refundLedger.first()).toContainText("-" + money(refundCents));

  await page.locator('[data-nav-id="settings"]').click();
  await ruleRow.getByRole("button", { name: "停用" }).click();
  await expect(ruleConfirmation).toContainText("状态：停用", { timeout: 15_000 });
  await ruleConfirmation.getByRole("button", { name: "确认保存" }).click();
  await expect(page.locator(".ld-toast").last()).toContainText("赠送档位已停用", {
    timeout: 15_000,
  });
  await expect(ruleRow).toContainText("已停用");
});
