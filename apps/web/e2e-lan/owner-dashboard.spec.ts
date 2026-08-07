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
  await loginOwner(page);

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

  for (const label of ["今日营业额", "今日取衣件数", "新增欠款", "滞留件"]) {
    await expect(page.getByText(label, { exact: true })).toBeVisible();
  }
  await expect(page.locator('[data-testid="owner-trend-row"]')).toHaveCount(7);
  await page.getByRole("button", { name: "近 30 日" }).click();
  await expect(page.locator('[data-testid="owner-trend-row"]')).toHaveCount(30);
  await page.getByRole("button", { name: "刷新经营数据" }).click();
  await expect(page.locator('[data-testid="owner-dashboard"]')).toHaveAttribute(
    "data-state",
    "ready",
  );

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
