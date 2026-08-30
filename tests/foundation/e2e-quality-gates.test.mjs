import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const rootUrl = new URL("../../", import.meta.url);

async function readRepositoryFile(path) {
  return readFile(new URL(path, rootUrl), "utf8");
}

test("keeps browser and Electron acceptance sources inside canonical quality gates", async () => {
  const edgePackage = JSON.parse(await readRepositoryFile("apps/edge-agent/package.json"));
  const webPackage = JSON.parse(await readRepositoryFile("apps/web/package.json"));
  const edgeE2eConfig = JSON.parse(await readRepositoryFile("apps/edge-agent/tsconfig.e2e.json"));
  const webE2eConfig = JSON.parse(await readRepositoryFile("apps/web/tsconfig.e2e.json"));

  assert.equal(edgePackage.scripts.lint, "eslint . --ext .ts,.tsx,.mjs --max-warnings=0");
  assert.match(edgePackage.scripts.typecheck, /tsconfig\.e2e\.json/u);
  assert.deepEqual(edgeE2eConfig.include, [
    "e2e/**/*.ts",
    "playwright.electron.commissioning.config.ts",
    "playwright.electron.package.config.ts",
    "playwright.electron.windows-functional.config.ts",
    "playwright.electron.windows-package.config.ts",
    "playwright.electron.windows-runtime.config.ts",
    "playwright.electron.config.ts",
  ]);
  assert.equal(webPackage.scripts.lint, "eslint . --ext .ts,.tsx,.mjs --max-warnings=0");
  assert.match(webPackage.scripts.typecheck, /tsconfig\.e2e\.json/u);
  assert.deepEqual(webE2eConfig.include, [
    "e2e/**/*.ts",
    "e2e-commissioning/**/*.ts",
    "e2e-lan/**/*.ts",
    "playwright.cloud.config.ts",
    "playwright.commissioning.config.ts",
    "playwright.local.config.ts",
    "playwright.lan.config.ts",
  ]);
});
