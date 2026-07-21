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
  "packages/ui",
  "packages/config",
];
const libraryNames = ["packages/contracts", "packages/domain", "packages/ui"];
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
