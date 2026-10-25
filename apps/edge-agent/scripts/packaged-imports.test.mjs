import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import beforePack, { PACKAGE_CONFIGS, requirePackagedImports } from "./packaged-imports.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "laundry-packaged-imports-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await mkdir(join(root, "dist"));
  await writeFile(join(root, "dist/main.js"), 'import "./helper.js";\n');
  await writeFile(join(root, "dist/helper.js"), 'export { value } from "./nested.js";\n');
  await writeFile(join(root, "dist/nested.js"), "export const value = 1;\n");
  for (const config of PACKAGE_CONFIGS)
    await writeFile(
      join(root, config),
      "files:\n  - dist/main.js\n  - dist/helper.js\n  - dist/nested.js\n",
    );
  return { root, context: { packager: { projectDir: root } } };
}

test("every module the packaged main process imports is in both packaging whitelists", async () => {
  const closure = await requirePackagedImports(packageRoot);
  assert.ok(closure.length > 50, "the closure walk must reach the main process modules");
  for (const config of PACKAGE_CONFIGS) {
    const text = await readFile(join(packageRoot, config), "utf8");
    assert.match(text, /^beforePack: \.\/scripts\/packaged-imports\.mjs$/mu);
  }
});

test("beforePack accepts a complete transitive import closure", async (t) => {
  const { context } = await fixture(t);
  await beforePack(context);
});

for (const config of PACKAGE_CONFIGS) {
  test(`beforePack rejects a transitive import omitted from ${config}`, async (t) => {
    const { root, context } = await fixture(t);
    await writeFile(join(root, config), "files:\n  - dist/main.js\n  - dist/helper.js\n");
    await assert.rejects(beforePack(context), {
      message: `PACKAGED_IMPORT_MISSING: ${config}: dist/nested.js`,
    });
  });
}

test("beforePack rejects a listed import whose built module is missing", async (t) => {
  const { root, context } = await fixture(t);
  await rm(join(root, "dist/nested.js"));
  await assert.rejects(beforePack(context), { code: "ENOENT" });
});

test("beforePack rejects absent dist instead of skipping validation", async (t) => {
  const { root, context } = await fixture(t);
  await rm(join(root, "dist"), { recursive: true });
  await assert.rejects(beforePack(context), { code: "ENOENT" });
});

test("beforePack rejects missing project context instead of falling back to cwd", async () => {
  await assert.rejects(beforePack({}), { message: "PACKAGED_IMPORT_ROOT_INVALID" });
});
