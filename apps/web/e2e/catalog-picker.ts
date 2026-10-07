import { expect, type Page } from "@playwright/test";

/** Search the unique fixture instead of assuming it is in the initial 50 results. */
export async function pickCatalogItem(page: Page, name: string): Promise<void> {
  const picker = page.locator('[data-testid="catalog-picker"]');
  await expect(picker).toBeVisible();
  await picker.locator('input[name="catalog-search"]').fill(name);
  await picker.getByRole("option", { name, exact: false }).click();
}
