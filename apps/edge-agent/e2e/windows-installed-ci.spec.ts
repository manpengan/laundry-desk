import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { createLocalApp } from "../../server/dist/http/create-app.js";
import { resolveCookiePolicy } from "../../server/dist/http/cookie-policy.js";
import { createMemoryLocalRuntime, DEMO_PASSWORD } from "../../server/dist/local/demo-seed.js";
import { fillWindowsCredential } from "./windows-credentials.mjs";

// Installed EXE/IPC/UI gate with an isolated in-memory synthetic service.
// Native PostgreSQL, restore and OS lifecycle are separate Runtime/physical-host gates.
test("installed Counter logs in, creates a synthetic order and retains recovery across restart", async () => {
  expect(process.platform).toBe("win32");
  const executable = process.env.LAUNDRY_WINDOWS_INSTALLED_EXE;
  if (!executable || !isAbsolute(executable)) throw new Error("INSTALLED_COUNTER_REQUIRED");
  const runtime = await createMemoryLocalRuntime();
  const server = await createLocalApp({
    runtime,
    cookiePolicy: resolveCookiePolicy({ secure: false }),
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
      await page.locator('input[name="org_code"]').fill("local");
      await page.locator('input[name="store_code"]').fill("main");
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
    await closeApplication();
    page = await launch(false);
    await page.locator('[data-nav-id="receive"]').click();
    await expect(page.locator('[data-testid="receive-ticket"]')).toHaveText(ticket);
    await expect(page.getByText("已恢复原开单并核对最新金额。")).toBeVisible();
  } finally {
    await closeApplication();
    await server.close();
    await rm(userData, { recursive: true, force: true });
  }
});
