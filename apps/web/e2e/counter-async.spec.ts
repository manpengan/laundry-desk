/** Real login with controlled read responses to exercise scanner request races. */
import { expect, test, type Page, type Route } from "@playwright/test";

const WEB = "http://127.0.0.1:5173";

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

async function signIn(page: Page): Promise<void> {
  await page.goto(WEB);
  for (const [field, environment] of [
    ["org_code", "LAUNDRY_LOCAL_ORG_CODE"],
    ["store_code", "LAUNDRY_LOCAL_STORE_CODE"],
    ["username", "LAUNDRY_BOOTSTRAP_ADMIN_USERNAME"],
    ["password", "LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD"],
  ] as const) {
    await page.locator(`input[name="${field}"]`).fill(requiredEnvironment(environment));
  }
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.locator('[data-shell="counter"]')).toBeVisible({ timeout: 15_000 });
}

function deferred() {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function respond(route: Route, result: unknown): Promise<void> {
  await route.fulfill({ json: { ok: true, data: { execution: "executed", result } } });
}

const OLD_ITEM = Object.freeze({
  code: "async_old",
  name: "异步回归旧价目",
  service_code: "wash",
  category_code: "async_old",
  unit_price_cents: 1500,
});
const NEW_ITEM = Object.freeze({
  ...OLD_ITEM,
  code: "async_new",
  name: "异步回归新价目",
  category_code: "async_new",
  unit_price_cents: 2500,
});

test("catalog Enter never picks a previous search during debounce or a delayed response", async ({
  page,
}) => {
  const requested = deferred();
  const release = deferred();
  await page.route("**/v1/queries/catalog.items.list", async (route) => {
    const body = route.request().postDataJSON() as { query: string };
    if (body.query === "async_new") {
      requested.resolve();
      await release.promise;
      await respond(route, { items: [NEW_ITEM], total: 1 });
    } else {
      await respond(route, { items: [OLD_ITEM], total: 1 });
    }
  });
  try {
    await signIn(page);
    await page.locator('[data-nav-id="receive"]').click();
    const picker = page.locator('[data-testid="catalog-picker"]');
    const oldOption = picker.getByRole("option", { name: new RegExp(OLD_ITEM.name, "u") });
    await expect(oldOption).toBeEnabled();
    const search = picker.locator('input[name="catalog-search"]');
    const lines = page.getByRole("region", { name: "衣物明细" });
    await search.fill("async_new");
    await search.press("Enter");
    await expect(search).toHaveValue("async_new");
    await expect(lines).not.toContainText(OLD_ITEM.name);
    await expect(oldOption).toBeDisabled();
    await requested.promise;
    await search.press("Enter");
    await expect(search).toHaveValue("async_new");
    await expect(lines).not.toContainText(OLD_ITEM.name);
    release.resolve();
    await expect(
      picker.getByRole("option", { name: new RegExp(NEW_ITEM.name, "u") }),
    ).toBeEnabled();
    await search.press("Enter");
    await expect(lines).toContainText(NEW_ITEM.name);
    await expect(lines).toContainText("¥25.00");
  } finally {
    release.resolve();
  }
});

function order(orderId: string, suffix: string) {
  return Object.freeze({
    order_id: orderId,
    ticket_no: `E2E-ASYNC-${suffix}`,
    pickup_code: `ASYNC${suffix}`,
    status: "open",
    payable_cents: 100,
    paid_cents: 0,
    balance_cents: 100,
    created_at: 0,
    customer_phone: null,
    customer_name: null,
    garments: [],
    matched_by: "ticket_no",
  });
}

const ORDERS = Object.freeze([
  order("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", "A"),
  order("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", "B"),
  order("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3", "C"),
]);

async function renderSettled(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

test("late automatic pickup loading cannot replace a newer scan or end its loading state", async ({
  page,
}) => {
  const firstRequested = deferred();
  const lastRequested = deferred();
  const releaseFirst = deferred();
  const releaseLast = deferred();
  await page.route("**/v1/queries/order.lookup", async (route) => {
    const body = route.request().postDataJSON() as { key: string };
    await respond(route, { orders: ORDERS.filter((item) => item.ticket_no === body.key) });
  });
  await page.route("**/v1/queries/order.get", async (route) => {
    const body = route.request().postDataJSON() as { order_id: string };
    const item = ORDERS.find((candidate) => candidate.order_id === body.order_id);
    if (item === undefined) {
      await route.continue();
      return;
    }
    if (item === ORDERS[0]) {
      firstRequested.resolve();
      await releaseFirst.promise;
    } else if (item === ORDERS[2]) {
      lastRequested.resolve();
      await releaseLast.promise;
    }
    await respond(route, item);
  });
  try {
    await signIn(page);
    const quick = page.locator('input[name="quick-pickup"]');
    await quick.fill(ORDERS[0]!.ticket_no);
    await quick.press("Enter");
    await firstRequested.promise;
    const scan = page.locator('input[name="pickup-key"]');
    const loaded = page.locator('[data-testid="pickup-loaded-ticket"]');
    await scan.fill(ORDERS[1]!.ticket_no);
    await scan.press("Enter");
    await expect(loaded).toHaveText(ORDERS[1]!.ticket_no);
    await scan.fill(ORDERS[2]!.ticket_no);
    await scan.press("Enter");
    await lastRequested.promise;
    const firstResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/v1/queries/order.get" &&
        (response.request().postDataJSON() as { order_id: string }).order_id ===
          ORDERS[0]!.order_id,
    );
    releaseFirst.resolve();
    await (await firstResponse).finished();
    await renderSettled(page);
    await expect(loaded).toHaveCount(0);
    await expect(scan).toHaveValue(ORDERS[2]!.ticket_no);
    await expect(page.getByRole("button", { name: "加载中…", exact: true })).toBeDisabled();
    releaseLast.resolve();
    await expect(loaded).toHaveText(ORDERS[2]!.ticket_no);
    await expect(page.getByRole("button", { name: "加载订单", exact: true })).toBeEnabled();
  } finally {
    releaseFirst.resolve();
    releaseLast.resolve();
  }
});
