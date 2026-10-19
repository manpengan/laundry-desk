import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RELATIVE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'](\.{1,2}\/[^"']+)["']/gu;

/** Every dist module the packaged main process can load, following relative imports. */
async function mainClosure() {
  const seen = new Set();
  const pending = [join(packageRoot, "dist", "main.js")];
  while (pending.length > 0) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(RELATIVE_IMPORT)) {
      const target = resolve(dirname(file), match[1]);
      if (target.endsWith(".js")) pending.push(target);
    }
  }
  return [...seen].map((file) => relative(packageRoot, file).split("\\").join("/")).sort();
}

async function whitelist(name) {
  const text = await readFile(join(packageRoot, name), "utf8");
  const body = /^files:\n(?<body>(?:  - .+\n)+)/mu.exec(text)?.groups?.body ?? "";
  return new Set(
    body
      .trim()
      .split("\n")
      .map((line) => line.replace(/^\s*-\s+/u, "").replaceAll('"', ""))
      .filter((entry) => !entry.startsWith("!")),
  );
}

test("every module the packaged main process imports is in both packaging whitelists", async (t) => {
  if (!existsSync(join(packageRoot, "dist", "main.js"))) {
    t.skip("dist is not built");
    return;
  }
  const closure = await mainClosure();
  assert.ok(closure.length > 50, "the closure walk must reach the main process modules");
  for (const config of ["electron-builder.yml", "electron-builder.release.yml"]) {
    const included = await whitelist(config);
    const missing = closure.filter((file) => !included.has(file));
    assert.deepEqual(missing, [], `${config} must ship every imported main-process module`);
  }
});
