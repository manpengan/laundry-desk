import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { posix as posixPath } from "node:path";
import test from "node:test";
import ts from "typescript";

const rootUrl = new URL("../../", import.meta.url);
const workspaceNames = [
  "apps/server",
  "apps/web",
  "apps/edge-agent",
  "packages/contracts",
  "packages/domain",
  "packages/db",
  "packages/ui",
  "packages/config",
];
const libraryNames = ["packages/contracts", "packages/domain", "packages/db", "packages/ui"];
const generatedSourceDirectories = new Set(["dist", "node_modules", ".turbo", "coverage"]);

async function readJson(path) {
  const contents = await readFile(new URL(path, rootUrl), "utf8");
  return JSON.parse(contents);
}

function shouldDescendSourceDirectory(directoryName) {
  return !generatedSourceDirectories.has(directoryName);
}

async function collectSourceFiles(directory) {
  const entries = await readdir(new URL(directory, rootUrl), { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const relativePath = `${directory}${entry.name}`;
      if (entry.isDirectory()) {
        return shouldDescendSourceDirectory(entry.name)
          ? collectSourceFiles(`${relativePath}/`)
          : [];
      }
      return /\.(?:[cm]?[jt]s|tsx)$/u.test(entry.name) ? [relativePath] : [];
    }),
  );
  return nested.flat();
}

const restrictedAuthModules = new Map([
  ["@laundry/contracts/browser-auth-ingress", "browser-auth-ingress"],
  ["@laundry/contracts/edge-auth-ingress", "edge-auth-ingress"],
  ["packages/contracts/src/auth/browser-ingress", "browser-auth-ingress"],
  ["packages/contracts/dist/auth/browser-ingress", "browser-auth-ingress"],
  ["packages/contracts/src/auth/edge-ingress", "edge-auth-ingress"],
  ["packages/contracts/dist/auth/edge-ingress", "edge-auth-ingress"],
  ["packages/contracts/src/auth/source-registry", "auth-source-registry"],
  ["packages/contracts/dist/auth/source-registry", "auth-source-registry"],
  ["packages/contracts/src/auth/operations", "identity-lifecycle-authority"],
  ["packages/contracts/dist/auth/operations", "identity-lifecycle-authority"],
]);

function stripModuleExtension(path) {
  return path.replace(/\.(?:[cm]?[jt]s|tsx)$/u, "");
}

function resolveRestrictedAuthTarget(sourcePath, specifier) {
  const normalizedSpecifier = specifier.replaceAll("\\", "/").replace(/[?#].*$/u, "");
  const packageTarget = restrictedAuthModules.get(normalizedSpecifier);
  if (packageTarget !== undefined) return packageTarget;
  if (!normalizedSpecifier.startsWith(".")) return null;

  const resolvedPath = stripModuleExtension(
    posixPath.normalize(posixPath.join(posixPath.dirname(sourcePath), normalizedSpecifier)),
  );
  if (resolvedPath.startsWith("packages/contracts/test/") && /\.test$/u.test(resolvedPath)) {
    return "auth-authority-test-module";
  }
  return restrictedAuthModules.get(resolvedPath) ?? null;
}

function isExplicitAuthAuthorityTestSource(path) {
  return path.startsWith("packages/contracts/test/") && /\.test\.[cm]?[jt]sx?$/u.test(path);
}

function isRestrictedAuthTargetAllowed(path, target) {
  if (target === "auth-authority-test-module") {
    return isExplicitAuthAuthorityTestSource(path);
  }
  if (isExplicitAuthAuthorityTestSource(path)) return true;
  if (target === "browser-auth-ingress") {
    return path.startsWith("apps/server/src/auth/");
  }
  if (target === "edge-auth-ingress") {
    return path.startsWith("apps/server/src/edge-ingress/");
  }
  if (target === "auth-source-registry") {
    return [
      "packages/contracts/src/auth/browser-ingress.ts",
      "packages/contracts/src/auth/edge-ingress.ts",
      "packages/contracts/src/auth/session.ts",
    ].includes(path);
  }
  if (target === "identity-lifecycle-authority") {
    // A6 catalog + A7 OpenAPI project A5 request schemas; runtime issue factories stay ingress-only.
    return (
      path === "packages/contracts/src/index.ts" ||
      path === "packages/contracts/src/auth/browser-ingress.ts" ||
      path.startsWith("packages/contracts/src/commands/") ||
      path.startsWith("packages/contracts/src/openapi/")
    );
  }
  return false;
}

function isRestrictedContractsImportAllowed(path, subpath) {
  const target = resolveRestrictedAuthTarget(path, subpath);
  return target !== null && isRestrictedAuthTargetAllowed(path, target);
}

function isTypeOnlyImport(node) {
  const clause = node.importClause;
  if (clause?.isTypeOnly === true) return true;
  return (
    clause?.name === undefined &&
    clause?.namedBindings !== undefined &&
    ts.isNamedImports(clause.namedBindings) &&
    clause.namedBindings.elements.length > 0 &&
    clause.namedBindings.elements.every((element) => element.isTypeOnly)
  );
}

function isTypeOnlyExport(node) {
  return (
    node.isTypeOnly ||
    (node.exportClause !== undefined &&
      ts.isNamedExports(node.exportClause) &&
      node.exportClause.elements.length > 0 &&
      node.exportClause.elements.every((element) => element.isTypeOnly))
  );
}

function isTypeOnlyModuleLiteral(node) {
  if (ts.isImportDeclaration(node.parent)) return isTypeOnlyImport(node.parent);
  if (ts.isExportDeclaration(node.parent)) return isTypeOnlyExport(node.parent);

  let ancestor = node.parent;
  while (ancestor !== undefined && !ts.isSourceFile(ancestor)) {
    if (ts.isImportTypeNode(ancestor)) return true;
    ancestor = ancestor.parent;
  }
  return false;
}

function isRuntimeModuleLoadCall(node) {
  return (
    node.expression.kind === ts.SyntaxKind.ImportKeyword ||
    (ts.isIdentifier(node.expression) && node.expression.text === "require") ||
    (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "require")
  );
}

function analyzeAuthModuleLoads(sourcePath, contents) {
  const scriptKind = /\.tsx$/u.test(sourcePath)
    ? ts.ScriptKind.TSX
    : /\.[cm]?jsx?$/u.test(sourcePath)
      ? ts.ScriptKind.JSX
      : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    sourcePath,
    contents,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
  const restrictedTargets = new Set();
  let hasNonLiteralRuntimeLoad = false;

  const visit = (node) => {
    if (ts.isCallExpression(node) && isRuntimeModuleLoadCall(node)) {
      const [specifier] = node.arguments;
      if (
        specifier === undefined ||
        (!ts.isStringLiteral(specifier) && !ts.isNoSubstitutionTemplateLiteral(specifier))
      ) {
        hasNonLiteralRuntimeLoad = true;
      }
    }

    if (ts.isStringLiteralLike(node) && !isTypeOnlyModuleLiteral(node)) {
      const target = resolveRestrictedAuthTarget(sourcePath, node.text);
      if (target !== null) restrictedTargets.add(target);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return { restrictedTargets, hasNonLiteralRuntimeLoad };
}

test("does not descend into generated workspace directories", () => {
  for (const directory of ["dist", "node_modules", ".turbo", "coverage"]) {
    assert.equal(shouldDescendSourceDirectory(directory), false, `${directory} must be skipped`);
  }
  assert.equal(shouldDescendSourceDirectory("src"), true);
  assert.equal(shouldDescendSourceDirectory("auth"), true);
});

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
  assert.match(workspaceConfig, /allowBuilds:/);
  assert.match(workspaceConfig, /better-sqlite3:\s*true/);
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
    // Core scripts required; packages may add extras (e.g. edge-agent printer-smoke).
    const requiredScripts = ["build", "dev", "lint", "test", "typecheck"];
    for (const name of requiredScripts) {
      assert.equal(
        typeof workspacePackage.scripts[name],
        "string",
        `${workspaceName} must define script "${name}"`,
      );
    }
    assert.equal(tsconfig.compilerOptions.rootDir, "src");
    assert.equal(tsconfig.compilerOptions.outDir, "dist");
    await readFile(new URL(`${workspaceName}/src/index.ts`, rootUrl), "utf8");
  }
});

test("builds file-linked workspace dependencies before their consumers test", async () => {
  const turboConfig = await readJson("turbo.json");
  const webPackage = await readJson("apps/web/package.json");
  const uiPackage = await readJson("packages/ui/package.json");
  const domainPackage = await readJson("packages/domain/package.json");

  // web depends on ui + domain dist types; turbo must build them first.
  const webDepBuild = ["^build", `${uiPackage.name}#build`, `${domainPackage.name}#build`];
  assert.deepEqual(turboConfig.tasks[`${webPackage.name}#test`]?.dependsOn, webDepBuild);
  assert.deepEqual(turboConfig.tasks[`${webPackage.name}#typecheck`]?.dependsOn, webDepBuild);
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

test("restricts auth authority imports to their server ingress owners", async () => {
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
    const analysis = analyzeAuthModuleLoads(path, contents);
    if (!isExplicitAuthAuthorityTestSource(path)) {
      assert.equal(
        analysis.hasNonLiteralRuntimeLoad,
        false,
        `${path} must use literal import()/require() specifiers for authority analysis`,
      );
    }
    for (const target of analysis.restrictedTargets) {
      assert.equal(
        isRestrictedAuthTargetAllowed(path, target),
        true,
        `${path} must not import restricted authority ${target}`,
      );
    }
  }
});

test("normalizes package and relative imports before enforcing auth authority ownership", () => {
  assert.equal(
    resolveRestrictedAuthTarget(
      "apps/web/src/auth.ts",
      "../../../packages/contracts/dist/auth/browser-ingress.js",
    ),
    "browser-auth-ingress",
  );
  assert.equal(
    resolveRestrictedAuthTarget(
      "apps/server/src/routes/replay.ts",
      "../../../../packages/contracts/src/auth/edge-ingress.ts",
    ),
    "edge-auth-ingress",
  );
  assert.equal(
    resolveRestrictedAuthTarget(
      "packages/contracts/src/registry/definitions.ts",
      "../auth/source-registry.js",
    ),
    "auth-source-registry",
  );
  assert.equal(
    resolveRestrictedAuthTarget(
      "apps/web/src/auth.ts",
      "../../../packages/contracts/src/auth/operations.js",
    ),
    "identity-lifecycle-authority",
  );
  assert.equal(
    resolveRestrictedAuthTarget(
      "apps/web/src/auth.ts",
      "../../../packages/contracts/dist/auth/browser-ingress.js?worker#authority",
    ),
    "browser-auth-ingress",
  );
  assert.equal(
    resolveRestrictedAuthTarget(
      "apps/web/src/auth.ts",
      "..\\..\\..\\packages\\contracts\\dist\\auth\\edge-ingress.js",
    ),
    "edge-auth-ingress",
  );
  assert.equal(resolveRestrictedAuthTarget("apps/web/src/auth.ts", "@laundry/contracts"), null);

  assert.equal(
    isRestrictedAuthTargetAllowed("apps/web/src/auth.ts", "browser-auth-ingress"),
    false,
  );
  assert.equal(
    isRestrictedAuthTargetAllowed(
      "packages/contracts/test/auth-session.test.ts",
      "browser-auth-ingress",
    ),
    true,
  );
  assert.equal(
    isRestrictedAuthTargetAllowed("apps/web/src/test/auth.test.ts", "browser-auth-ingress"),
    false,
  );
  assert.equal(
    resolveRestrictedAuthTarget(
      "apps/web/src/index.ts",
      "../../../packages/contracts/test/auth-session.test.js",
    ),
    "auth-authority-test-module",
  );
  assert.equal(
    isRestrictedAuthTargetAllowed("apps/web/src/index.ts", "auth-authority-test-module"),
    false,
  );
});

test("rejects require and non-literal runtime module-load bypasses", () => {
  const variableImport = analyzeAuthModuleLoads(
    "apps/web/src/auth.ts",
    'const target = "@laundry/contracts/browser-auth-ingress"; import(target);',
  );
  assert.deepEqual([...variableImport.restrictedTargets], ["browser-auth-ingress"]);
  assert.equal(variableImport.hasNonLiteralRuntimeLoad, true);

  const commonJsRequire = analyzeAuthModuleLoads(
    "apps/web/src/auth.ts",
    'require("@laundry/contracts/edge-auth-ingress");',
  );
  assert.deepEqual([...commonJsRequire.restrictedTargets], ["edge-auth-ingress"]);
  assert.equal(commonJsRequire.hasNonLiteralRuntimeLoad, false);

  const importEquals = analyzeAuthModuleLoads(
    "apps/web/src/auth.ts",
    'import authority = require("@laundry/contracts/browser-auth-ingress");',
  );
  assert.deepEqual([...importEquals.restrictedTargets], ["browser-auth-ingress"]);

  const computedRelativeImport = analyzeAuthModuleLoads(
    "apps/web/src/auth.ts",
    'import("../../../packages/contracts/dist/auth/" + "source-registry.js");',
  );
  assert.equal(computedRelativeImport.hasNonLiteralRuntimeLoad, true);
});

test("declares v2 as the only active delivery line", async () => {
  const adr13Path = "docs/adr/2026-07-23-adr-13-v2-only-upgrade-delivery.md";
  const adr13RootLink = /\(docs\/adr\/2026-07-23-adr-13-v2-only-upgrade-delivery\.md\)/u;
  const currentEntryPaths = [
    "README.md",
    "AGENTS.md",
    "GROK.md",
    "CLAUDE.md",
    "GEMINI.md",
    "HERMES.md",
  ];
  const activeDualTrackPatterns = [
    /v1\s*(?:与|、|\/)\s*v2\s*(?:均为|都是)\s*活动交付线/iu,
    /v1\s*\/\s*v2\s*双线\s*并行开发/iu,
    /两条产品线\s*并行\s*[：:]?\s*v2\s*(?:与|、|\/)\s*v1/iu,
  ];
  const declaresActiveDualTrack = (value) =>
    activeDualTrackPatterns.some((pattern) => pattern.test(value.replace(/\s+/gu, " ")));

  for (const staleStatus of [
    "v1 与 v2 均为活动交付线",
    "v1/v2 双线并行开发",
    "两条产品线并行：v2 与 v1",
  ]) {
    assert.equal(declaresActiveDualTrack(staleStatus), true);
  }
  for (const historicalOrNegativeStatus of ["v1 与 v2 不再并行开发", "禁止双线并行：v2 与 v1"]) {
    assert.equal(declaresActiveDualTrack(historicalOrNegativeStatus), false);
  }

  const adr13 = await readFile(new URL(adr13Path, rootUrl), "utf8");
  assert.match(adr13, /状态：\*\*Accepted\*\*/u);
  assert.match(adr13, /仅保留一条活动交付线：v2/u);
  assert.match(adr13, /v1 单店版停止后续功能开发与独立发版/u);
  assert.match(adr13, /`tools\/migrate-v1` 的只读提取/u);
  assert.match(adr13, /不采用.*双写观察/u);

  for (const path of currentEntryPaths) {
    const contents = await readFile(new URL(path, rootUrl), "utf8");
    assert.match(contents, adr13RootLink, `${path} must link the v2-only decision`);
    // Current route declarations belong in the status header; historical documents are checked separately.
    assert.equal(
      declaresActiveDualTrack(contents.split(/\r?\n/u).slice(0, 30).join(" ")),
      false,
      `${path} status header must not declare an active v1/v2 dual track`,
    );
  }

  const readme = await readFile(new URL("README.md", rootUrl), "utf8");
  const changelog = await readFile(new URL("docs/CHANGELOG.md", rootUrl), "utf8");
  const adrIndex = await readFile(new URL("docs/adr/README.md", rootUrl), "utf8");
  const hermes = await readFile(new URL("HERMES.md", rootUrl), "utf8");
  const v2Architecture = await readFile(
    new URL("docs/superpowers/specs/2026-07-19-laundry-v2-architecture.md", rootUrl),
    "utf8",
  );
  const m2ToM6Plan = await readFile(
    new URL("docs/superpowers/plans/2026-07-19-v2-m2-m6-implementation-plan.md", rootUrl),
    "utf8",
  );
  const currentTaskBook = await readFile(
    new URL("docs/superpowers/plans/tasks/2026-07-21-task-grok-lead.md", rootUrl),
    "utf8",
  );
  const foundationWorkflow = await readFile(
    new URL(".github/workflows/foundation.yml", rootUrl),
    "utf8",
  );
  const rootManifest = JSON.parse(await readFile(new URL("package.json", rootUrl), "utf8"));
  const legacySpec = await readFile(
    new URL("docs/superpowers/specs/2026-04-23-laundry-desk-design.md", rootUrl),
    "utf8",
  );

  assert.doesNotMatch(readme, /v1（宏发单店）.*仍在进行|M4\s*∥\s*M5/u);
  assert.match(readme.slice(0, 800), /产品目标.*规划支持/su);
  assert.match(readme, /\(docs\/superpowers\/plans\/tasks\/2026-07-21-task-grok-lead\.md\)/u);
  assert.doesNotMatch(changelog, /两条线并行/u);
  assert.doesNotMatch(changelog, /### 已完成（未发版）/u);
  assert.doesNotMatch(hermes, /仓库同时保留两条线|v1.*M1[–-]M5 收口/u);
  assert.match(changelog, /\(adr\/2026-07-23-adr-13-v2-only-upgrade-delivery\.md\)/u);
  assert.match(adrIndex, /\(2026-07-23-adr-13-v2-only-upgrade-delivery\.md\)/u);
  assert.match(adrIndex, /\[总 RFC\].*ADR-13/u);
  assert.match(v2Architecture.slice(0, 2_000), /\[ADR-13\].*v2 成为唯一活动交付线/u);
  assert.doesNotMatch(m2ToM6Plan, /双写观察|\*\*Codex\*\*|\*\*Grok 协助\*\*/u);
  assert.match(currentTaskBook.slice(0, 1_000), /Owner：\[ADR-12\].*产品路线：\[ADR-13\]/su);
  assert.match(currentTaskBook, /`tools\/migrate-v1` 只读迁移/u);
  assert.doesNotMatch(currentTaskBook, /双写观察|\*\*Codex\*\*|Grok 协助/u);
  assert.match(rootManifest.description, /v2.*产品化/u);
  assert.doesNotMatch(rootManifest.description, /单店单机 Windows/u);
  const pullRequestBlock = foundationWorkflow.match(
    /^  pull_request:\n(?:(?: {4,}.*|\s*)\n)*/mu,
  )?.[0];
  assert.ok(pullRequestBlock, "foundation workflow must define pull_request configuration");
  const pullRequestPathsBlock = pullRequestBlock.match(/^    paths:\n(?:      - .*\n)+/mu)?.[0];
  assert.ok(pullRequestPathsBlock, "foundation pull_request must define a paths list");
  for (const governancePathFilter of ['- "*.md"', '- ".hermes/plans/**"', '- "docs/**"']) {
    assert.ok(
      pullRequestPathsBlock.includes(governancePathFilter),
      `foundation pull_request paths must include ${governancePathFilter}`,
    );
  }
  assert.match(changelog, /v1.*(?:Archived|已归档)/iu);
  assert.match(legacySpec.slice(0, 600), /(?:archived|superseded).*ADR-13/iu);
});
