import { expect, test, type Page, type Request } from "@playwright/test";
import { yuanText } from "./money-input.js";

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
  username: requiredEnvironment("LAUNDRY_BOOTSTRAP_ADMIN_USERNAME"),
  password: requiredEnvironment("LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD"),
});
const SUFFIX = `${process.pid.toString(36)}${Date.now().toString(36).slice(-6)}`.toLowerCase();
const FIXTURE = Object.freeze({
  catalogCode: `e2e_benefit_${SUFFIX}`,
  catalogName: `E2E 权益洗护 ${SUFFIX}`,
  customerName: `E2E 权益顾客 ${SUFFIX}`,
  customerPhone: `131${Date.now().toString().slice(-8)}`,
  tierCode: `tier_${SUFFIX}`,
  tierName: `E2E 银卡 ${SUFFIX}`,
  punchCode: `punch_${SUFFIX}`,
  punchName: `E2E 三次卡 ${SUFFIX}`,
  couponCode: `coupon_${SUFFIX}`,
  couponName: `E2E 五元券 ${SUFFIX}`,
});

type CapturedBody = Readonly<Record<string, unknown>>;

function captureMemberRequest(request: Request, captures: CapturedBody[]): void {
  if (request.method() !== "POST") return;
  const path = new URL(request.url()).pathname;
  if (path !== "/v1/commands/member.points.earn" && path !== "/v1/commands/member.asset.consume") {
    return;
  }
  const body = request.postDataJSON() as unknown;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("member request must be an object");
  }
  captures.push(body as CapturedBody);
}

async function signIn(page: Page): Promise<void> {
  await page.goto(WEB);
  await page.locator('input[name="org_code"]').fill(LOGIN.orgCode);
  await page.locator('input[name="store_code"]').fill(LOGIN.storeCode);
  await page.locator('input[name="username"]').fill(LOGIN.username);
  await page.locator('input[name="password"]').fill(LOGIN.password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.locator('[data-shell="counter"]')).toBeVisible({ timeout: 15_000 });
}

async function confirmDefinition(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "确认修改会员权益定义" });
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await dialog.getByRole("button", { name: "确认保存" }).click();
  await expect(page.locator(".ld-toast").last()).toContainText("会员权益定义已保存", {
    timeout: 15_000,
  });
}

async function saveDefinition(
  page: Page,
  kind: "tier" | "points_policy" | "punch_type" | "coupon_type",
): Promise<void> {
  const panel = page.locator('[data-testid="benefit-definitions"]');
  await panel.getByLabel("类型").selectOption(kind);
  if (kind === "tier") {
    await panel.getByLabel("代码").fill(FIXTURE.tierCode);
    await panel.getByLabel("名称").fill(FIXTURE.tierName);
    await panel.getByLabel("等级序号").fill("1");
  } else if (kind === "points_policy") {
    await panel.getByLabel("每满金额（元）").fill("1.00");
    await panel.getByLabel("每档积分").fill("1");
    await panel.getByLabel("有效天数").fill("30");
  } else if (kind === "punch_type") {
    await panel.getByLabel("代码").fill(FIXTURE.punchCode);
    await panel.getByLabel("名称").fill(FIXTURE.punchName);
    await panel.getByLabel("总次数").fill("3");
    await panel.getByLabel("有效天数").fill("30");
  } else {
    await panel.getByLabel("代码").fill(FIXTURE.couponCode);
    await panel.getByLabel("名称").fill(FIXTURE.couponName);
    await panel.getByLabel("优惠金额（元）").fill("5.00");
    await panel.getByLabel("最低订单（元）").fill("10.00");
    await panel.getByLabel("有效天数").fill("30");
  }
  await panel.getByLabel("备注（可选）").fill("ADR-41 Chromium 验收");
  await panel.getByRole("button", { name: "新增定义" }).click();
  await confirmDefinition(page);
}

async function confirmBenefitMutation(page: Page, title: string): Promise<void> {
  const dialog = page.getByRole("dialog", { name: title });
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await dialog.getByRole("button", { name: "确认执行" }).click();
}

test.beforeAll(async ({ request }) => {
  const health = await request.get(`${API}/health`);
  expect(health.ok(), `API ${API}/health must be up`).toBeTruthy();
});

test.setTimeout(120_000);

test("member tiers, points, punch cards and coupons complete a real PostgreSQL browser journey", async ({
  page,
}) => {
  const memberRequests: CapturedBody[] = [];
  page.on("request", (request) => captureMemberRequest(request, memberRequests));
  await signIn(page);

  await page.locator('[data-nav-id="settings"]').click();
  const catalog = page.locator('[data-testid="catalog-admin"]');
  await catalog.locator('input[name="catalog-code"]').fill(FIXTURE.catalogCode);
  await catalog.locator('input[name="catalog-name"]').fill(FIXTURE.catalogName);
  await catalog.locator('input[name="catalog-service"]').fill("wash");
  await catalog.locator('input[name="catalog-category"]').fill(`benefit_${SUFFIX}`);
  await catalog.locator('input[name="catalog-price"]').fill(yuanText("1500"));
  await catalog.locator('[data-testid="catalog-save-btn"]').click();
  await expect(
    catalog.locator('[data-testid="catalog-admin-row"]', { hasText: FIXTURE.catalogCode }),
  ).toBeVisible({ timeout: 15_000 });

  const definitions = page.locator('[data-testid="benefit-definitions"]');
  await expect(definitions).toBeVisible();
  await saveDefinition(page, "tier");
  await saveDefinition(page, "points_policy");
  await saveDefinition(page, "punch_type");
  await saveDefinition(page, "coupon_type");
  for (const text of [FIXTURE.tierCode, "积分规则", FIXTURE.punchCode, FIXTURE.couponCode]) {
    await expect(definitions).toContainText(text);
  }

  await page.locator('[data-nav-id="customers"]').click();
  await page.locator('[data-testid="customers-phone-input"]').fill(FIXTURE.customerPhone);
  await page.locator('[data-testid="customers-name-input"]').fill(FIXTURE.customerName);
  await page.locator('[data-testid="customers-upsert-btn"]').click();
  await page.locator('[data-testid="customers-search-input"]').fill(FIXTURE.customerName);
  await page.locator('[data-testid="customers-search-btn"]').click();
  await page.locator('[data-testid="customers-row"]', { hasText: FIXTURE.customerName }).click();

  const storedValue = page.locator('[aria-label="会员储值"]');
  await storedValue.getByRole("button", { name: "开通会员账户" }).click();
  await expect(page.locator(".ld-toast").last()).toContainText("会员账户已开通", {
    timeout: 15_000,
  });
  const benefits = page.locator('[data-testid="member-benefits-panel"]');
  const pendingBenefits = page.locator(".ld-member-benefits");
  const reloadBenefits = pendingBenefits.getByRole("button", { name: "重新读取" });
  if (await reloadBenefits.isVisible()) await reloadBenefits.click();
  await expect(benefits).toBeVisible({ timeout: 15_000 });

  await benefits.getByLabel("等级").selectOption({ label: `${FIXTURE.tierName}（L1）` });
  await benefits.getByLabel("有效至").fill("2099-12-31");
  await benefits.getByLabel("变更原因").fill("Chromium 等级验收");
  await benefits.getByRole("button", { name: "保存等级" }).click();
  await confirmBenefitMutation(page, "确认会员等级变更");
  await expect(page.locator(".ld-toast").last()).toContainText("会员等级已更新", {
    timeout: 15_000,
  });
  await expect(benefits).toContainText("等级有效");

  const assets = benefits.locator('[data-testid="member-assets"]');
  await assets.getByLabel("定义").selectOption({ label: FIXTURE.punchName });
  await assets.getByLabel("发放原因").fill("Chromium 次卡发放");
  await assets.getByRole("button", { name: "发放", exact: true }).click();
  await confirmBenefitMutation(page, "确认发放会员资产");
  await expect(assets).toContainText(`${FIXTURE.punchName} · 剩余 3/3 次`, { timeout: 15_000 });
  await assets.getByLabel("使用次卡").selectOption({ label: `${FIXTURE.punchName}（余 3 次）` });
  await assets.getByLabel("使用次数").fill("1");
  await assets.getByLabel("使用原因").fill("Chromium 次卡核销");
  await assets.getByRole("button", { name: "核销次卡" }).click();
  await expect(assets).toContainText(`${FIXTURE.punchName} · 剩余 2/3 次`, { timeout: 15_000 });

  await assets.getByLabel("发放类型").selectOption("coupon");
  await assets.getByLabel("定义").selectOption({ label: FIXTURE.couponName });
  await assets.getByLabel("发放原因").fill("Chromium 优惠券发放");
  await assets.getByRole("button", { name: "发放", exact: true }).click();
  await confirmBenefitMutation(page, "确认发放会员资产");
  await expect(assets).toContainText(FIXTURE.couponName, { timeout: 15_000 });

  await page.locator('[data-nav-id="receive"]').click();
  await page
    .locator('[data-testid="catalog-picker"]')
    .getByRole("option", { name: new RegExp(FIXTURE.catalogName, "u") })
    .click();
  await page.locator('input[name="customer-phone"]').fill(FIXTURE.customerPhone);
  await page.locator('input[name="customer-name"]').fill(FIXTURE.customerName);
  await page.getByRole("button", { name: "确认开单" }).click();
  const ticket = (await page.locator('[data-testid="receive-ticket"]').innerText()).trim();

  await page.locator('[data-nav-id="orders"]').click();
  await page.locator('[data-testid="debt-load-btn"]').click();
  const orderRow = page.locator('[data-testid="debt-row"]', { hasText: ticket });
  await expect(orderRow).toBeVisible({ timeout: 15_000 });
  await orderRow.locator('[data-testid="debt-row-detail-btn"]').click();
  const orderBenefits = page.locator('[data-testid="order-member-benefits"]');
  await expect(orderBenefits).toContainText(FIXTURE.couponName, { timeout: 15_000 });
  await orderBenefits.getByRole("button", { name: "核销" }).click();
  await expect(page.locator(".ld-toast").last()).toContainText("优惠券已核销", {
    timeout: 15_000,
  });
  await expect(page.locator('[data-testid="order-detail-payable"]')).toContainText("¥10.00");
  await page.locator('[data-testid="order-detail-pickup-btn"]').click();
  await page.locator('input[name="pickup-key"]').fill(ticket);
  await page.getByRole("button", { name: "加载订单" }).click();
  await page.locator('input[name="collect-cents"]').fill(yuanText("1000"));
  await page.getByRole("button", { name: "确认取衣" }).click();
  await expect(page.locator('[data-testid="pickup-ticket"]')).toHaveText(ticket, {
    timeout: 15_000,
  });

  await page.locator('[data-nav-id="customers"]').click();
  await page.locator('[data-testid="customers-search-input"]').fill(FIXTURE.customerName);
  await page.locator('[data-testid="customers-search-btn"]').click();
  await page.locator('[data-testid="customers-row"]', { hasText: FIXTURE.customerName }).click();
  const history = page.locator('[data-testid="customer-detail-orders"]');
  await history.locator('[data-testid="customer-detail-order-btn"]', { hasText: ticket }).click();
  const closedBenefits = page.locator('[data-testid="order-member-benefits"]');
  await closedBenefits.getByRole("button", { name: "领取订单积分" }).click();
  await expect(page.locator(".ld-toast").last()).toContainText("订单积分已按服务端规则入账", {
    timeout: 15_000,
  });

  const earnBody = memberRequests.find((body) => "account_id" in body && "order_id" in body);
  expect(earnBody).toBeDefined();
  expect(Object.keys(earnBody ?? {}).sort()).toEqual(["account_id", "order_id"]);
  expect(earnBody).not.toHaveProperty("points");
  const couponBody = memberRequests.find((body) => {
    const asset = body.asset;
    return (
      typeof asset === "object" &&
      asset !== null &&
      "asset_kind" in asset &&
      asset.asset_kind === "coupon"
    );
  });
  expect(couponBody).toBeDefined();
  expect(Object.keys(couponBody ?? {})).toEqual(["asset"]);
  expect(couponBody).not.toHaveProperty("discount_cents");
  expect(Object.keys((couponBody?.asset ?? {}) as Record<string, unknown>).sort()).toEqual([
    "asset_id",
    "asset_kind",
    "order_id",
  ]);
});
