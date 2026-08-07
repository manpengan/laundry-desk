/**
 * Real PostgreSQL browser acceptance for ADR-25 member lifecycle operations.
 *
 * The customer and bonus tier are created through product surfaces. The test
 * never edits the accounting fixture installed by global setup.
 */
import { expect, test, type Page, type Request } from "@playwright/test";

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

const LIFECYCLE_COMMANDS = Object.freeze([
  "member.account.freeze",
  "member.account.unfreeze",
  "member.account.close",
] as const);
type LifecycleCommand = (typeof LIFECYCLE_COMMANDS)[number];
type LifecycleRequest = Readonly<{ name: LifecycleCommand; body: unknown }>;

function yuanInput(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

function money(cents: number): string {
  return "¥" + yuanInput(cents);
}

function isLifecycleCommand(value: string): value is LifecycleCommand {
  return LIFECYCLE_COMMANDS.some((name) => name === value);
}

function captureLifecycle(request: Request, captures: LifecycleRequest[]): void {
  if (request.method() !== "POST") return;
  const prefix = "/v1/commands/";
  const path = new URL(request.url()).pathname;
  if (!path.startsWith(prefix)) return;
  const name = decodeURIComponent(path.slice(prefix.length));
  if (!isLifecycleCommand(name)) return;
  captures.push(Object.freeze({ name, body: request.postDataJSON() as unknown }));
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected lifecycle JSON object");
  }
  return value as Readonly<Record<string, unknown>>;
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

async function quickSwitch(page: Page, displayName: string, role: "admin" | "staff") {
  await page.getByRole("button", { name: "切换员工" }).click();
  const dialog = page.getByRole("dialog", { name: "切换员工" });
  await dialog.getByLabel("目标员工").selectOption({ label: displayName });
  await dialog.locator('input[name="pin"]').fill(LOGIN.pin);
  await dialog.getByRole("button", { name: "确认切换" }).click();
  await expect(page.locator(".ld-shell-topbar__staff")).toHaveText(displayName, {
    timeout: 15_000,
  });
  await expect(page.locator('[data-shell="counter"]')).toHaveAttribute("data-role", role);
}

async function openCustomer(page: Page, customerName: string) {
  await page.locator('[data-nav-id="customers"]').click();
  await page.locator('[data-testid="customers-search-input"]').fill(customerName);
  await page.locator('[data-testid="customers-search-btn"]').click();
  const row = page.locator('[data-testid="customers-row"]', { hasText: customerName });
  await expect(row).toHaveCount(1, { timeout: 15_000 });
  await row.click();
  const member = page.locator('[aria-label="会员储值"]');
  await expect(member).toBeVisible({ timeout: 15_000 });
  return member;
}

test.beforeAll(async ({ request }) => {
  const health = await request.get(API + "/health");
  expect(health.ok(), "API " + API + "/health must be up").toBeTruthy();
});

test("staff freeze, admin unfreeze and R4 close remain durable", async ({ page }) => {
  test.setTimeout(90_000);
  const suffix = Date.now().toString().slice(-8);
  const thresholdCents = 4_990_001 + (Number(suffix) % 9_998);
  const bonusCents = 12_346 + (Number(suffix) % 100);
  const customerName = "E2E 生命周期 " + suffix;
  const customerPhone = "133" + suffix;
  const captures: LifecycleRequest[] = [];
  page.on("request", (request) => captureLifecycle(request, captures));

  await signIn(page);

  await page.locator('[data-nav-id="settings"]').click();
  const rules = page.locator('[data-testid="member-rules"]');
  await expect(rules).toBeVisible();
  await rules.getByLabel("充满（元）").fill(yuanInput(thresholdCents));
  await rules.getByLabel("赠送（元）").fill(yuanInput(bonusCents));
  await rules.getByLabel("备注（可选）").fill("ADR-25 浏览器验收 " + suffix);
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

  await page.locator('[data-nav-id="customers"]').click();
  await page.locator('[data-testid="customers-phone-input"]').fill(customerPhone);
  await page.locator('[data-testid="customers-name-input"]').fill(customerName);
  await page.locator('[data-testid="customers-upsert-btn"]').click();
  await expect(page.locator(".ld-toast").last()).toContainText("客户已保存", {
    timeout: 15_000,
  });
  const member = await openCustomer(page, customerName);
  await expect(member.getByText("尚未开通会员")).toBeVisible({ timeout: 15_000 });
  await member.getByRole("button", { name: "开通会员账户" }).click();
  await expect(page.locator(".ld-toast").last()).toContainText("会员账户已开通", {
    timeout: 15_000,
  });

  await member.getByLabel("充值金额（元）").fill(yuanInput(thresholdCents));
  await member.getByRole("button", { name: "充值", exact: true }).click();
  const topup = page.getByRole("dialog", { name: "确认会员充值" });
  await expect(topup).toContainText(money(thresholdCents), { timeout: 15_000 });
  await expect(topup).toContainText("收款渠道：现金");
  await topup.getByRole("button", { name: "确认充值" }).click();
  await expect(member.locator(".ld-member-panel__balance")).toContainText(
    money(thresholdCents + bonusCents),
    { timeout: 15_000 },
  );

  await quickSwitch(page, "E2E Staff One", "staff");
  await expect(member.locator('[data-testid="member-freeze"]')).toBeVisible();
  await expect(member.locator('[data-testid="member-unfreeze"]')).toHaveCount(0);
  await expect(member.locator('[data-testid="member-close"]')).toHaveCount(0);
  await expect(member.locator('[data-testid="member-refund"]')).toHaveCount(0);

  await member.locator('[data-testid="member-freeze"]').click();
  const freezeDraft = page.getByRole("dialog", { name: "挂失并冻结会员账户" });
  await freezeDraft.getByLabel("操作原因").fill("顾客电话报失");
  await freezeDraft.getByRole("button", { name: "继续确认" }).click();
  const freezeConfirm = page.getByRole("dialog", { name: "确认挂失冻结" });
  await expect(freezeConfirm).toContainText("顾客电话报失", { timeout: 15_000 });
  await expect(freezeConfirm).toContainText("禁止充值、余额消费和普通退款");
  await freezeConfirm.getByRole("button", { name: "确认执行" }).click();
  await expect(member.locator('[data-testid="member-status"]')).toHaveText("挂失冻结", {
    timeout: 15_000,
  });
  await expect(member.getByLabel("充值金额（元）")).toHaveCount(0);
  await expect(member.locator('[data-testid="member-refund"]')).toHaveCount(0);
  await expect(member).toContainText("暂不可充值、余额消费或普通退款");
  await expect(member.locator('[data-testid="member-unfreeze"]')).toHaveCount(0);
  await expect(member.locator('[data-testid="member-close"]')).toHaveCount(0);

  await quickSwitch(page, "E2E Staff Two", "admin");
  await expect(member.locator('[data-testid="member-unfreeze"]')).toBeVisible();
  await expect(member.locator('[data-testid="member-close"]')).toBeVisible();

  await member.locator('[data-testid="member-unfreeze"]').click();
  const unfreezeDraft = page.getByRole("dialog", { name: "解除会员账户挂失" });
  await unfreezeDraft.getByLabel("操作原因").fill("到店核验身份完成");
  await unfreezeDraft.getByRole("button", { name: "继续确认" }).click();
  const unfreezeConfirm = page.getByRole("dialog", { name: "确认解除挂失" });
  await expect(unfreezeConfirm).toContainText("到店核验身份完成", { timeout: 15_000 });
  await unfreezeConfirm.getByRole("button", { name: "确认执行" }).click();
  await expect(member.locator('[data-testid="member-status"]')).toHaveText("正常", {
    timeout: 15_000,
  });
  await expect(member.locator('[data-testid="member-refund"]')).toBeVisible();

  await member.locator('[data-testid="member-close"]').click();
  const closeDraft = page.getByRole("dialog", { name: "退卡并永久销户" });
  await closeDraft.getByLabel("本金退款渠道").selectOption("cash");
  await closeDraft.getByLabel("操作原因").fill("顾客确认退卡销户");
  await closeDraft.getByRole("button", { name: "继续确认" }).click();
  const stepUp = page.getByRole("dialog", { name: "需要现场复核" });
  await expect(stepUp).toContainText(
    "当前状态：正常；当前余额 " + money(thresholdCents + bonusCents),
    { timeout: 15_000 },
  );
  await expect(stepUp).toContainText(money(thresholdCents), { timeout: 15_000 });
  await expect(stepUp).toContainText(money(bonusCents));
  await expect(stepUp).toContainText("退款渠道：现金");
  await expect(stepUp).toContainText("顾客确认退卡销户");
  await stepUp.locator('input[name="step-up-pin"]').fill(LOGIN.pin);
  await stepUp.getByRole("button", { name: "确认 PIN" }).click();

  await expect(member.locator('[data-testid="member-status"]')).toHaveText("已销户", {
    timeout: 15_000,
  });
  await expect(member.locator(".ld-member-panel__balance")).toContainText(money(0));
  await expect(member).toContainText("不能重新开通");
  await expect(member.getByLabel("充值金额（元）")).toHaveCount(0);
  await expect(member.locator('[data-testid="member-refund"]')).toHaveCount(0);
  await expect(member.locator('[data-testid="member-lifecycle"]')).toHaveCount(0);
  await expect(
    member.locator(".ld-member-panel__row").filter({ hasText: "退款" }).first(),
  ).toContainText("-" + money(thresholdCents));
  await expect(
    member.locator(".ld-member-panel__row").filter({ hasText: "赠款销户作废" }).first(),
  ).toContainText("-" + money(bonusCents));

  await page.reload();
  await expect(page.locator('[data-page="login"]')).toBeVisible({ timeout: 15_000 });
  await signIn(page);
  const durableMember = await openCustomer(page, customerName);
  await expect(durableMember.locator('[data-testid="member-status"]')).toHaveText("已销户", {
    timeout: 15_000,
  });
  await expect(durableMember.locator(".ld-member-panel__balance")).toContainText(money(0));
  await expect(durableMember.getByRole("button", { name: "开通会员账户" })).toHaveCount(0);

  const byName = (name: LifecycleCommand) => captures.filter((item) => item.name === name);
  const freezeCalls = byName("member.account.freeze");
  const unfreezeCalls = byName("member.account.unfreeze");
  const closeCalls = byName("member.account.close");
  expect(freezeCalls).toHaveLength(2);
  expect(unfreezeCalls).toHaveLength(2);
  expect(closeCalls).toHaveLength(2);

  const freezeBody = asRecord(freezeCalls[0]?.body);
  const unfreezeBody = asRecord(unfreezeCalls[0]?.body);
  const closeBody = asRecord(closeCalls[0]?.body);
  expect(Object.keys(freezeBody).sort()).toEqual([
    "account_id",
    "expected_customer_id",
    "expected_status_version",
    "reason",
  ]);
  expect(freezeBody.reason).toBe("顾客电话报失");
  expect(freezeBody.expected_status_version).toBe(1);
  expect(unfreezeBody).toEqual({
    account_id: freezeBody.account_id,
    expected_customer_id: freezeBody.expected_customer_id,
    expected_status_version: 2,
    reason: "到店核验身份完成",
  });
  expect(closeBody).toEqual({
    account_id: freezeBody.account_id,
    expected_customer_id: freezeBody.expected_customer_id,
    expected_status_version: 3,
    reason: "顾客确认退卡销户",
    expected_status: "active",
    expected_principal_cents: thresholdCents,
    expected_bonus_cents: bonusCents,
    refund_tender: "cash",
  });
  for (const calls of [freezeCalls, unfreezeCalls, closeCalls]) {
    const continuation = asRecord(calls[1]?.body);
    expect(Object.keys(continuation)).toEqual(["confirm_ref"]);
    expect(continuation.confirm_ref).toEqual(expect.any(String));
  }

  await page.locator('[data-nav-id="settings"]').click();
  await expect(ruleRow).toHaveCount(1, { timeout: 15_000 });
  await ruleRow.getByRole("button", { name: "停用" }).click();
  await expect(ruleConfirmation).toContainText("状态：停用", { timeout: 15_000 });
  await ruleConfirmation.getByRole("button", { name: "确认保存" }).click();
  await expect(ruleRow).toContainText("已停用", { timeout: 15_000 });
});
