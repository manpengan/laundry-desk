import { expect, test, type Page } from "@playwright/test";
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
  approverPin: requiredEnvironment("LAUNDRY_BOOTSTRAP_ADMIN_PIN"),
});
const SUFFIX = `${process.pid.toString(36)}${Date.now().toString(36).slice(-6)}`.toLowerCase();
const FIXTURE = Object.freeze({
  catalogCode: `e2e_factory_${SUFFIX}`,
  catalogName: `E2E 店厂洗护 ${SUFFIX}`,
  customerName: `E2E 店厂顾客 ${SUFFIX}`,
  customerPhone: `133${Date.now().toString().slice(-8)}`,
  factoryCode: `F_${SUFFIX.toUpperCase()}`,
});

async function signIn(page: Page): Promise<void> {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(WEB);
  await page.locator('input[name="org_code"]').fill(LOGIN.orgCode);
  await page.locator('input[name="store_code"]').fill(LOGIN.storeCode);
  await page.locator('input[name="username"]').fill(LOGIN.username);
  await page.locator('input[name="password"]').fill(LOGIN.password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.locator('[data-shell="counter"]')).toBeVisible({ timeout: 15_000 });
}

async function createCatalogAndOrder(page: Page): Promise<string> {
  await page.locator('[data-nav-id="settings"]').click();
  const catalog = page.locator('[data-testid="catalog-admin"]');
  await catalog.locator('input[name="catalog-code"]').fill(FIXTURE.catalogCode);
  await catalog.locator('input[name="catalog-name"]').fill(FIXTURE.catalogName);
  await catalog.locator('input[name="catalog-service"]').fill("factory");
  await catalog.locator('input[name="catalog-category"]').fill(`handoff_${SUFFIX}`);
  await catalog.locator('input[name="catalog-price"]').fill(yuanText("1000"));
  await catalog.locator('[data-testid="catalog-save-btn"]').click();
  await expect(
    catalog.locator('[data-testid="catalog-admin-row"]', { hasText: FIXTURE.catalogCode }),
  ).toBeVisible({ timeout: 15_000 });

  await page.locator('[data-nav-id="receive"]').click();
  await page
    .locator('[data-testid="catalog-picker"]')
    .getByRole("option", { name: new RegExp(FIXTURE.catalogName, "u") })
    .click();
  await page.getByLabel("数量").fill("2");
  await page.locator('input[name="customer-phone"]').fill(FIXTURE.customerPhone);
  await page.locator('input[name="customer-name"]').fill(FIXTURE.customerName);
  await page.getByRole("button", { name: "确认开单" }).click();
  const ticket = (await page.locator('[data-testid="receive-ticket"]').innerText()).trim();
  expect(ticket).not.toHaveLength(0);
  return ticket;
}

async function confirmFactoryAction(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "确认店厂交接操作" });
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await expect(dialog.getByTestId("factory-confirmation-summary")).toBeVisible();
  await dialog.getByRole("button", { name: "确认执行" }).click();
}

async function scanAndConfirm(page: Page, barcode: string): Promise<void> {
  await page.locator('input[name="factory-barcode-scan"]').fill(barcode);
  await page.getByRole("button", { name: "加入扫描" }).click();
  await page.getByRole("button", { name: "提交完整清点" }).click();
  await confirmFactoryAction(page);
}

async function approveStepUp(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "需要现场复核" });
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await expect(dialog.getByTestId("factory-confirmation-summary")).toBeVisible();
  await dialog.locator(".ld-step-up__select").selectOption({ label: "E2E Staff Two（店长）" });
  await dialog.locator('input[name="step-up-pin"]').fill(LOGIN.approverPin);
  await dialog.getByRole("button", { name: "确认 PIN" }).click();
}

async function waitForCommandResponse(
  page: Page,
  command: string,
  action: () => Promise<void>,
): Promise<unknown> {
  const responsePromise = page.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith(`/v1/commands/${command}`),
  );
  await action();
  return (await responsePromise).json();
}

async function horizontalOverflow(page: Page): Promise<Readonly<Record<string, unknown>>> {
  return page.evaluate(() => {
    const clientWidth = document.documentElement.clientWidth;
    const offenders = Array.from(document.querySelectorAll<HTMLElement>("body *"))
      .map((element) => {
        const bounds = element.getBoundingClientRect();
        return {
          bounds,
          label: `${element.tagName.toLowerCase()}.${Array.from(element.classList).join(".")}`,
        };
      })
      .filter(({ bounds, label }) =>
        label === "a.ld-skip-link" ? false : bounds.right + scrollX > clientWidth + 1,
      )
      .slice(0, 12)
      .map(
        ({ bounds, label }) =>
          `${label}[documentRight=${(bounds.right + scrollX).toFixed(1)},width=${bounds.width.toFixed(1)}]`,
      );
    return { clientWidth, offenders, scrollWidth: document.documentElement.scrollWidth, scrollX };
  });
}

test.beforeAll(async ({ request }) => {
  const health = await request.get(`${API}/health`);
  expect(health.ok(), `API ${API}/health must be up`).toBeTruthy();
});

test.setTimeout(180_000);

test("mobile factory handoff blocks mismatches, requires R4 resolution and completes QC custody", async ({
  page,
}) => {
  await signIn(page);
  const ticket = await createCatalogAndOrder(page);

  await page.locator('[data-nav-id="fulfillment"]').click();
  await page.getByRole("button", { name: "店厂交接" }).click();
  const eligible = page
    .getByTestId("factory-eligible-garments")
    .locator(".ld-factory-garment", { hasText: ticket });
  await expect(eligible).toHaveCount(2, { timeout: 15_000 });
  for (let index = 0; index < 2; index += 1)
    await eligible.nth(index).getByRole("checkbox").check();
  await page.getByLabel("工厂代码").fill(FIXTURE.factoryCode);
  await page.getByRole("button", { name: "创建交接批次" }).click();
  await confirmFactoryAction(page);

  const batch = page.locator(".ld-factory-batch", { hasText: FIXTURE.factoryCode });
  await expect(batch).toBeVisible({ timeout: 15_000 });
  await batch.click();
  const detail = page.getByTestId("factory-batch-detail");
  await expect(detail).toContainText("待出店", { timeout: 15_000 });
  const barcodeNodes = detail.locator(".ld-factory-garment > span");
  await expect(barcodeNodes).toHaveCount(2);
  const firstBarcode = (await barcodeNodes.nth(0).innerText()).trim();
  const missingBarcode = (await barcodeNodes.nth(1).innerText()).trim();

  await scanAndConfirm(page, firstBarcode);
  await expect(detail).toContainText("清点差异，批次未推进", { timeout: 15_000 });
  await expect(detail).toContainText(missingBarcode);
  const resolveFirstHop = await waitForCommandResponse(
    page,
    "fulfillment.handoff.discrepancy.resolve",
    () => detail.getByRole("button", { name: "双人复核并处置差异" }).click(),
  );
  expect(resolveFirstHop, JSON.stringify(resolveFirstHop)).toMatchObject({
    ok: false,
    error: { code: "POLICY_STEP_UP_REQUIRED" },
  });
  await approveStepUp(page);
  await expect(detail).toContainText("运往工厂", { timeout: 15_000 });

  await scanAndConfirm(page, firstBarcode);
  await expect(detail).toContainText("工厂已收", { timeout: 15_000 });
  await detail
    .locator(".ld-factory-garment", { hasText: firstBarcode })
    .getByRole("checkbox")
    .check();
  await detail.getByRole("button", { name: "所选质检合格" }).click();
  await confirmFactoryAction(page);
  await expect(detail.locator(".ld-factory-garment", { hasText: firstBarcode })).toContainText(
    "pass",
    { timeout: 15_000 },
  );

  await scanAndConfirm(page, firstBarcode);
  await expect(detail).toContainText("运回门店", { timeout: 15_000 });
  await scanAndConfirm(page, firstBarcode);
  await expect(detail).toContainText("门店已收", { timeout: 15_000 });
  await expect(detail.locator(".ld-factory-checkpoints li")).toHaveCount(4);
  await expect(detail).toContainText("异常 1");

  await expect(page.locator(".ld-factory")).not.toContainText(FIXTURE.customerName);
  await expect(page.locator(".ld-factory")).not.toContainText(FIXTURE.customerPhone);
  const overflow = await horizontalOverflow(page);
  expect(overflow, JSON.stringify(overflow, null, 2)).toMatchObject({
    clientWidth: 390,
    offenders: [],
    scrollWidth: 390,
    scrollX: 0,
  });
});
