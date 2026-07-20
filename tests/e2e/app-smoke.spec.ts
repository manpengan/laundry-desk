import { _electron as electron, expect, test } from "@playwright/test";

test("launches the desktop shell and renders M1 navigation", async () => {
  const app = await electron.launch({ args: ["."] });
  app
    .process()
    .stdout?.on("data", (data) => console.log("STDOUT:", data.toString()));
  app
    .process()
    .stderr?.on("data", (data) => console.error("STDERR:", data.toString()));
  // Electron 冷启动在 CI 上可能很慢；不设超时会表现为整测 30s 超时且无有效报错。
  const page = await app.firstWindow({ timeout: 30_000 });
  await page.waitForLoadState("domcontentloaded");
  page.on("console", (msg) => console.log("PAGE LOG:", msg.text()));
  page.on("pageerror", (err) => console.error("PAGE ERROR:", err.message));

  await expect(page.getByRole("heading", { name: "宏发洗衣店" })).toBeVisible();
  await expect(page.getByText(/店长\s*·\s*周学胜/)).toBeVisible();
  await expect(page.getByRole("link", { name: /收件登记/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /取件查询/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /订单列表/ })).toBeVisible();

  const statsLink = page.getByRole("link", { name: /统计报表/ });
  await expect(statsLink).toBeVisible();
  await statsLink.click();
  await expect(page.getByRole("heading", { name: "统计报表" })).toBeVisible({
    timeout: 15000,
  });
  await expect(page.getByText("今日收入")).toBeVisible();
  await expect(page.getByText("本月收入")).toBeVisible();

  const settingsLink = page.getByRole("link", { name: /系统设置/ });
  await expect(settingsLink).toBeVisible();
  await settingsLink.click();

  await expect(page.getByText("价格模板管理")).toBeVisible();
  await expect(page.getByText("外部数据导入")).toBeVisible();

  const receiveLink = page.getByRole("link", { name: /收件登记/ });
  await expect(receiveLink).toBeVisible();
  await receiveLink.click();
  await expect(page.getByText("衣物留样照片")).toBeVisible();

  await app.close();
});
