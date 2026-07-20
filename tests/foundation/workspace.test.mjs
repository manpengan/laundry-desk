import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const rootUrl = new URL("../../", import.meta.url);
const workspaceNames = [
  "apps/server",
  "apps/web",
  "apps/edge-agent",
  "packages/contracts",
  "packages/domain",
  "packages/ui",
  "packages/config",
];
const libraryNames = ["packages/contracts", "packages/domain", "packages/ui"];

async function readJson(path) {
  const contents = await readFile(new URL(path, rootUrl), "utf8");
  return JSON.parse(contents);
}

test("declares pnpm workspaces and Turborepo at the repository root", async () => {
  const rootPackage = await readJson("package.json");
  const foundationWorkflow = await readFile(
    new URL(".github/workflows/foundation.yml", rootUrl),
    "utf8",
  );
  const gitignore = await readFile(new URL(".gitignore", rootUrl), "utf8");
  const workspaceConfig = await readFile(new URL("pnpm-workspace.yaml", rootUrl), "utf8");
  const turboConfig = await readJson("turbo.json");

  assert.equal(rootPackage.private, true);
  assert.match(rootPackage.packageManager, /^pnpm@\d+\.\d+\.\d+$/);
  assert.equal(rootPackage.devDependencies["@typescript-eslint/eslint-plugin"], "^7.5.0");
  assert.equal(rootPackage.devDependencies["@typescript-eslint/parser"], "^7.5.0");
  assert.equal(rootPackage.devDependencies.vitest, "^3.2.6");
  assert.deepEqual(rootPackage.workspaces, ["apps/*", "packages/*"]);
  assert.match(
    rootPackage.scripts["workspace:format:check"],
    /\.github\/workflows\/foundation\.yml/,
  );
  assert.match(workspaceConfig, /- "apps\/\*"/);
  assert.match(workspaceConfig, /- "packages\/\*"/);
  assert.match(workspaceConfig, /allowBuilds:\n  better-sqlite3: true/);
  assert.match(gitignore, /^\.turbo\/$/m);
  assert.match(foundationWorkflow, /node-version: 22/);
  assert.match(foundationWorkflow, /uses: actions\/checkout@v7/);
  assert.match(foundationWorkflow, /uses: actions\/setup-node@v7/);
  assert.match(foundationWorkflow, /uses: pnpm\/action-setup@v6/);
  assert.match(foundationWorkflow, /version: 11\.15\.0/);
  assert.deepEqual(turboConfig.tasks.build.dependsOn, ["^build"]);
  assert.deepEqual(turboConfig.tasks.build.outputs, ["dist/**"]);
  assert.equal(turboConfig.tasks.dev.cache, false);
  assert.equal(turboConfig.tasks.dev.persistent, true);
});

test("provides compileable shells for every assigned workspace", async () => {
  for (const workspaceName of workspaceNames) {
    const workspacePackage = await readJson(`${workspaceName}/package.json`);
    const tsconfig = await readJson(`${workspaceName}/tsconfig.json`);

    assert.equal(workspacePackage.private, true, `${workspaceName} must be private`);
    assert.deepEqual(
      Object.keys(workspacePackage.scripts).sort(),
      ["build", "dev", "lint", "test", "typecheck"],
      `${workspaceName} scripts must share the foundation contract`,
    );
    assert.equal(tsconfig.compilerOptions.rootDir, "src");
    assert.equal(tsconfig.compilerOptions.outDir, "dist");
    await readFile(new URL(`${workspaceName}/src/index.ts`, rootUrl), "utf8");
  }
});

test("publishes shared TypeScript, ESLint, and Prettier configuration", async () => {
  const configPackage = await readJson("packages/config/package.json");

  assert.deepEqual(configPackage.exports, {
    "./eslint": "./eslint/base.cjs",
    "./prettier": "./prettier/index.cjs",
    "./tsconfig/base": "./tsconfig/base.json",
    "./tsconfig/node": "./tsconfig/node.json",
    "./tsconfig/web": "./tsconfig/web.json",
  });
  await readFile(new URL("packages/config/eslint/base.cjs", rootUrl), "utf8");
  await readFile(new URL("packages/config/prettier/index.cjs", rootUrl), "utf8");
  await readFile(new URL("packages/config/tsconfig/base.json", rootUrl), "utf8");
  await readFile(new URL("packages/config/tsconfig/node.json", rootUrl), "utf8");
  await readFile(new URL("packages/config/tsconfig/web.json", rootUrl), "utf8");
});

test("exposes stable entry points for reusable libraries", async () => {
  for (const libraryName of libraryNames) {
    const libraryPackage = await readJson(`${libraryName}/package.json`);

    assert.deepEqual(libraryPackage.exports, {
      ".": {
        types: "./dist/index.d.ts",
        default: "./dist/index.js",
      },
    });
    assert.deepEqual(libraryPackage.files, ["dist"]);
  }
});
