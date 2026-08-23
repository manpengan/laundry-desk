import { CLOUD_WEB_ORIGIN } from "../../../tools/cloud/cloud-web-browser-boundary.mjs";

import { expect, logoutBrowserContext, test } from "./cloud-fixture.mjs";

test.skip(
  process.env.LAUNDRY_CLOUD_WEB_E2E !== "1",
  "set LAUNDRY_CLOUD_WEB_E2E=1 only after the intended main SHA is deployed",
);

function isBusinessCommand(request) {
  if (request.method() !== "POST") return false;
  return new URL(request.url()).pathname.startsWith("/v1/commands/");
}

async function assertAiPanelCanClose(page, triggerName) {
  const trigger = page.getByRole("button", { name: triggerName, exact: true });
  const panel = page.locator('[data-testid="ai-panel"]');
  await expect(trigger).toHaveAttribute("aria-expanded", "false");

  await trigger.click();
  await expect(panel).toBeVisible();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  const close = panel.getByRole("button", { name: "关闭", exact: true });
  await expect(close).toBeFocused();
  await close.click();
  await expect(panel).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await trigger.click();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
}

async function assertCatalogReadSurface(page) {
  await page.locator('[data-nav-id="settings"]').click();
  const panel = page.locator('[data-testid="catalog-admin"]');
  await expect(panel).toBeVisible();
  const row = panel.locator('[data-testid="catalog-admin-row"]').first();
  const empty = panel.locator(".ld-settings-catalog__empty");
  await expect(row.or(empty)).toBeVisible();
}

async function assertDebtAndFulfillmentReadSurfaces(page) {
  await page.locator('[data-nav-id="orders"]').click();
  await expect(page.getByRole("heading", { name: "欠款" })).toBeVisible();
  await expect(page.locator('[data-testid="debt-list"]')).toBeVisible();

  await page.locator('[data-nav-id="fulfillment"]').click();
  await expect(page.getByRole("heading", { name: "生产工作台" })).toBeVisible();
  await expect(page.getByRole("region", { name: "生产筛选" })).toBeVisible();
}

async function assertCustomerAndReminderReadSurfaces(page) {
  await page.locator('[data-nav-id="customers"]').click();
  await expect(page.getByRole("heading", { name: "客户" })).toBeVisible();
  await expect(page.locator('[data-testid="customers-list"]')).toBeVisible();

  await page.locator('[data-nav-id="reminders"]').click();
  await expect(page.getByRole("heading", { name: "催取工作台" })).toBeVisible();
  await expect(page.getByRole("button", { name: "刷新候选" })).toBeVisible();
  const delivery = page.locator('[data-testid="notification-delivery-panel"]');
  await expect(delivery).toBeVisible();
  await expect(delivery.getByText(/自动通知未启用|软件模拟模式/u, { exact: true })).toBeVisible();
  await expect(delivery).not.toContainText(/已发送|送达|通知成功/u);
  await expect(delivery).not.toContainText(/1\d{10}/u);
}

async function assertAccountingReadSurface(page) {
  await page.locator('[data-nav-id="stats"]').click();
  const panel = page.locator('[data-testid="accounting-report-panel"]');
  await expect(panel).toBeVisible();
  await expect(page.locator('[data-testid="accounting-report-result"]')).toBeVisible();
  await expect(page.locator('[data-testid="accounting-export"]')).toBeVisible();
}

async function assertOwnerReadSurfaces(page) {
  await expect(page.locator('[data-shell="owner"]')).toHaveAttribute(
    "data-owner-access",
    "allowed",
  );
  await expect(page.locator('[data-testid="owner-dashboard"]')).toHaveAttribute(
    "data-state",
    "ready",
  );
  await expect(page.getByText("云端经营台", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "经营报表" }).click();
  await expect(page.locator('[data-testid="owner-reports"]')).toBeVisible();
  await expect(page.locator('[data-testid="accounting-report-result"]')).toBeVisible();

  await page.getByRole("button", { name: "门店管理" }).click();
  const management = page.locator('[data-testid="owner-store-management"]');
  await expect(management).toBeVisible();
  await expect(management.getByRole("heading", { name: "授权门店" })).toBeVisible();
  await expect(management.getByText("当前登录", { exact: true })).toHaveCount(1);
  await expect(management.locator('input[name="owner-store-code"]')).toBeDisabled();
  await expect(management.locator('input[name="owner-store-timezone"]')).toBeDisabled();
  await expect(
    management
      .getByRole("row")
      .filter({ hasText: "当前登录" })
      .getByRole("button", { name: "切换登录" }),
  ).toBeDisabled();
  await expect(page.locator('[data-testid="staff-access"]')).toBeVisible();
  await expect(page.locator('[data-testid="staff-access-list"]')).toBeVisible();
}

test("core_ui_subset: public Cloud Web read surfaces are reachable", async ({
  browser,
  cloudPage,
  cloudRun,
}) => {
  let businessCommands = Object.freeze([]);
  cloudPage.on("request", (request) => {
    if (isBusinessCommand(request)) {
      businessCommands = Object.freeze([...businessCommands, new URL(request.url()).pathname]);
    }
  });

  const health = await cloudPage
    .context()
    .request.get(`${CLOUD_WEB_ORIGIN}/health`, { maxRedirects: 0 });
  expect(health.ok()).toBeTruthy();
  await cloudRun.signIn(cloudPage);

  await expect(cloudPage.locator('[data-testid="counter-workbench-metrics"]')).toBeVisible();
  await assertAiPanelCanClose(cloudPage, "✨ AI");
  await assertCatalogReadSurface(cloudPage);
  await assertDebtAndFulfillmentReadSurfaces(cloudPage);
  await assertCustomerAndReminderReadSurfaces(cloudPage);
  await assertAccountingReadSurface(cloudPage);
  await cloudPage.waitForLoadState("networkidle");

  const ownerContext = await browser.newContext({ baseURL: CLOUD_WEB_ORIGIN });
  const ownerPage = await ownerContext.newPage();
  ownerPage.on("request", (request) => {
    if (isBusinessCommand(request)) {
      businessCommands = Object.freeze([...businessCommands, new URL(request.url()).pathname]);
    }
  });
  try {
    await cloudRun.signIn(ownerPage, "owner");
    await assertAiPanelCanClose(ownerPage, "✨ AI 助手");
    await assertOwnerReadSurfaces(ownerPage);
    await ownerPage.waitForLoadState("networkidle");
  } finally {
    await logoutBrowserContext(ownerContext);
    await ownerContext.close();
  }

  expect(businessCommands, "read-only subset must not issue product commands").toEqual([]);
});
