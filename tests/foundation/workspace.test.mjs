import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
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

async function collectSourceFiles(directory) {
  const entries = await readdir(new URL(directory, rootUrl), { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const relativePath = `${directory}${entry.name}`;
      if (entry.isDirectory()) return collectSourceFiles(`${relativePath}/`);
      return /\.(?:[cm]?[jt]s|tsx)$/u.test(entry.name) ? [relativePath] : [];
    }),
  );
  return nested.flat();
}

function isRestrictedContractsImportAllowed(path, subpath) {
  if (subpath === "@laundry/contracts/browser-auth-ingress") {
    return path.startsWith("apps/server/src/auth/");
  }
  if (subpath === "@laundry/contracts/edge-auth-ingress") {
    return path.startsWith("apps/server/src/edge-ingress/");
  }
  return false;
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

test("builds file-linked workspace dependencies before their consumers test", async () => {
  const turboConfig = await readJson("turbo.json");
  const webPackage = await readJson("apps/web/package.json");
  const uiPackage = await readJson("packages/ui/package.json");

  assert.deepEqual(turboConfig.tasks[`${webPackage.name}#test`]?.dependsOn, [
    "^build",
    `${uiPackage.name}#build`,
  ]);
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
  const baseExport = {
    ".": {
      types: "./dist/index.d.ts",
      default: "./dist/index.js",
    },
  };

  for (const libraryName of libraryNames) {
    const libraryPackage = await readJson(`${libraryName}/package.json`);

    if (libraryName === "packages/ui") {
      // Types point at source so dependents typecheck without a prior ui build (CI).
      // CSS tokens/components ship as package subpath exports (not compiled into dist).
      assert.deepEqual(libraryPackage.exports, {
        ".": {
          types: "./src/index.ts",
          default: "./dist/index.js",
        },
        "./styles.css": "./src/styles/tokens.css",
        "./styles/components.css": "./src/styles/components.css",
      });
      assert.deepEqual(libraryPackage.files, ["dist", "src/styles"]);
      continue;
    }

    if (libraryName === "packages/contracts") {
      assert.deepEqual(libraryPackage.exports, {
        ...baseExport,
        "./browser-auth-ingress": {
          types: "./dist/auth/browser-ingress.d.ts",
          default: "./dist/auth/browser-ingress.js",
        },
        "./edge-auth-ingress": {
          types: "./dist/auth/edge-ingress.d.ts",
          default: "./dist/auth/edge-ingress.js",
        },
      });
      await readFile(new URL("packages/contracts/src/auth/browser-ingress.ts", rootUrl), "utf8");
      await readFile(new URL("packages/contracts/src/auth/edge-ingress.ts", rootUrl), "utf8");
      const rootIndex = await readFile(new URL("packages/contracts/src/index.ts", rootUrl), "utf8");
      assert.doesNotMatch(
        rootIndex,
        /issueBrowserSessionSource|issueEdgeReplaySource/u,
        "root export must not expose restricted auth issue factories",
      );
    } else {
      assert.deepEqual(libraryPackage.exports, baseExport);
    }
    assert.deepEqual(libraryPackage.files, ["dist"]);
  }
});

test("restricts auth authority subpath imports to their server ingress owners", async () => {
  const restrictedSubpaths = [
    "@laundry/contracts/browser-auth-ingress",
    "@laundry/contracts/edge-auth-ingress",
  ];
  const sourceFiles = [
    ...(await collectSourceFiles("apps/")),
    ...(await collectSourceFiles("packages/")),
  ];

  assert.equal(
    isRestrictedContractsImportAllowed("apps/server/src/auth/session.ts", restrictedSubpaths[0]),
    true,
  );
  assert.equal(
    isRestrictedContractsImportAllowed(
      "apps/server/src/edge-ingress/replay.ts",
      restrictedSubpaths[1],
    ),
    true,
  );
  assert.equal(
    isRestrictedContractsImportAllowed("apps/web/src/auth.ts", restrictedSubpaths[0]),
    false,
  );
  assert.equal(
    isRestrictedContractsImportAllowed("apps/server/src/auth/replay.ts", restrictedSubpaths[1]),
    false,
  );

  for (const path of sourceFiles) {
    const contents = await readFile(new URL(path, rootUrl), "utf8");
    for (const subpath of restrictedSubpaths) {
      if (contents.includes(subpath)) {
        assert.equal(
          isRestrictedContractsImportAllowed(path, subpath),
          true,
          `${path} must not import restricted authority ${subpath}`,
        );
      }
    }
  }
});
