import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const RELATIVE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'](\.{1,2}\/[^"']+)["']/gu;
export const PACKAGE_CONFIGS = ["electron-builder.yml", "electron-builder.release.yml"];

/** Every dist module the packaged main process can load, following relative imports. */
async function mainClosure(packageRoot) {
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

async function whitelist(packageRoot, name) {
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

export async function requirePackagedImports(packageRoot) {
  if (typeof packageRoot !== "string" || !isAbsolute(packageRoot))
    throw new Error("PACKAGED_IMPORT_ROOT_INVALID");
  const closure = await mainClosure(packageRoot);
  for (const config of PACKAGE_CONFIGS) {
    const included = await whitelist(packageRoot, config);
    const missing = closure.filter((file) => !included.has(file));
    if (missing.length > 0)
      throw new Error(`PACKAGED_IMPORT_MISSING: ${config}: ${missing.join(", ")}`);
  }
  return closure;
}

export default async function beforePack(context) {
  await requirePackagedImports(context?.packager?.projectDir);
}
