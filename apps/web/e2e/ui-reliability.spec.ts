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

async function createCatalog(page: Page, code: string, name: string) {
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
}

async function expectCatalogHeadingBelowHeader(page: Page) {
  const heading = page.locator("#settings-catalog h2").first();
  await expect(heading).toBeInViewport();
  await expect
    .poll(async () => {
      const title = await heading.boundingBox();
      const header = await page.locator(".ld-shell-topbar").boundingBox();
      return title !== null && header !== null && title.y >= header.y + header.height;
    })
    .toBe(true);
}

test("retained form, committed-response loss, replay, and identical new cash order", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await login(page);
  const code = `ux_${Date.now().toString(36)}`;
  const name = `UX 合成衬衫 ${code}`;
  await createCatalog(page, code, name);
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
  await expect(page.locator(".ld-order-result")).toContainText(name);
  await expect(page.locator(".ld-order-result")).toContainText("白");
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

test("staff switching blocks pending receipts and resets only the receive workspace", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await login(page);
  const code = `scope_${Date.now().toString(36)}`;
  const name = `员工隔离合成衣物 ${code}`;
  await createCatalog(page, code, name);
  await page.locator('[data-nav-id="receive"]').click();
  await page.getByRole("option", { name: new RegExp(name, "u") }).click();
  await page.locator('input[name="customer-name"]').fill("前一位员工的合成录入");
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let committed = false;
  let delivered = false;
  await page.route("**/v1/commands/order.receive", async (route) => {
    const headers = await route.request().allHeaders();
    const response = await route.fetch({ headers: { ...headers, "sec-fetch-site": "same-site" } });
    expect(response.ok()).toBe(true);
    committed = true;
    await held;
    await route.fulfill({ response });
    delivered = true;
  });
  try {
    await page.getByRole("button", { name: "确认开单", exact: true }).click();
    await expect.poll(() => committed).toBe(true);
    await page.getByRole("button", { name: "切换员工" }).click();
    await expect(page.getByRole("dialog", { name: "切换员工" })).toBeHidden();
    await expect(page.getByRole("dialog", { name: "保护当前开单内容" })).toBeHidden();
    await expect(page.getByText("正在确认开单，请稍候…", { exact: true })).toBeVisible();
    release();
    await expect.poll(() => delivered).toBe(true);
    await expect(page.locator('[data-testid="receive-ticket"]')).toBeVisible();
    await page.getByRole("button", { name: "开下一单" }).click();
    await page.locator('input[name="customer-name"]').fill("前一位员工的合成录入");
    await page.getByRole("button", { name: "切换员工" }).click();
    await page.getByRole("button", { name: "确认后继续", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "切换员工" });
    await dialog.getByLabel("目标员工").selectOption({ label: "E2E Staff One" });
    await dialog.locator('input[name="pin"]').fill(required("LAUNDRY_BOOTSTRAP_ADMIN_PIN"));
    await dialog.getByRole("button", { name: "确认切换" }).click();
    await expect(page.locator('[data-shell="counter"]')).toHaveAttribute("data-role", "staff");
    await expect(page.locator('[data-shell="counter"]')).toHaveAttribute("data-nav", "receive");
    await expect(page.locator('input[name="customer-name"]')).toHaveValue("");
    await page.locator('input[name="customer-name"]').fill("下一位员工的合成录入");
    await page.locator('[data-nav-id="workbench"]').click();
    await page.locator('[data-nav-id="receive"]').click();
    await expect(page.locator('input[name="customer-name"]')).toHaveValue("下一位员工的合成录入");
    await expect(page.locator('[data-testid="receive-ticket"]')).toHaveCount(0);
    await page.getByRole("button", { name: "切换员工" }).click();
    await page.getByRole("button", { name: "确认后继续", exact: true }).click();
    const firstStaff = dialog.getByLabel("目标员工").locator("option").first();
    const targetName = await firstStaff.innerText();
    await expect(dialog.getByLabel("目标员工")).toHaveValue(
      (await firstStaff.getAttribute("value")) ?? "",
    );
    await dialog.locator('input[name="pin"]').fill(required("LAUNDRY_BOOTSTRAP_ADMIN_PIN"));
    await dialog.getByRole("button", { name: "确认切换" }).click();
    await expect(page.locator(".ld-shell-topbar__staff")).toHaveText(targetName);
    await expect(page.locator('[data-shell="counter"]')).toHaveAttribute("data-nav", "receive");
    await expect(page.locator('input[name="customer-name"]')).toHaveValue("");
  } finally {
    release();
  }
});

test("checkout stays reachable in short and narrow windows without covering fields", async ({
  page,
}) => {
  await login(page);
  await page.locator('[data-nav-id="receive"]').click();
  for (const [width, height] of [
    [1280, 800],
    [853, 600],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.locator('[aria-label="结算"]').scrollIntoViewIfNeeded();
    const fields = await page.locator(".ld-settlement-fields").boundingBox();
    const actions = await page.locator(".ld-counter-actions").boundingBox();
    expect(fields).not.toBeNull();
    expect(actions).not.toBeNull();
    expect(fields!.y + fields!.height).toBeLessThanOrEqual(actions!.y + 1);
    await expect(page.getByRole("button", { name: "确认开单", exact: false })).toBeInViewport();
    await page.locator('input[name="initial-payment"]').fill("1.50");
    await expect(page.locator('input[name="initial-payment"]')).toBeFocused();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "去客户与结算" }).click();
  await expect(page.locator('input[name="customer-phone"]')).toBeFocused();
  await page.locator('[data-nav-id="settings"]').click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("settings templates, search and section switching preserve edits and expose failed loading", async ({
  page,
}) => {
  await login(page);
  await page.locator('[data-nav-id="settings"]').click();
  await page.getByLabel("从常用品类开始").selectOption("wash_shirt");
  await expect(page.locator('input[name="catalog-name"]')).toHaveValue("水洗衬衫");
  await expect(page.locator('input[name="catalog-price"]')).toHaveValue("");
  await page.locator('input[name="catalog-name"]').fill("测试模板草稿");
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.locator("#settings-staff").scrollIntoViewIfNeeded();
  await page.getByRole("button", { name: "价目维护", exact: true }).click();
  await expectCatalogHeadingBelowHeader(page);
  await page.locator('input[name="settings-search"]').fill("主题");
  await expect(page.locator("#settings-appearance")).toBeVisible();
  await expect(page.locator("#settings-catalog")).toBeHidden();
  await page.locator('input[name="settings-search"]').fill("价目");
  await expect(page.locator('input[name="catalog-name"]')).toHaveValue("测试模板草稿");
  await page.locator('input[name="settings-search"]').fill("不存在的设置");
  await expect(page.getByText("没有找到相关设置，请换一个关键词。")).toBeVisible();
  await page.locator('input[name="settings-search"]').fill("");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel("查看分区").selectOption("settings-catalog");
  await expectCatalogHeadingBelowHeader(page);
  await expect(page.locator("#settings-appearance")).toBeHidden();
  await expect(page.locator('input[name="catalog-name"]')).toHaveValue("测试模板草稿");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.route("**/v1/queries/catalog.items.manage.list", (route) => route.abort("failed"));
  await page.getByRole("button", { name: "刷新列表", exact: true }).click();
  await expect(
    page.getByText("价目读取失败，当前列表可能不是最新。请刷新后再操作。"),
  ).toBeVisible();
  await expect(page.getByText("还没有价目，先添加一条才能开单")).toBeHidden();
});
