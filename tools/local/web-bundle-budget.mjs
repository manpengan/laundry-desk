import { lstat, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const WEB_BUNDLE_BUDGETS = Object.freeze({
  maxChunkBytes: 500 * 1024,
  maxInitialJsBytes: 700 * 1024,
  maxTotalJsBytes: 1500 * 1024,
  maxTotalCssBytes: 160 * 1024,
});

export class WebBundleBudgetError extends Error {
  constructor(code) {
    super(code);
    this.name = "WebBundleBudgetError";
    this.code = code;
  }
}

function fail(code) {
  throw new WebBundleBudgetError(code);
}

async function requireDirectory(path, code) {
  let stat;
  try {
    stat = await lstat(path);
  } catch {
    fail(code);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(code);
}

async function collectAssets(assetsDirectory) {
  const entries = await readdir(assetsDirectory, { withFileTypes: true });
  const selected = entries.filter((entry) => /\.(?:css|js)$/u.test(entry.name));
  if (selected.length === 0) fail("WEB_BUNDLE_ASSETS_EMPTY");

  const assets = new Map();
  for (const entry of selected) {
    if (!entry.isFile() || entry.isSymbolicLink()) fail("WEB_BUNDLE_ASSET_INVALID");
    const stat = await lstat(join(assetsDirectory, entry.name));
    if (!stat.isFile() || stat.isSymbolicLink()) fail("WEB_BUNDLE_ASSET_INVALID");
    assets.set(entry.name, stat.size);
  }
  return assets;
}

function initialJavaScriptNames(html) {
  const names = new Set();
  for (const match of html.matchAll(/(?:href|src)="\.\/assets\/([^"/]+\.js)"/gu)) {
    const name = match[1];
    if (name !== undefined) names.add(name);
  }
  if (names.size === 0) fail("WEB_BUNDLE_INITIAL_JS_EMPTY");
  return names;
}

function totalForExtension(assets, extension) {
  let total = 0;
  for (const [name, size] of assets) {
    if (name.endsWith(extension)) total += size;
  }
  return total;
}

export async function inspectWebBundle(buildDirectory, budgets = WEB_BUNDLE_BUDGETS) {
  const root = resolve(buildDirectory);
  const assetsDirectory = join(root, "assets");
  await requireDirectory(root, "WEB_BUNDLE_DIRECTORY_INVALID");
  await requireDirectory(assetsDirectory, "WEB_BUNDLE_ASSETS_DIRECTORY_INVALID");

  let html;
  try {
    html = await readFile(join(root, "index.html"), "utf8");
  } catch {
    fail("WEB_BUNDLE_INDEX_INVALID");
  }

  const assets = await collectAssets(assetsDirectory);
  const jsAssets = [...assets].filter(([name]) => name.endsWith(".js"));
  if (jsAssets.length === 0) fail("WEB_BUNDLE_JS_EMPTY");
  const largestChunkBytes = Math.max(...jsAssets.map(([, size]) => size));
  if (largestChunkBytes > budgets.maxChunkBytes) fail("WEB_BUNDLE_CHUNK_BUDGET_EXCEEDED");

  let initialJsBytes = 0;
  for (const name of initialJavaScriptNames(html)) {
    const size = assets.get(name);
    if (size === undefined || !name.endsWith(".js")) fail("WEB_BUNDLE_INITIAL_ASSET_MISSING");
    initialJsBytes += size;
  }
  if (initialJsBytes > budgets.maxInitialJsBytes) {
    fail("WEB_BUNDLE_INITIAL_JS_BUDGET_EXCEEDED");
  }

  const totalJsBytes = totalForExtension(assets, ".js");
  if (totalJsBytes > budgets.maxTotalJsBytes) fail("WEB_BUNDLE_TOTAL_JS_BUDGET_EXCEEDED");
  const totalCssBytes = totalForExtension(assets, ".css");
  if (totalCssBytes > budgets.maxTotalCssBytes) fail("WEB_BUNDLE_TOTAL_CSS_BUDGET_EXCEEDED");

  return Object.freeze({
    chunkCount: jsAssets.length,
    largestChunkBytes,
    initialJsBytes,
    totalJsBytes,
    totalCssBytes,
  });
}

async function main() {
  const buildDirectory = process.argv[2];
  if (buildDirectory === undefined || process.argv.length !== 3) {
    console.error("WEB_BUNDLE_DIRECTORY_REQUIRED");
    process.exitCode = 1;
    return;
  }
  try {
    const summary = await inspectWebBundle(buildDirectory);
    console.log(
      `WEB_BUNDLE_BUDGET_OK chunks=${summary.chunkCount} max_chunk_bytes=${summary.largestChunkBytes} initial_js_bytes=${summary.initialJsBytes} total_js_bytes=${summary.totalJsBytes} total_css_bytes=${summary.totalCssBytes}`,
    );
  } catch (error) {
    console.error(error instanceof WebBundleBudgetError ? error.code : "WEB_BUNDLE_BUDGET_FAILED");
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
