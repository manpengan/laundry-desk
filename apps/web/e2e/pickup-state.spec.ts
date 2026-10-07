/** Actual browser DOM regressions; all business responses remain synthetic and local. */
import { expect, test, type Page, type Route } from "@playwright/test";

const ORDER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const ORDER_B = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const GARMENT_A = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const GARMENT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";

function garment(id: string, status = "ready") {
  return {
    garment_id: id,
    barcode: `PICKUP-${id.slice(-1)}`,
    status,
    line_index: 0,
    seq: 1,
    unit_price_cents: 1600,
    service_code: "wash",
    category_code: "shirt",
    color: "白",
    brand: null,
    defects: [],
    accessories: [],
    note: null,
    addons: [],
    rack_zone: null,
    rack_slot: null,
  };
}

function order(id = ORDER_A, garments = [garment(GARMENT_A)], status = "open") {
  return {
    order_id: id,
    ticket_no: `PICKUP-${id.slice(-1)}`,
    pickup_code: `CODE${id.slice(-1)}`,
    status,
    payable_cents: 3200,
    paid_cents: 0,
    balance_cents: 3200,
    created_at: 0,
    customer_phone: null,
    customer_name: null,
    garments,
    matched_by: "ticket_no",
  };
}

type Order = ReturnType<typeof order>;
type PickupBody = {
  order_id: string;
  collect_cents: number;
  garment_ids: string[];
  verification_barcodes: string[];
};
type Handler = (route: Route) => Promise<void>;

function success(result: unknown) {
  return { ok: true, data: { execution: "executed", result } };
}

async function respond(route: Route, result: unknown): Promise<void> {
  await route.fulfill({ json: success(result) });
}

function settled(body: PickupBody) {
  return {
    order_id: body.order_id,
    ticket_no: `PICKUP-${body.order_id.slice(-1)}`,
    status: "closed",
    paid_cents: body.collect_cents,
    balance_cents: 3200 - body.collect_cents,
    picked_garment_ids: body.garment_ids,
  };
}

async function mount(
  page: Page,
  options: {
    get?: Handler;
    lookup?: Handler;
    command?: Handler;
    orders?: Order[];
    channels?: boolean;
  } = {},
) {
  const orders = options.orders ?? [order(), order(ORDER_B, [garment(GARMENT_B)])];
  const commands: PickupBody[] = [];
  await page.route(
    "**/__pickup_state/query/order.get",
    options.get ??
      (async (route) => {
        const body = route.request().postDataJSON() as { order_id: string };
        await respond(
          route,
          orders.find((item) => item.order_id === body.order_id),
        );
      }),
  );
  await page.route(
    "**/__pickup_state/query/order.lookup",
    options.lookup ??
      (async (route) => {
        const body = route.request().postDataJSON() as { key: string };
        await respond(route, { orders: orders.filter((item) => item.ticket_no === body.key) });
      }),
  );
  await page.route("**/__pickup_state/command/order.pickup", async (route) => {
    const body = route.request().postDataJSON() as PickupBody;
    commands.push(body);
    if (options.command !== undefined) await options.command(route);
    else await respond(route, settled(body));
  });
  await page.goto(`/e2e/pickup-state.html${options.channels ? "?channels" : ""}`);
  await expect(page.getByRole("heading", { name: "取衣", exact: true })).toBeVisible();
  return {
    commands,
    money: page.locator('input[name="collect-cents"]'),
    confirm: page.getByRole("button", { name: "确认取衣", exact: true }),
    loaded: page.getByTestId("pickup-loaded-ticket"),
    scan: page.locator('input[name="pickup-key"]'),
  };
}

async function load(page: Page, key = ORDER_A) {
  await page.locator('input[name="pickup-key"]').fill(key);
  await page.getByRole("button", { name: "加载订单", exact: true }).click();
  await expect(page.getByTestId("pickup-loaded-ticket")).toHaveText(`PICKUP-${key.slice(-1)}`);
}

function deferred() {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("completed pickup clears collection, disables resubmit, and the next order starts at zero", async ({
  page,
}) => {
  const ui = await mount(page);
  await load(page);
  await ui.money.fill("16.00");
  await ui.confirm.click();
  await expect(page.getByTestId("pickup-ticket")).toHaveText("PICKUP-1");
  await expect(ui.money).toHaveValue("0.00");
  await expect(ui.money).toBeDisabled();
  await expect(ui.confirm).toBeDisabled();
  await ui.confirm.dispatchEvent("click");
  await load(page, ORDER_B);
  await expect(ui.money).toHaveValue("0.00");
  await ui.confirm.click();
  await expect(page.getByTestId("pickup-ticket")).toHaveText("PICKUP-2");
  expect(ui.commands.map((body) => [body.order_id, body.collect_cents])).toEqual([
    [ORDER_A, 1600],
    [ORDER_B, 0],
  ]);
});

test("confirmed success with an unreadable result clears the draft instead of allowing retry", async ({
  page,
}) => {
  const ui = await mount(page, { command: async (route) => respond(route, { invalid: true }) });
  await load(page);
  await ui.money.fill("16.00");
  await ui.confirm.click();
  await expect(
    page.getByText("取衣已提交，但结果无法解析，请重新查询订单", { exact: true }),
  ).toBeVisible();
  await expect(ui.loaded).toHaveCount(0);
  await expect(ui.money).toHaveValue("0.00");
  await expect(ui.confirm).toBeDisabled();
  await ui.confirm.dispatchEvent("click");
  expect(ui.commands).toHaveLength(1);
});

test("partial pickup reload and switching an unsubmitted order do not retain its collection", async ({
  page,
}) => {
  let partial = false;
  const ui = await mount(page, {
    get: async (route) => {
      const body = route.request().postDataJSON() as { order_id: string };
      await respond(
        route,
        body.order_id === ORDER_A
          ? order(ORDER_A, [
              garment(GARMENT_A, partial ? "picked_up" : "ready"),
              garment(GARMENT_B),
            ])
          : order(ORDER_B, [garment(GARMENT_B)]),
      );
    },
    command: async (route) => {
      partial = true;
      await respond(route, {
        ...settled(route.request().postDataJSON() as PickupBody),
        status: "open",
      });
    },
  });
  await load(page);
  await page.getByTestId(`pickup-garment-${GARMENT_B}`).uncheck();
  await ui.money.fill("16.00");
  await ui.confirm.click();
  await expect(page.getByTestId("pickup-ticket")).toBeVisible();
  await load(page);
  await expect(ui.money).toHaveValue("0.00");
  await expect(page.getByTestId(`pickup-garment-${GARMENT_A}`)).toBeDisabled();
  await expect(page.getByTestId(`pickup-garment-${GARMENT_B}`)).toBeChecked();
  await ui.money.fill("8.00");
  await load(page, ORDER_B);
  await expect(ui.money).toHaveValue("0.00");
  expect(ui.commands).toHaveLength(1);
});

test("empty, closed, non-pickable, and deselected orders cannot collect or confirm", async ({
  page,
}) => {
  const ui = await mount(page, {
    orders: [order(), order(ORDER_B, [garment(GARMENT_B)], "closed")],
  });
  await expect(ui.money).toBeDisabled();
  await expect(ui.confirm).toBeDisabled();
  await load(page, ORDER_B);
  await expect(ui.money).toBeDisabled();
  await expect(ui.confirm).toBeDisabled();
  await load(page);
  await ui.money.fill("6.00");
  await page.getByRole("button", { name: "全不选" }).click();
  await expect(ui.money).toBeDisabled();
  await expect(ui.confirm).toBeDisabled();
  await page.getByRole("button", { name: "全选可取" }).click();
  await expect(ui.money).toHaveValue("6.00");
  await expect(ui.confirm).toBeEnabled();
  await page.route("**/__pickup_state/query/order.get", async (route) => {
    await respond(route, order(ORDER_A, [garment(GARMENT_A, "picked_up")]));
  });
  await load(page);
  await expect(ui.money).toBeDisabled();
  await expect(ui.confirm).toBeDisabled();
  expect(ui.commands).toEqual([]);
});

test("ambiguous, malformed, failed, and empty lookup results invalidate the previous draft", async ({
  page,
}) => {
  const ui = await mount(page, {
    lookup: async (route) => {
      const { key } = route.request().postDataJSON() as { key: string };
      if (key === "ambiguous") await respond(route, { orders: [order(), order(ORDER_B)] });
      else if (key === "malformed") await respond(route, { invalid: true });
      else if (key === "failed")
        await route.fulfill({ json: { ok: false, error: { code: "UNAVAILABLE" } } });
      else await respond(route, { orders: [] });
    },
  });
  for (const key of ["ambiguous", "malformed", "failed", "empty"]) {
    await load(page);
    await ui.money.fill("16.00");
    await ui.scan.fill(key);
    await ui.scan.press("Enter");
    await expect(page.getByRole("button", { name: "加载订单", exact: true })).toBeEnabled();
    await expect(ui.loaded).toHaveCount(0);
    await expect(ui.money).toBeDisabled();
    await expect(ui.confirm).toBeDisabled();
    if (key === "ambiguous") {
      await page
        .getByTestId("pickup-lookup-candidates")
        .getByRole("button", { name: /PICKUP-2/u })
        .click();
      await expect(ui.loaded).toHaveText("PICKUP-2");
      await expect(ui.money).toHaveValue("0.00");
    }
  }
  expect(ui.commands).toEqual([]);
});

test("editing the scan invalidates a delayed detail response even without another lookup", async ({
  page,
}) => {
  const requested = deferred();
  const release = deferred();
  const ui = await mount(page, {
    get: async (route) => {
      requested.resolve();
      await release.promise;
      await respond(route, order());
    },
  });
  try {
    await ui.scan.fill(ORDER_A);
    await ui.scan.press("Enter");
    await requested.promise;
    await ui.scan.fill("NEW-SCAN");
    const response = page.waitForResponse("**/__pickup_state/query/order.get");
    release.resolve();
    await (await response).finished();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(ui.scan).toHaveValue("NEW-SCAN");
    await expect(ui.loaded).toHaveCount(0);
    await expect(ui.money).toBeDisabled();
    await expect(ui.confirm).toBeDisabled();
    expect(ui.commands).toEqual([]);
  } finally {
    release.resolve();
  }
});

test("a failed pickup preserves verified selection and collection for an exact retry", async ({
  page,
}) => {
  let failed = false;
  const ui = await mount(page, {
    orders: [order(ORDER_A, [garment(GARMENT_A, "racked")])],
    command: async (route) => {
      if (!failed) {
        failed = true;
        await route.fulfill({
          json: { ok: false, error: { code: "UNAVAILABLE", message: "请重试当前取衣" } },
        });
      } else await respond(route, settled(route.request().postDataJSON() as PickupBody));
    },
  });
  await load(page);
  await ui.money.fill("16.00");
  await expect(ui.confirm).toBeDisabled();
  await page.locator('input[name="pickup-verification-barcode"]').fill("PICKUP-1");
  await page.locator('input[name="pickup-verification-barcode"]').press("Enter");
  await expect(ui.confirm).toBeEnabled();
  await ui.confirm.click();
  await expect(page.getByText("请重试当前取衣", { exact: true })).toBeVisible();
  await expect(ui.money).toHaveValue("16.00");
  await expect(page.getByTestId(`pickup-garment-${GARMENT_A}`)).toBeChecked();
  await expect(ui.confirm).toBeEnabled();
  await ui.confirm.click();
  await expect(page.getByTestId("pickup-ticket")).toBeVisible();
  expect(ui.commands).toHaveLength(2);
  expect(ui.commands[1]).toEqual(ui.commands[0]);
  expect(ui.commands[0]?.verification_barcodes).toEqual(["PICKUP-1"]);
});

test("two immediate clicks issue one command and keep lookup locked until it settles", async ({
  page,
}) => {
  const requested = deferred();
  const release = deferred();
  const ui = await mount(page, {
    command: async (route) => {
      requested.resolve();
      await release.promise;
      await respond(route, settled(route.request().postDataJSON() as PickupBody));
    },
  });
  try {
    await load(page);
    await ui.money.fill("16.00");
    await ui.confirm.evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
    await requested.promise;
    await expect(ui.scan).toBeDisabled();
    await expect(ui.money).toBeDisabled();
    await expect(page.getByRole("button", { name: "提交中…", exact: true })).toBeDisabled();
    release.resolve();
    await expect(page.getByTestId("pickup-ticket")).toBeVisible();
    expect(ui.commands).toHaveLength(1);
  } finally {
    release.resolve();
  }
});

for (const outcome of ["failed", "succeeded", "unmounted"] as const) {
  test(`QR payment during pickup ${outcome} clears cash and only refreshes a still-active failed order`, async ({
    page,
  }) => {
    const requested = deferred();
    const release = deferred();
    let paid = false;
    let gets = 0;
    const intent = {
      intent_id: "cccccccc-cccc-4ccc-8ccc-ccccccccccc1",
      order_id: ORDER_A,
      purpose: "order",
      channel: "wechat",
      amount_cents: 1600,
      state: "pending",
      qr_url: null,
      payment_id: null,
      error_code: null,
      created_at: "2026-10-08T00:00:00.000Z",
      expires_at: "2099-10-08T00:00:00.000Z",
    };
    await page.clock.install();
    await page.route("**/__pickup_state/channel/*", async (route) => {
      const name = new URL(route.request().url()).pathname.split("/").at(-1);
      const data =
        name === "available"
          ? { channels: [{ channel: "wechat", enabled: true }], can_manage: false }
          : name === "list"
            ? { intents: paid ? [] : [intent] }
            : { ...intent, state: "paid", payment_id: "dddddddd-dddd-4ddd-8ddd-ddddddddddd1" };
      if (name === "status") paid = true;
      await route.fulfill({ json: { ok: true, data } });
    });
    const ui = await mount(page, {
      channels: true,
      get: async (route) => {
        gets += 1;
        await respond(route, {
          ...order(),
          paid_cents: paid ? 1600 : 0,
          balance_cents: paid ? 1600 : 3200,
        });
      },
      command: async (route) => {
        requested.resolve();
        await release.promise;
        if (outcome === "succeeded") {
          await respond(route, {
            ...settled(route.request().postDataJSON() as PickupBody),
            paid_cents: 3200,
            balance_cents: 0,
          });
        } else
          await route.fulfill({
            json: {
              ok: false,
              error: { code: "CONSTRAINT_VIOLATION", message: "付款已更新，请核对余额" },
            },
          });
      },
    });
    try {
      await load(page);
      await expect(page.getByRole("status").filter({ hasText: "等待顾客付款" })).toBeVisible();
      await ui.money.fill("16.00");
      await ui.confirm.click();
      await requested.promise;
      await page.clock.fastForward(3000);
      await expect(page.getByText("已收到微信付款", { exact: true })).toBeVisible();
      await expect(ui.money).toHaveValue("0.00");
      expect(gets).toBe(1);
      if (outcome === "unmounted") {
        await page.getByRole("button", { name: "卸载测试页面", exact: true }).click();
      }
      const response = page.waitForResponse("**/__pickup_state/command/order.pickup");
      release.resolve();
      await (await response).finished();
      if (outcome === "failed") {
        await expect(page.getByTestId("pickup-loaded-balance")).toHaveText("¥16.00");
        await expect(ui.money).toHaveValue("0.00");
        await expect(ui.confirm).toBeEnabled();
        expect(gets).toBe(2);
      } else if (outcome === "succeeded") {
        await expect(page.getByTestId("pickup-ticket")).toBeVisible();
        await expect(ui.loaded).toHaveCount(0);
        await expect(ui.confirm).toBeDisabled();
        expect(gets).toBe(1);
      } else {
        await page.clock.runFor(1);
        await expect(page.locator("main")).toHaveCount(0);
        expect(gets).toBe(1);
      }
      expect(ui.commands).toHaveLength(1);
    } finally {
      release.resolve();
    }
  });
}
