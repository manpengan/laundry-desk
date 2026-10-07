import { expect, type Page } from "@playwright/test";

const FEATURE_SECTIONS = [
  { id: "settings-payments", label: "支付渠道与对账", region: "支付渠道与对账" },
  { id: "settings-store-export", label: "整店业务导出", region: "整店业务导出" },
  { id: "settings-migration", label: "旧版数据导入", region: "旧版数据迁移" },
  { id: "settings-notification", label: "阿里云短信", region: "阿里云短信设置" },
  { id: "settings-ai", label: "AI 助手与密钥", region: "AI 配置" },
] as const;

async function selectSettingsSection(page: Page, id: string, label: string): Promise<void> {
  const navigation = page.getByRole("navigation", { name: "设置分区" });
  await expect(navigation).toBeVisible();
  const mobileSelect = navigation.getByRole("combobox", { name: "查看分区" });
  if (await mobileSelect.isVisible()) {
    await mobileSelect.selectOption(id);
  } else {
    const button = navigation.getByRole("button", { name: label, exact: true });
    if (!(await button.isVisible())) {
      await navigation.getByRole("button", { name: "高级设置", exact: true }).click();
    }
    await button.click();
  }
  await expect(page.locator(`#${id}`)).toBeVisible();
}

/**
 * Read installed capabilities without enabling providers or sending external requests.
 * ADR-91 P1-8: with a screenshot path, each offered panel is captured beside it as evidence.
 */
export async function verifyInstalledFeatureSettings(
  page: Page,
  screenshotPath?: string,
): Promise<void> {
  await page.locator('[data-nav-id="settings"]').click();
  for (const { id, label, region } of FEATURE_SECTIONS) {
    await selectSettingsSection(page, id, label);
    const section = page.locator(`#${id}`);
    await expect(section).toHaveCount(1);
    await expect(section.getByRole("region", { name: region, exact: true })).toBeVisible();
    // A panel must open without a failure notice before anyone has used it.
    await expect(section.locator('[role="alert"]')).toHaveCount(0);
    if (screenshotPath !== undefined) {
      await section.scrollIntoViewIfNeeded();
      await section.screenshot({ path: screenshotPath.replace(/\.png$/u, `-${id}.png`) });
    }
  }
  // ADR-91 D-1/D-2: public-entry features stay installed but are not offered.
  for (const id of [
    "settings-miniapp",
    "settings-miniapp-notifications",
    "settings-remote-assistance",
  ])
    await expect(page.locator(`#${id}`)).toHaveCount(0);
  await selectSettingsSection(page, "settings-payments", "支付渠道与对账");
  const payment = page.getByRole("region", { name: "支付渠道与对账", exact: true });
  await payment.getByRole("button", { name: "商户设置", exact: true }).click();
  await expect(page.getByRole("region", { name: "支付商户设置" })).toBeVisible();
  await expect(page.getByRole("region", { name: "顾客小程序配置" })).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "阿里云短信设置", includeHidden: true }),
  ).toHaveCount(1);

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
