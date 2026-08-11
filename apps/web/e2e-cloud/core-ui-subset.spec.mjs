import { CLOUD_WEB_ORIGIN } from "../../../tools/cloud/cloud-web-browser-boundary.mjs";

import { expect, test } from "./cloud-fixture.mjs";

test.skip(
  process.env.LAUNDRY_CLOUD_WEB_E2E !== "1",
  "set LAUNDRY_CLOUD_WEB_E2E=1 only after the intended main SHA is deployed",
);

function isBusinessCommand(request) {
  if (request.method() !== "POST") return false;
  return new URL(request.url()).pathname.startsWith("/v1/commands/");
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
}

async function assertAccountingReadSurface(page) {
  await page.locator('[data-nav-id="stats"]').click();
  const panel = page.locator('[data-testid="accounting-report-panel"]');
  await expect(panel).toBeVisible();
  await expect(page.locator('[data-testid="accounting-report-result"]')).toBeVisible();
  await expect(page.locator('[data-testid="accounting-export"]')).toBeVisible();
}

test("core_ui_subset: public Cloud Web read surfaces are reachable", async ({
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
  await assertCatalogReadSurface(cloudPage);
  await assertDebtAndFulfillmentReadSurfaces(cloudPage);
  await assertCustomerAndReminderReadSurfaces(cloudPage);
  await assertAccountingReadSurface(cloudPage);
  await cloudPage.waitForLoadState("networkidle");

  expect(businessCommands, "read-only subset must not issue product commands").toEqual([]);
});
