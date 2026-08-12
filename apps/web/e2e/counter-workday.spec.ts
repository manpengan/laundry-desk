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
import { expect, test, type Locator, type Page, type Request } from "@playwright/test";

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
  pin: requiredEnvironment("LAUNDRY_BOOTSTRAP_ADMIN_PIN"),
});

/**
 * Created through the settings UI by this spec — ADR-15. A fresh install ships
 * an empty price list, and order.receive refuses a line that does not match
 * exactly one active item, so bootstrapping the catalog IS part of the workday.
 * The code is unique per run so expected_version=0 proves the create path.
 */
const CATALOG_SUFFIX = `${process.pid.toString(36)}_${Date.now().toString(36)}`;
const CATALOG_CODE = `e2e_wash_${CATALOG_SUFFIX}`;
const AUX_CATALOG_CODE = `e2e_aux_${CATALOG_SUFFIX}`;
const CATALOG_ITEM_NAME = `E2E 水洗衬衫 ${CATALOG_SUFFIX}`;
const AUX_CATALOG_NAME = `E2E 排序辅助项 ${CATALOG_SUFFIX}`;
const CATALOG_SERVICE = "wash";
const CATALOG_CATEGORY = `e2e_${CATALOG_SUFFIX}`;
const AUX_CATALOG_CATEGORY = `e2e_aux_${CATALOG_SUFFIX}`;
const CATALOG_PRICE_CENTS = "1500";
const QTY = 2;
const POLICY = Object.freeze({
  discountCents: "100",
  urgentCents: "300",
  freightCents: "400",
  addonCode: `e2e_stain_${CATALOG_SUFFIX}`,
  addonName: `E2E 去渍 ${CATALOG_SUFFIX}`,
  addonUnitCents: "200",
});
const PAYABLE_TEXT = "¥40.00";
const INITIAL_PAYMENT_CENTS = "1000";
const DEBT_TEXT = "¥30.00";
const REFUND_CENTS = "200";
const REFUNDED_DEBT_TEXT = "¥32.00";
const REMAINING_REFUNDABLE_TEXT = "¥8.00";
const SETTLED_TEXT = "¥0.00";
const CATALOG_REORDER_PATH = "/v1/commands/catalog.items.reorder";
const MAX_CATALOG_REORDER_ATTEMPTS = 3;

type ReceiveRequest = Readonly<Record<string, unknown>>;
type RefundRequest = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCatalogReorderConflict(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.ok === false &&
    isRecord(value.error) &&
    value.error.code === "IDEMPOTENCY_CONFLICT"
  );
}

async function moveCatalogRow(
  page: Page,
  row: Locator,
  buttonName: string,
  position: () => Promise<number>,
  expectedPosition: number,
): Promise<void> {
  for (let attempt = 1; attempt <= MAX_CATALOG_REORDER_ATTEMPTS; attempt += 1) {
    const responsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === CATALOG_REORDER_PATH,
    );
    await row.getByRole("button", { name: buttonName }).click();
    const response = await responsePromise;
    const body = (await response.json()) as unknown;
    if (response.ok()) {
      await expect.poll(position).toBe(expectedPosition);
      return;
    }
    if (!isCatalogReorderConflict(body) || attempt === MAX_CATALOG_REORDER_ATTEMPTS) {
      throw new Error(`catalog reorder failed with HTTP ${response.status()}`);
    }
    await expect(page.locator(".ld-toast").last()).toContainText(
      "价目顺序已被其他会话修改，列表已刷新，请重试",
    );
    await expect(row.getByRole("button", { name: buttonName })).toBeEnabled();
  }
}

function captureReceive(request: Request, captures: ReceiveRequest[]): void {
  if (request.method() !== "POST") return;
  if (new URL(request.url()).pathname !== "/v1/commands/order.receive") return;
  const body = request.postDataJSON() as unknown;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("order.receive request must be a JSON object");
  }
  captures.push(body as ReceiveRequest);
}

function captureRefund(request: Request, captures: RefundRequest[]): void {
  if (request.method() !== "POST") return;
  if (new URL(request.url()).pathname !== "/v1/commands/payment.refund") return;
  const body = request.postDataJSON() as unknown;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("payment.refund request must be a JSON object");
  }
  captures.push(body as RefundRequest);
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
  const health = await request.get(`${API}/health`);
  expect(health.ok(), `API ${API}/health must be up`).toBeTruthy();
});

test("counter takes, refunds, and settles an order on the server-owned ledger", async ({
  page,
}) => {
  const receiveRequests: ReceiveRequest[] = [];
  const refundRequests: RefundRequest[] = [];
  page.on("request", (request) => {
    captureReceive(request, receiveRequests);
    captureRefund(request, refundRequests);
  });
  await signIn(page);

  // --- 价目维护（ADR-15）：没有价目就开不了单 ------------------------------
  await page.locator('[data-nav-id="settings"]').click();
  const catalogPanel = page.locator('[data-testid="catalog-admin"]');
  await expect(catalogPanel).toBeVisible();

  await page.locator('input[name="catalog-code"]').fill(CATALOG_CODE);
  await page.locator('input[name="catalog-name"]').fill(CATALOG_ITEM_NAME);
  await page.locator('input[name="catalog-service"]').fill(CATALOG_SERVICE);
  await page.locator('input[name="catalog-category"]').fill(CATALOG_CATEGORY);
  await page.locator('input[name="catalog-price"]').fill(CATALOG_PRICE_CENTS);
  await page.locator('[data-testid="catalog-save-btn"]').click();

  // The saved row appearing proves the write reached PostgreSQL and came back
  // through catalog.items.list.
  const catalogRow = catalogPanel.locator('[data-testid="catalog-admin-row"]', {
    hasText: CATALOG_CODE,
  });
  await expect(catalogRow).toBeVisible({ timeout: 15_000 });
  await expect(catalogRow).toContainText("在架");
  await expect(catalogRow).toContainText("v1");

  // Two independent browser devices edit the same v1 row. The first wins;
  // the stale writer is rejected, clears its frozen form and reloads v2.
  const browser = page.context().browser();
  if (browser === null) throw new Error("counter workday requires a browser context");
  const concurrentContext = await browser.newContext();
  try {
    const concurrentPage = await concurrentContext.newPage();
    await signIn(concurrentPage);
    await concurrentPage.locator('[data-nav-id="settings"]').click();
    const concurrentPanel = concurrentPage.locator('[data-testid="catalog-admin"]');
    const concurrentRow = concurrentPanel.locator('[data-testid="catalog-admin-row"]', {
      hasText: CATALOG_CODE,
    });
    await concurrentRow.getByRole("button", { name: "编辑" }).click();

    await catalogRow.getByRole("button", { name: "编辑" }).click();
    await page.locator('input[name="catalog-mnemonic"]').fill("e2e");
    await page.locator('[data-testid="catalog-save-btn"]').click();
    await expect(catalogRow).toContainText("v2", { timeout: 15_000 });

    await concurrentPage.locator('input[name="catalog-name"]').fill("陈旧覆盖不应生效");
    await concurrentPage.locator('[data-testid="catalog-save-btn"]').click();
    await expect(concurrentPage.locator(".ld-toast").last()).toContainText(
      "列表已刷新，请重新编辑",
      { timeout: 15_000 },
    );
    await expect(concurrentPage.locator('input[name="catalog-code"]')).toHaveValue("");
    await expect(concurrentRow).toContainText(CATALOG_ITEM_NAME);
    await expect(concurrentRow).toContainText("v2");
  } finally {
    await concurrentContext.close();
  }

  // ADR-39: a retired row remains in the management list and can be restored
  // with the next optimistic version.
  await catalogRow.getByRole("button", { name: "停用" }).click();
  await expect(catalogRow).toContainText("已停用", { timeout: 15_000 });
  await expect(catalogRow).toContainText("v3");
  await catalogRow.getByRole("button", { name: "启用" }).click();
  await expect(catalogRow).toContainText("在架", { timeout: 15_000 });
  await expect(catalogRow).toContainText("v4");

  // Add a second synthetic row, then prove the full active snapshot can move
  // and restore the two relative positions atomically.
  await catalogPanel.getByRole("button", { name: "新建 / 清空" }).click();
  await page.locator('input[name="catalog-code"]').fill(AUX_CATALOG_CODE);
  await page.locator('input[name="catalog-name"]').fill(AUX_CATALOG_NAME);
  await page.locator('input[name="catalog-service"]').fill(CATALOG_SERVICE);
  await page.locator('input[name="catalog-category"]').fill(AUX_CATALOG_CATEGORY);
  await page.locator('input[name="catalog-price"]').fill("100");
  await page.locator('[data-testid="catalog-save-btn"]').click();
  const auxiliaryRow = catalogPanel.locator('[data-testid="catalog-admin-row"]', {
    hasText: AUX_CATALOG_CODE,
  });
  await expect(auxiliaryRow).toBeVisible({ timeout: 15_000 });
  const catalogPosition = async () => {
    const texts = await catalogPanel.locator('[data-testid="catalog-admin-row"]').allTextContents();
    return texts.findIndex((text) => text.includes(CATALOG_CODE));
  };
  const originalPosition = await catalogPosition();
  expect(originalPosition).toBeGreaterThanOrEqual(0);
  await moveCatalogRow(
    page,
    catalogRow,
    `下移 ${CATALOG_ITEM_NAME}`,
    catalogPosition,
    originalPosition + 1,
  );
  await moveCatalogRow(
    page,
    catalogRow,
    `上移 ${CATALOG_ITEM_NAME}`,
    catalogPosition,
    originalPosition,
  );

  const auditPanel = page.locator('[data-testid="catalog-audit"]');
  await auditPanel.getByLabel("按编码筛选（可选）").fill(CATALOG_CODE);
  await auditPanel.getByRole("button", { name: "查询审计" }).click();
  const auditList = auditPanel.locator('[data-testid="catalog-audit-list"]');
  await expect(auditList).toContainText("新增");
  await expect(auditList).toContainText("停用");
  await expect(auditList).toContainText("启用");
  await expect(auditList).toContainText("排序");

  // --- 柜台计价政策（ADR-38）：由另一位店长 R5 复核 -----------------------
  const pricingPanel = page.locator('[data-testid="pricing-settings"]');
  await expect(pricingPanel).toBeVisible();
  const policyStatus = pricingPanel.getByRole("status");
  const versionMatch = /当前版本 (\d+)/u.exec((await policyStatus.textContent()) ?? "");
  expect(versionMatch).not.toBeNull();
  const expectedPolicyVersion = Number(versionMatch?.[1]) + 1;
  await pricingPanel.getByLabel("加急固定费（分）").fill(POLICY.urgentCents);
  await pricingPanel.getByLabel("运费固定费（分）").fill(POLICY.freightCents);
  await pricingPanel.getByRole("button", { name: "添加附加项" }).click();
  const addon = pricingPanel.locator(".ld-settings-pricing__addon").last();
  await addon.getByLabel("附加项编码").fill(POLICY.addonCode);
  await addon.getByLabel("显示名称").fill(POLICY.addonName);
  await addon.getByLabel("每件金额（分）").fill(POLICY.addonUnitCents);
  await addon.getByLabel("排序").fill("10");
  await pricingPanel.getByRole("button", { name: "保存计价设置" }).click();

  const stepUp = page.getByRole("dialog", { name: "需要现场复核" });
  await expect(stepUp).toContainText("修改柜台计价", { timeout: 15_000 });
  await stepUp.locator(".ld-step-up__select").selectOption({
    label: "E2E Staff Two（店长）",
  });
  await stepUp.locator('input[name="step-up-pin"]').fill(LOGIN.pin);
  await stepUp.getByRole("button", { name: "确认 PIN" }).click();
  await expect(page.locator(".ld-toast").last()).toContainText("计价设置已保存并生效", {
    timeout: 15_000,
  });
  await expect(policyStatus).toContainText(`当前版本 ${expectedPolicyVersion}`);

  // --- 开单 ---------------------------------------------------------------
  await page.locator('[data-nav-id="receive"]').click();
  const picker = page.locator('[data-testid="catalog-picker"]');
  await expect(picker).toBeVisible();

  // A visible chip proves the seeded price list actually reached the browser.
  await picker.getByRole("option", { name: new RegExp(CATALOG_ITEM_NAME, "u") }).click();

  await page.getByLabel("数量").fill(String(QTY));
  await page.getByLabel("第 1 件颜色").fill("白");
  await page.getByLabel("第 1 件品牌").fill("甲牌");
  await page.getByLabel("第 1 件瑕疵").fill("袖口污渍，纽扣松动");
  await page.getByLabel("第 1 件随衣附件").fill("腰带");
  await page.getByLabel("第 1 件件级备注").fill("单独去渍");
  await page.getByLabel("第 2 件颜色").fill("蓝");
  await page.getByLabel("第 2 件品牌").fill("乙牌");
  await page.getByLabel("第 2 件瑕疵").fill("下摆磨损");
  await page.getByLabel("第 2 件随衣附件").fill("衣架");
  await page.getByLabel("第 2 件件级备注").fill("低温处理");
  const phone = `139${Date.now().toString().slice(-8)}`;
  await page.locator('input[name="customer-phone"]').fill(phone);
  await page.locator('input[name="customer-name"]').fill("E2E 顾客");
  await page.locator('input[name="discount-cents"]').fill(POLICY.discountCents);
  await page.getByLabel(`第 1 件${POLICY.addonName}`).check();
  await page.getByLabel(`第 2 件${POLICY.addonName}`).check();
  await page.getByLabel(/^加急/u).check();
  await page.getByLabel(/^运费/u).check();
  await page.locator('input[name="note"]').fill("E2E 刷新恢复挂单");

  // Save a complete server draft, reload the SPA, then recover only from
  // order.list + order.get. No browser-local form state may be required.
  await page.getByRole("button", { name: "暂存挂单" }).click();
  await expect(page.locator(".ld-toast").last()).toContainText("已暂存挂单", {
    timeout: 15_000,
  });
  await page.reload();
  // Renderer authority is intentionally memory-only, so a hard refresh must
  // reauthenticate before loading the server-owned draft.
  await signIn(page);
  await page.locator('[data-nav-id="receive"]').click();
  const draftRow = page.locator('[data-testid="receive-draft-row"]', { hasText: phone });
  await expect(draftRow).toBeVisible({ timeout: 15_000 });
  await draftRow.locator('[data-testid="receive-draft-resume"]').click();
  await expect(page.locator(".ld-toast").last()).toContainText("挂单已完整恢复", {
    timeout: 15_000,
  });
  await expect(page.getByLabel("第 1 件颜色")).toHaveValue("白");
  await expect(page.getByLabel("第 1 件瑕疵")).toHaveValue("袖口污渍，纽扣松动");
  await expect(page.getByLabel("第 2 件颜色")).toHaveValue("蓝");
  await expect(page.getByLabel("第 2 件随衣附件")).toHaveValue("衣架");
  await expect(page.getByLabel(`第 1 件${POLICY.addonName}`)).toBeChecked();
  await expect(page.getByLabel(`第 2 件${POLICY.addonName}`)).toBeChecked();
  await expect(page.locator('input[name="discount-cents"]')).toHaveValue(POLICY.discountCents);
  await expect(page.getByLabel(/^加急/u)).toBeChecked();
  await expect(page.getByLabel(/^运费/u)).toBeChecked();
  await page.locator('input[name="initial-payment"]').fill(INITIAL_PAYMENT_CENTS);

  const preview = page.locator('[aria-label="本地预览"]');
  await expect(preview).toContainText("原价");
  await expect(preview).toContainText("¥30.00");
  await expect(preview).toContainText(PAYABLE_TEXT);

  await page.getByRole("button", { name: "确认挂单并开单" }).click();

  const ticketCell = page.locator('[data-testid="receive-ticket"]');
  await expect(ticketCell).toBeVisible({ timeout: 15_000 });
  const ticketNo = (await ticketCell.innerText()).trim();
  expect(ticketNo.length).toBeGreaterThan(0);

  // Server-authoritative pricing:
  // 2 x ¥15.00 - ¥1.00 + (2 x ¥2.00) + ¥3.00 + ¥4.00 = ¥40.00.
  // ¥10.00 paid leaves ¥30.00 owed.
  const receiveResult = page.locator(".ld-order-result");
  await expect(receiveResult).toContainText(PAYABLE_TEXT);
  await expect(receiveResult).toContainText(DEBT_TEXT);

  expect(receiveRequests).toHaveLength(1);
  const receiveBody = receiveRequests[0];
  expect(receiveBody).not.toHaveProperty("addon_cents");
  expect(receiveBody).not.toHaveProperty("urgent_cents");
  expect(receiveBody).not.toHaveProperty("freight_cents");
  expect(receiveBody).toMatchObject({
    draft_id: expect.any(String),
    discount_cents: 100,
    urgent: true,
    freight: true,
    lines: [
      {
        qty: 2,
        garments: [
          {
            color: "白",
            brand: "甲牌",
            defects: ["袖口污渍", "纽扣松动"],
            accessories: ["腰带"],
            note: "单独去渍",
            addon_codes: [POLICY.addonCode],
          },
          {
            color: "蓝",
            brand: "乙牌",
            defects: ["下摆磨损"],
            accessories: ["衣架"],
            note: "低温处理",
            addon_codes: [POLICY.addonCode],
          },
        ],
      },
    ],
  });

  // Reprice only after the order is committed. Order detail must continue to
  // render the immutable ¥15.00 service snapshot and original payable total.
  await page.locator('[data-nav-id="settings"]').click();
  const committedCatalogRow = page.locator('[data-testid="catalog-admin-row"]', {
    hasText: CATALOG_CODE,
  });
  await committedCatalogRow.getByRole("button", { name: "编辑" }).click();
  await page.locator('input[name="catalog-price"]').fill("1600");
  await page.locator('[data-testid="catalog-save-btn"]').click();
  await expect(committedCatalogRow).toContainText("¥16.00", { timeout: 15_000 });

  // --- 服务端流水 + R4 原路退款 ------------------------------------------
  await page.locator('[data-nav-id="orders"]').click();
  await page.locator('[data-testid="debt-load-btn"]').click();
  const debtRow = page.locator('[data-testid="debt-row"]', { hasText: ticketNo });
  await expect(debtRow).toBeVisible({ timeout: 15_000 });
  await debtRow.locator('[data-testid="debt-row-detail-btn"]').click();

  const drawer = page.locator('[data-testid="order-detail-drawer"]');
  await expect(drawer.locator('[data-testid="order-detail-ticket"]')).toHaveText(ticketNo, {
    timeout: 15_000,
  });
  await expect(drawer.locator('[data-testid="order-detail-payable"]')).toContainText(PAYABLE_TEXT);
  await expect(drawer.locator('[data-testid="order-detail-garments"]')).toContainText("¥15.00");
  await expect(drawer.locator('[data-testid="order-detail-garments"]')).toContainText("颜色：白");
  await expect(drawer.locator('[data-testid="order-detail-garments"]')).toContainText(
    "瑕疵：下摆磨损",
  );
  await expect(drawer.locator('[data-testid="order-detail-garments"]')).toContainText(
    POLICY.addonName,
  );
  const originalPayment = drawer.locator('[data-testid="payment-ledger-row"]', {
    hasText: "收款",
  });
  await expect(originalPayment).toContainText("服务端可退");
  await expect(originalPayment).toContainText("¥10.00");
  await originalPayment.locator('[data-testid="payment-refund-open-btn"]').click();

  const refundDialog = page.locator('[data-testid="payment-refund-dialog"]');
  await refundDialog.locator('[data-testid="payment-refund-amount"]').fill(REFUND_CENTS);
  await refundDialog.locator('[data-testid="payment-refund-reason"]').fill("E2E 顾客改项退款");
  await page
    .getByRole("dialog", { name: "原路退款" })
    .getByRole("button", { name: "申请退款" })
    .click();

  const refundStepUp = page.getByRole("dialog", { name: "需要现场复核" });
  await expect(refundStepUp).toContainText("订单原路退款", { timeout: 15_000 });
  await refundStepUp.locator(".ld-step-up__select").selectOption({
    label: "E2E Staff Two（店长）",
  });
  await refundStepUp.locator('input[name="step-up-pin"]').fill(LOGIN.pin);
  await refundStepUp.getByRole("button", { name: "确认 PIN" }).click();
  await expect(page.locator(".ld-toast").last()).toContainText("退款已追加到支付流水", {
    timeout: 15_000,
  });
  await expect(drawer.locator('[data-testid="order-detail-balance"]')).toContainText(
    REFUNDED_DEBT_TEXT,
  );
  await expect(originalPayment).toContainText(REMAINING_REFUNDABLE_TEXT);
  const refundRow = drawer.locator('[data-testid="payment-ledger-row"]', { hasText: /^退款/u });
  await expect(refundRow).toContainText("¥2.00");

  expect(refundRequests).toHaveLength(2);
  expect(refundRequests[0]).toMatchObject({
    amount_cents: 200,
    method: "cash",
    order_id: expect.any(String),
    ref_payment_id: expect.any(String),
    reason: "E2E 顾客改项退款",
  });
  expect(Object.keys(refundRequests[1] ?? {}).sort()).toEqual(["confirm_ref"]);
  expect(refundRequests[1]?.confirm_ref).toEqual(expect.any(String));

  // --- 取衣 + 补款 --------------------------------------------------------
  await drawer.locator('[data-testid="order-detail-pickup-btn"]').click();
  await page.locator('input[name="pickup-key"]').fill(ticketNo);
  await page.getByRole("button", { name: "加载订单" }).click();

  await expect(page.locator('[data-testid="pickup-loaded-ticket"]')).toHaveText(ticketNo, {
    timeout: 15_000,
  });
  await expect(page.locator('[data-testid="pickup-loaded-balance"]')).toContainText(
    REFUNDED_DEBT_TEXT,
  );

  await page.locator('input[name="collect-cents"]').fill("3200");
  await page.getByRole("button", { name: "确认取衣" }).click();

  await expect(page.locator('[data-testid="pickup-ticket"]')).toHaveText(ticketNo, {
    timeout: 15_000,
  });
  const pickupResult = page.locator(".ld-order-result").last();
  await expect(pickupResult).toContainText(PAYABLE_TEXT);
  await expect(pickupResult).toContainText(SETTLED_TEXT);
});
