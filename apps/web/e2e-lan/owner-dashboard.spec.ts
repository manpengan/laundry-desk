import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { connect } from "node:net";
import { requirePrivateLanHttpsOrigin } from "../src/host/lan-origin.js";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0 || value.trim() !== value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function requiredPasswordEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

const LAN_ORIGIN = requirePrivateLanHttpsOrigin(requiredEnvironment("LAUNDRY_LAN_ORIGIN"));
const LOGIN = Object.freeze({
  orgCode: requiredEnvironment("LAUNDRY_LOCAL_ORG_CODE"),
  storeCode: requiredEnvironment("LAUNDRY_LOCAL_STORE_CODE"),
  username: requiredEnvironment("LAUNDRY_BOOTSTRAP_ADMIN_USERNAME"),
  password: requiredPasswordEnvironment("LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD"),
});
const LOOPBACK_SERVICE_URLS = Object.freeze([
  "http://127.0.0.1:8787/health",
  "http://127.0.0.1:8543/",
]);
const REFRESH_COOKIE_NAME = "__Host-laundry_refresh";
const CSRF_COOKIE_NAME = "__Host-laundry_csrf";
const CREDENTIAL_STORAGE_PATTERN = /access.?token|refresh.?token|authorization/iu;

type BrowserCookies = Awaited<ReturnType<BrowserContext["cookies"]>>;
type CookieSecurityMetadata = Readonly<
  Pick<BrowserCookies[number], "name" | "secure" | "httpOnly" | "sameSite" | "path">
>;
type StorageSnapshot = Readonly<{
  local: Readonly<Record<string, string>>;
  session: Readonly<Record<string, string>>;
}>;

function cookieSecurityMetadata(
  cookies: BrowserCookies,
  name: string,
): CookieSecurityMetadata | null {
  const cookie = cookies.find((candidate) => candidate.name === name);
  if (cookie === undefined) return null;
  return Object.freeze({
    name: cookie.name,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    path: cookie.path,
  });
}

function haveIndependentSessionCookies(first: BrowserCookies, second: BrowserCookies): boolean {
  return [REFRESH_COOKIE_NAME, CSRF_COOKIE_NAME].every((name) => {
    const firstValue = first.find((cookie) => cookie.name === name)?.value;
    const secondValue = second.find((cookie) => cookie.name === name)?.value;
    return (
      firstValue !== undefined &&
      firstValue.length > 0 &&
      secondValue !== undefined &&
      secondValue.length > 0 &&
      firstValue !== secondValue
    );
  });
}

function containsStoredCredentials(storage: StorageSnapshot): boolean {
  return [storage.local, storage.session].some((entries) =>
    Object.entries(entries).some(([key, value]) =>
      CREDENTIAL_STORAGE_PATTERN.test(`${key}\u0000${value}`),
    ),
  );
}

function hasCookie(cookies: BrowserCookies, name: string): boolean {
  return cookies.some((cookie) => cookie.name === name);
}

async function tcpConnects(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    let settled = false;
    const finish = (connected: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(connected);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(1_000, () => finish(false));
  });
}

async function loginOwner(page: Page): Promise<void> {
  await page.goto("/owner");
  await expect(page.locator('[data-page="login"]')).toBeVisible();
  await page.locator('input[name="org_code"]').fill(LOGIN.orgCode);
  await page.locator('input[name="store_code"]').fill(LOGIN.storeCode);
  await page.locator('input[name="username"]').fill(LOGIN.username);
  await page.locator('input[name="password"]').fill(LOGIN.password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.locator('[data-shell="owner"]')).toHaveAttribute(
    "data-owner-access",
    "allowed",
    { timeout: 15_000 },
  );
  await expect(page.locator('[data-testid="owner-dashboard"]')).toHaveAttribute(
    "data-state",
    "ready",
    { timeout: 15_000 },
  );
}

function waitForOwnerQuery(page: Page, queryName: string) {
  return page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "POST" && url.pathname === `/v1/queries/${queryName}`;
  });
}

test("LAN acceptance refuses non-HTTPS and non-private origins", () => {
  for (const origin of [
    "http://192.168.50.12:8443",
    "https://127.0.0.1:8443",
    "https://198.18.0.1:8443",
    "https://8.8.8.8:8443",
  ]) {
    expect(() => requirePrivateLanHttpsOrigin(origin)).toThrow(
      "LAUNDRY_LAN_ORIGIN must be an exact private HTTPS origin",
    );
  }
});

test("Fastify and PostgreSQL remain closed on the selected LAN address", async () => {
  const host = new URL(LAN_ORIGIN).hostname;
  expect(await Promise.all([tcpConnects(host, 8787), tcpConnects(host, 8543)])).toEqual([
    false,
    false,
  ]);
});

test("two isolated browser devices read the HTTPS Owner Dashboard without mutation traffic", async ({
  browser,
  context,
  page,
}) => {
  const commandRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/v1/commands/")) commandRequests.push(request.url());
  });
  const portfolioResponse = waitForOwnerQuery(page, "reporting.owner_portfolio.get");
  await loginOwner(page);
  const portfolioResult = await portfolioResponse;
  expect(portfolioResult.status()).toBe(200);
  expect(portfolioResult.headers()["cache-control"]).toBe("no-store");

  const directLoopbackRequests: string[] = [];
  page.on("request", (request) => {
    if (LOOPBACK_SERVICE_URLS.includes(request.url())) directLoopbackRequests.push(request.url());
  });
  const directLoopbackResults = await page.evaluate(async (urls) => {
    return await Promise.all(
      urls.map(async (url) => {
        try {
          await fetch(url);
          return "connected";
        } catch {
          return "blocked";
        }
      }),
    );
  }, LOOPBACK_SERVICE_URLS);
  expect(directLoopbackResults).toEqual(["blocked", "blocked"]);
  expect(directLoopbackRequests).toEqual([]);

  const dashboard = page.locator('[data-testid="owner-dashboard"]');
  for (const label of ["今日营业额", "今日取衣件数", "新增欠款", "滞留件"]) {
    await expect(dashboard.getByText(label, { exact: true })).toBeVisible();
  }
  await expect(page.locator('[data-testid="owner-trend-row"]')).toHaveCount(7);
  await page.getByRole("button", { name: "近 30 日" }).click();
  await expect(page.locator('[data-testid="owner-trend-row"]')).toHaveCount(30);
  await page.getByRole("button", { name: "刷新经营数据" }).click();
  await expect(page.locator('[data-testid="owner-dashboard"]')).toHaveAttribute(
    "data-state",
    "ready",
  );
  await expect(page.locator('[data-testid="owner-portfolio"]')).toBeVisible();
  await expect(page.getByText("授权门店对比", { exact: true })).toBeVisible();
  await expect(page.locator('[data-testid="owner-portfolio"] [role="alert"]')).toHaveCount(0);
  await expect(page.getByLabel("授权门店总计")).toBeVisible();

  for (const [button, title] of [
    ["查看取衣明细", "今日取衣明细"],
    ["查看欠款明细", "今日新增欠款明细"],
    ["查看滞留明细", "滞留件明细"],
  ] as const) {
    const drilldownResponse = waitForOwnerQuery(page, "reporting.owner_dashboard.drilldown");
    await page.getByRole("button", { name: button }).click();
    const drilldownResult = await drilldownResponse;
    expect(drilldownResult.status()).toBe(200);
    expect(drilldownResult.headers()["cache-control"]).toBe("no-store");
    await expect(page.locator('[data-testid="owner-drilldown"]')).toBeVisible();
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
    await expect(page.locator('[data-testid="owner-drilldown"] [role="alert"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="owner-drilldown"]')).toContainText(
      /共 \d+ 单|暂无明细/u,
    );
    await page.getByRole("button", { name: "关闭明细" }).click();
    await expect(page.locator('[data-testid="owner-drilldown"]')).toHaveCount(0);
  }

  const cookies = await context.cookies();
  expect(cookieSecurityMetadata(cookies, REFRESH_COOKIE_NAME)).toEqual({
    name: REFRESH_COOKIE_NAME,
    secure: true,
    httpOnly: true,
    sameSite: "Strict",
    path: "/",
  });
  expect(cookieSecurityMetadata(cookies, CSRF_COOKIE_NAME)).toEqual({
    name: CSRF_COOKIE_NAME,
    secure: true,
    httpOnly: false,
    sameSite: "Strict",
    path: "/",
  });
  const storage: StorageSnapshot = await page.evaluate(() => ({
    local: Object.fromEntries(Object.entries(localStorage)),
    session: Object.fromEntries(Object.entries(sessionStorage)),
  }));
  expect(containsStoredCredentials(storage)).toBe(false);

  const secondContext = await browser.newContext({ baseURL: LAN_ORIGIN });
  const secondPage = await secondContext.newPage();
  secondPage.on("request", (request) => {
    if (request.url().includes("/v1/commands/")) commandRequests.push(request.url());
  });
  try {
    await loginOwner(secondPage);
    await expect(secondPage.getByText("只读经营看板", { exact: true })).toBeVisible();
    const secondCookies = await secondContext.cookies();
    expect(haveIndependentSessionCookies(cookies, secondCookies)).toBe(true);

    const logoutResponse = secondPage.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/v2/auth/logout",
    );
    await secondPage.getByRole("button", { name: "退出登录" }).click();
    expect((await logoutResponse).status()).toBe(200);
    await expect(secondPage.locator('[data-page="login"]')).toBeVisible();
    await secondPage.reload();
    await expect(secondPage.locator('[data-page="login"]')).toBeVisible();
    expect(hasCookie(await secondContext.cookies(), REFRESH_COOKIE_NAME)).toBe(false);
  } finally {
    await secondContext.close();
  }

  expect(commandRequests).toEqual([]);
});
