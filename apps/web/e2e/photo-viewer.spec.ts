import { expect, test, type Locator, type Page } from "@playwright/test";

async function expectReachable(control: Locator) {
  const geometry = await control.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      withinViewport:
        rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
      receivesPointer: element.contains(
        document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2),
      ),
    };
  });
  expect(geometry).toEqual({ withinViewport: true, receivesPointer: true });
}

async function openViewer(page: Page) {
  await page.goto("/e2e/photo-viewer.html");
  await page.getByRole("button", { name: "打开订单", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "订单详情", exact: true });
  await expect(drawer).toBeVisible();
  // The actual material is essential: backdrop-filter establishes the original containing block.
  expect(await drawer.evaluate((element) => getComputedStyle(element).backdropFilter)).not.toBe(
    "none",
  );
  const thumbnail = page.getByRole("button", { name: "收衣 照片缩略图", exact: true });
  await thumbnail.click();
  const viewer = page.getByRole("dialog", { name: "查看照片", exact: true });
  const original = viewer.getByRole("img", { name: "收衣 照片", exact: true });
  await expect(original).toBeVisible();
  await expect
    .poll(() =>
      original.evaluate(
        (image) =>
          image instanceof HTMLImageElement && image.complete && image.naturalWidth === 1200,
      ),
    )
    .toBe(true);
  return {
    drawer,
    thumbnail,
    viewer,
    close: viewer.getByRole("button", { name: "关闭照片", exact: true }),
  };
}

for (const viewport of [
  { width: 1707, height: 1004 },
  { width: 1024, height: 600 },
  { width: 375, height: 360 },
]) {
  test(`photo remains closable inside a glass drawer at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const { drawer, thumbnail, viewer, close } = await openViewer(page);
    await expectReachable(close);
    await close.click();
    await expect(viewer).toHaveCount(0);
    await expect(drawer).toBeVisible();
    await expect(thumbnail).toBeFocused();
    await thumbnail.click();
    await expect(viewer.getByRole("img")).toBeVisible();
    await viewer.getByRole("button", { name: "删除照片", exact: true }).click();
    await expectReachable(close);
    await expectReachable(viewer.getByRole("button", { name: "确认删除", exact: true }));
    await close.click();
    await expect(drawer).toBeVisible();
  });
}

test("photo viewer traps keyboard focus and Escape closes only the top overlay", async ({
  page,
}) => {
  const { drawer, thumbnail, viewer, close } = await openViewer(page);
  await expect(close).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(viewer.getByRole("button", { name: "删除照片", exact: true })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);
  await expect(drawer).toBeVisible();
  await expect(thumbnail).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(page.getByRole("button", { name: "打开订单", exact: true })).toBeFocused();
});
