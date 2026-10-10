import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/e2e/counter-keyboard.html");
  await expect(page.getByRole("option")).toHaveCount(2);
  await expect(page.getByRole("option").first()).toBeEnabled();
});

for (const chord of ["Control+Enter", "Meta+Enter"]) {
  test(`${chord} in catalog search submits once without adding an item`, async ({ page }) => {
    await page.getByRole("textbox", { name: "搜索价目" }).press(chord);
    await expect(page.getByTestId("submitted")).toHaveText("1");
    await expect(page.getByTestId("picked")).toHaveText("0");
  });
}

test("plain Enter adds once; Alt and composing Enter do not add or submit", async ({ page }) => {
  const search = page.getByRole("textbox", { name: "搜索价目" });
  await search.press("Alt+Enter");
  await search.dispatchEvent("keydown", { key: "Enter", isComposing: true });
  await expect(page.getByTestId("picked")).toHaveText("0");
  await expect(page.getByTestId("submitted")).toHaveText("0");
  await search.press("Enter");
  await expect(page.getByTestId("picked")).toHaveText("1");
  await expect(page.getByTestId("submitted")).toHaveText("0");
});

test("searching another category resets the obsolete filter and keeps the result selectable", async ({
  page,
}) => {
  await page.getByRole("button", { name: /干洗 F2/u }).click();
  await expect(page.getByRole("option")).toHaveCount(1);
  const search = page.getByRole("textbox", { name: "搜索价目" });
  await search.fill("衬衫");
  await expect(page.getByRole("option", { name: /水洗衬衫/u })).toBeEnabled();
  await page.getByRole("option", { name: /水洗衬衫/u }).click();
  await expect(page.getByTestId("picked")).toHaveText("1");
  await search.fill("");
  await expect(page.getByRole("option")).toHaveCount(2);
  await expect(page.getByRole("button", { name: /全部 F1/u })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("a valid selected category survives search, while empty results clear an obsolete filter", async ({
  page,
}) => {
  const search = page.getByRole("textbox", { name: "搜索价目" });
  await page.getByRole("button", { name: /干洗 F2/u }).click();
  await search.fill("大衣");
  await expect(page.getByRole("option", { name: /干洗大衣/u })).toBeEnabled();
  await search.fill("");
  await expect(page.getByRole("button", { name: /干洗 F2/u })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("option")).toHaveCount(1);
  await search.fill("不存在");
  await expect(page.getByText("还没有价目", { exact: true })).toBeVisible();
  await search.fill("");
  await expect(page.getByRole("option")).toHaveCount(2);
});

for (const expanded of [false, true]) {
  test(`drawer Tab order includes summary and skips collapsed descendants (expanded=${expanded})`, async ({
    page,
  }) => {
    const opener = page.getByRole("button", { name: "打开订单详情", exact: true });
    await opener.click();
    const dialog = page.getByRole("dialog", { name: "订单详情" });
    const before = dialog.getByRole("button", { name: "前置按钮", exact: true });
    const summary = dialog.locator("summary").filter({ hasText: /^更多信息$/u });
    const after = dialog.getByRole("button", { name: "上传照片", exact: true });
    const close = dialog.getByRole("button", { name: "关闭", exact: true });
    if (expanded) await summary.click();
    const middle = expanded
      ? [
          summary,
          dialog.getByRole("button", { name: "详情内按钮", exact: true }),
          dialog.locator("summary").filter({ hasText: /^嵌套详情$/u }),
        ]
      : [summary];
    const ordered = [before, ...middle, after, close];
    await before.focus();
    for (const target of [...ordered.slice(1), before]) {
      await page.keyboard.press("Tab");
      await expect(target).toBeFocused();
    }
    for (const target of [...ordered.slice(1).reverse(), before]) {
      await page.keyboard.press("Shift+Tab");
      await expect(target).toBeFocused();
    }
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
  });
}
