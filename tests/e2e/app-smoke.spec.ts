import { _electron as electron, expect, test } from "@playwright/test";

test("launches the desktop shell and renders M1 navigation", async () => {
  const app = await electron.launch({ args: ["."] });
  const page = await app.firstWindow();

  await expect(page.getByRole("heading", { name: "宏发洗衣店" })).toBeVisible();
  await expect(page.getByText("店长：周学胜")).toBeVisible();
  await expect(page.getByRole("link", { name: /收件登记/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /取件查询/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /订单列表/ })).toBeVisible();

  await app.close();
});
