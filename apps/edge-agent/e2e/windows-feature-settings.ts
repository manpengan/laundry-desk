import { expect, type Page } from "@playwright/test";

/** Read installed capabilities without enabling providers or sending external requests. */
export async function verifyInstalledFeatureSettings(page: Page): Promise<void> {
  await page.locator('[data-nav-id="settings"]').click();
  for (const id of [
    "settings-payments",
    "settings-miniapp",
    "settings-miniapp-notifications",
    "settings-remote-assistance",
    "settings-store-export",
    "settings-migration",
    "settings-notification",
    "settings-ai",
  ]) {
    await expect(page.locator(`#${id}`)).toHaveCount(1);
  }
  const payment = page.getByRole("region", { name: "支付渠道与对账", exact: true });
  await payment.getByRole("button", { name: "商户设置", exact: true }).click();
  await expect(page.getByRole("region", { name: "支付商户设置" })).toBeVisible();
  await expect(page.getByRole("region", { name: "顾客小程序配置" })).toHaveCount(1);
  await expect(page.getByRole("region", { name: "阿里云短信设置" })).toHaveCount(1);

  const capabilities = await page.evaluate(async () => {
    type Bridge = Readonly<Record<string, { execute: (input: unknown) => Promise<unknown> }>>;
    const bridge = (window as Window & { laundryDesktop?: Bridge }).laundryDesktop;
    const operations = [
      { name: "paymentChannel", input: { operation: "settings.get" } },
      { name: "miniappSettings", input: { operation: "read" } },
      { name: "notificationSettings", input: { kind: "get" } },
      { name: "ai", input: { operation: "config" } },
      { name: "remoteAssistance", input: { operation: "status" } },
    ];
    const results = [];
    for (const operation of operations) {
      const result = await bridge?.[operation.name]?.execute(operation.input);
      const valid = typeof result === "object" && result !== null && "ok" in result;
      const ok = valid && result.ok === true;
      const data = valid && "data" in result ? result.data : undefined;
      const record = typeof data === "object" && data !== null ? data : {};
      results.push({
        name: operation.name,
        ok,
        custody: "custody_available" in record ? record.custody_available === true : null,
        remoteConfigured: "configured" in record ? record.configured === true : null,
      });
    }
    return results;
  });
  expect(capabilities).toEqual([
    { name: "paymentChannel", ok: true, custody: true, remoteConfigured: null },
    { name: "miniappSettings", ok: true, custody: true, remoteConfigured: null },
    { name: "notificationSettings", ok: true, custody: true, remoteConfigured: null },
    { name: "ai", ok: true, custody: true, remoteConfigured: null },
    { name: "remoteAssistance", ok: true, custody: null, remoteConfigured: false },
  ]);
  const sensitiveInputsEmpty = await page
    .locator('input[type="password"]')
    .evaluateAll((inputs) =>
      inputs.every((input) => input instanceof HTMLInputElement && input.value === ""),
    );
  expect(sensitiveInputsEmpty).toBe(true);
  await page.locator('[data-nav-id="workbench"]').click();
}
