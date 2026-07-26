import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";

const webRoot = new URL("../../", import.meta.url);

async function readWebFile(path: string): Promise<string> {
  return readFile(new URL(path, webRoot), "utf8");
}

test("production build emits a real SPA with only relative asset URLs", async () => {
  const indexUrl = new URL("dist-spa/index.html", webRoot);
  const indexHtml = await readFile(indexUrl, "utf8");
  const assetUrls = [...indexHtml.matchAll(/(?:src|href)="([^"]+)"/gu)].map((match) => match[1]);

  assert.ok(assetUrls.length >= 2, "expected the bundled JavaScript and CSS assets");
  for (const assetUrl of assetUrls) {
    assert.ok(assetUrl !== undefined);
    assert.match(assetUrl, /^\.\/assets\/[^?#]+$/u);
    assert.equal((await stat(new URL(assetUrl, indexUrl))).isFile(), true);
  }
  assert.doesNotMatch(indexHtml, /\/host\/main\.tsx|(?:src|href)="\//u);
});

test("local Playwright owns the fixed Vite lifecycle", async () => {
  const config = await readWebFile("playwright.local.config.ts");

  assert.match(config, /webServer\s*:\s*\{/u);
  assert.match(
    config,
    /command:\s*"pnpm --filter @laundry\/web exec vite --config vite\.config\.ts"/u,
  );
  assert.match(config, /url:\s*LOCAL_WEB_URL/u);
  assert.match(config, /reuseExistingServer:\s*false/u);
});

test("login smoke proves blank fields and loads credentials before navigation", async () => {
  const smoke = await readWebFile("e2e/local-login.spec.ts");
  const navigationOffset = smoke.indexOf("page.goto");
  const credentialsOffset = smoke.indexOf("const LOGIN");

  assert.ok(credentialsOffset >= 0 && credentialsOffset < navigationOffset);
  for (const field of ["org_code", "store_code", "username", "password"]) {
    assert.match(
      smoke,
      new RegExp(`input\\[name=["']${field}["']\\][\\s\\S]*?toHaveValue\\(["']["']\\)`, "u"),
    );
  }
});

test("desktop host disables dynamic Liquid Glass styles under the app CSP", async () => {
  const hostEntry = await readWebFile("host/main.tsx");

  assert.match(hostEntry, /enableLiquidGlass=\{host\.kind === "browser"\}/u);
  assert.doesNotMatch(hostEntry, /\benableLiquidGlass\s*\/>/u);
});
