import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { AccessSessionResponseSchema, CSRF_HEADER_NAME } from "@laundry/contracts";
import { createLocalApp } from "../../server/dist/http/create-app.js";
import { resolveCookiePolicy } from "../../server/dist/http/cookie-policy.js";
import {
  createMemoryLocalRuntime,
  DEMO_ORG_ID,
  DEMO_PASSWORD,
  DEMO_STORE_ID,
} from "../../server/dist/local/demo-seed.js";
import { fillWindowsCredential } from "./windows-credentials.mjs";

// Installed EXE/IPC/UI gate with an isolated in-memory synthetic service.
// Native PostgreSQL, restore and OS lifecycle are separate Runtime/physical-host gates.
test("installed Counter logs in, creates a synthetic order and retains recovery across restart", async () => {
  expect(process.platform).toBe("win32");
  const executable = process.env.LAUNDRY_WINDOWS_INSTALLED_EXE;
  if (!executable || !isAbsolute(executable)) throw new Error("INSTALLED_COUNTER_REQUIRED");
  const runtime = await createMemoryLocalRuntime();
  const cookiePolicy = resolveCookiePolicy({ secure: false });
  const server = await createLocalApp({
    runtime,
    cookiePolicy,
    logger: false,
  });
  const userData = await mkdtemp(join(await realpath(tmpdir()), "counter-ci-private-"));
  const env = Object.fromEntries(
    [
      "PATH",
      "SystemRoot",
      "WINDIR",
      "TEMP",
      "TMP",
      "USERPROFILE",
      "LOCALAPPDATA",
      "APPDATA",
    ].flatMap((key) => (process.env[key] ? [[key, process.env[key]!]] : [])),
  );
  let application: ElectronApplication | null = null;
  const closeApplication = async () => {
    await application?.close();
    application = null;
  };
  const launch = async (firstLogin: boolean) => {
    application = await electron.launch({
      executablePath: executable,
      args: [`--user-data-dir=${userData}`],
      env,
    });
    const page = await application.firstWindow();
    if (firstLogin) {
      await expect(page.locator('[data-page="login"]')).toBeVisible({ timeout: 30_000 });
      await expect(page.locator('input[name="org_code"], input[name="store_code"]')).toHaveCount(0);
      await fillWindowsCredential(page.locator('input[name="username"]'), "admin");
      await fillWindowsCredential(page.locator('input[name="password"]'), DEMO_PASSWORD);
      await page.getByRole("button", { name: "登录", exact: true }).click();
    }
    await expect(page.locator('[data-shell="counter"]')).toBeVisible({ timeout: 30_000 });
    return page;
  };
  try {
    await server.listen({ host: "127.0.0.1", port: 8787 });
    let page = await launch(true);
    await page.locator('[data-nav-id="receive"]').click();
    await page.getByRole("option", { name: /水洗衬衫/u }).click();
    await page.locator('input[name="customer-phone"]').fill("13800000981");
    await page.locator('input[name="customer-name"]').fill("CI合成测试");
    await page.locator('input[name="initial-payment"]').fill("0");
    await page.getByRole("button", { name: /确认开单/u }).click();
    const receipt = page.locator('[data-testid="receive-ticket"]');
    await expect(receipt).toBeVisible();
    const ticket = await receipt.innerText();
    const garments = await page.locator(".ld-order-result__garment").allTextContents();
    expect(garments).toHaveLength(1);
    await closeApplication();
    const orders = await runtime.order.store.listOrders?.(DEMO_ORG_ID, DEMO_STORE_ID);
    const matches = orders?.filter((order) => order.ticket_no === ticket) ?? [];
    expect(matches).toHaveLength(1);
    const orderId = matches[0]!.order_id;
    const headers = {
      host: "127.0.0.1:8787",
      origin: "http://127.0.0.1:5173",
      "sec-fetch-site": "same-site",
    };
    const login = await server.inject({
      method: "POST",
      url: "/api/v2/auth/login",
      headers,
      payload: {
        org_code: "local",
        store_code: "main",
        username: "admin",
        password: DEMO_PASSWORD,
        device_id: randomUUID(),
      },
    });
    expect(login.statusCode).toBe(200);
    const access = AccessSessionResponseSchema.parse(login.json<{ data: unknown }>().data);
    const setCookie = login.headers["set-cookie"];
    const cookies = (Array.isArray(setCookie) ? setCookie : [setCookie ?? ""])
      .map((value) => value.split(";")[0]!)
      .filter(Boolean);
    const csrf = cookies.find((value) => value.startsWith(`${cookiePolicy.csrfName}=`));
    expect(csrf).toBeDefined();
    const repayment = await server.inject({
      method: "POST",
      url: "/v1/commands/payment.repay",
      headers: {
        ...headers,
        authorization: `Bearer ${access.access_token}`,
        cookie: cookies.join("; "),
        [CSRF_HEADER_NAME]: csrf!.slice(cookiePolicy.csrfName.length + 1),
        "idempotency-key": randomUUID(),
      },
      payload: { order_id: orderId, amount_cents: 500, method: "cash" },
    });
    expect(repayment.statusCode).toBe(200);
    expect(await runtime.order.store.getOrder(DEMO_ORG_ID, DEMO_STORE_ID, orderId)).toMatchObject({
      payable_cents: 1500,
      paid_cents: 500,
      balance_cents: 1000,
    });
    page = await launch(false);
    await page.locator('[data-nav-id="receive"]').click();
    await expect(page.locator('[data-testid="receive-ticket"]')).toHaveText(ticket);
    await expect(page.getByRole("heading", { name: "开单已完成", exact: true })).toBeVisible();
    await expect(page.locator(".ld-order-result__garment")).toHaveText(garments);
    for (const [label, amount] of [
      ["应付", "¥15.00"],
      ["已付", "¥5.00"],
      ["欠款", "¥10.00"],
    ] as const) {
      const field = page.locator(".ld-order-result__meta > div").filter({
        has: page.getByText(label, { exact: true }),
      });
      await expect(field.locator("dd")).toHaveText(amount);
    }
  } finally {
    await closeApplication();
    await server.close();
    await rm(userData, { recursive: true, force: true });
  }
});
