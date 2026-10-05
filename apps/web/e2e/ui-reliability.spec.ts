import { expect, test, type Page } from "@playwright/test";

const required = (key: string): string => {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is required`);
  return value;
};
async function login(page: Page) {
  await page.goto("http://127.0.0.1:5173");
  for (const [name, key] of Object.entries({
    org_code: "LAUNDRY_LOCAL_ORG_CODE",
    store_code: "LAUNDRY_LOCAL_STORE_CODE",
    username: "LAUNDRY_BOOTSTRAP_ADMIN_USERNAME",
    password: "LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD",
  })) {
    await page.locator(`input[name="${name}"]`).fill(required(key));
  }
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.locator('[data-shell="counter"]')).toBeVisible();
}

test("retained form, committed-response loss, replay, and identical new cash order", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await login(page);
  const code = `ux_${Date.now().toString(36)}`;
  const name = `UX 合成衬衫 ${code}`;
  await page.locator('[data-nav-id="settings"]').click();
  for (const [field, value] of Object.entries({
    code,
    name,
    service: "wash",
    category: code,
    price: "40.00",
  })) {
    await page.locator(`input[name="catalog-${field}"]`).fill(value);
  }
  await page.locator('[data-testid="catalog-save-btn"]').click();
  await expect(page.locator('[data-testid="catalog-admin-row"]', { hasText: code })).toBeVisible();
  await page.locator('[data-nav-id="receive"]').click();
  const fill = async () => {
    await page.getByRole("option", { name: new RegExp(name, "u") }).click();
    await page.locator('input[name="customer-name"]').fill("UI 合成顾客");
    await page.locator('input[name="initial-payment"]').fill("10.00");
    await page.getByLabel("第 1 件颜色").fill("白");
  };
  await fill();
  await page.locator('[data-nav-id="workbench"]').click();
  await page.locator('[data-nav-id="receive"]').click();
  await expect(page.locator('input[name="customer-name"]')).toHaveValue("UI 合成顾客");
  await expect(page.getByLabel("第 1 件颜色")).toHaveValue("白");
  await page.getByRole("button", { name: "切换员工" }).click();
  await expect(page.getByRole("dialog", { name: "保护当前开单内容" })).toBeVisible();
  await page.getByRole("button", { name: "保留，返回操作" }).click();

  const keys: string[] = [];
  let loseResponse = true;
  await page.route("**/v1/commands/order.receive", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    keys.push(route.request().headers()["idempotency-key"] ?? "");
    const headers = await route.request().allHeaders();
    // Interception occurs before Chromium attaches Fetch Metadata; preserve the local browser ingress profile.
    const response = await route.fetch({ headers: { ...headers, "sec-fetch-site": "same-site" } });
    if (loseResponse) {
      loseResponse = false;
      expect(response.ok(), JSON.stringify(await response.json())).toBe(true);
      await route.abort("failed");
    } else await route.fulfill({ response });
  });
  await page.keyboard.press("Control+Enter");
  await expect(page.getByRole("heading", { name: "先确认本次开单结果" })).toBeVisible();
  await page.keyboard.press("Control+Enter");
  await page.getByRole("button", { name: "重试确认本次开单" }).click();
  const ticket = page.locator('[data-testid="receive-ticket"]');
  await expect(ticket).toBeVisible();
  const first = await ticket.innerText();
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBeTruthy();
  expect(keys[1]).toBe(keys[0]);
  await expect(page.locator(".ld-order-result")).toContainText("¥30.00");
  await page.keyboard.press("Control+Enter");
  await page.getByRole("button", { name: "开下一单" }).click();
  await fill();
  await page.keyboard.press("Control+Enter");
  await expect(ticket).toBeVisible();
  expect(await ticket.innerText()).not.toBe(first);
  expect(keys).toHaveLength(3);
  expect(keys[2]).not.toBe(keys[0]);
  await page.keyboard.press("Control+Enter");
  await page.locator('[data-nav-id="workbench"]').click();
  await page.locator('[data-nav-id="receive"]').click();
  await expect(ticket).toBeVisible();
  expect(keys).toHaveLength(3);

  await page.route("**/health", (route) => route.abort("failed"));
  await expect(page.locator(".ld-sync-bar")).toHaveAttribute("data-mode", "offline", {
    timeout: 12_000,
  });
  await expect(page.locator(".ld-sync-bar")).not.toContainText("全部已同步");
  await page.unroute("**/health");
  await expect(page.locator(".ld-sync-bar")).toHaveAttribute("data-mode", "online", {
    timeout: 12_000,
  });
});
