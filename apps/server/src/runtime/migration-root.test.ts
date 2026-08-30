import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveRuntimeMigrationsRoot } from "./migration-root.js";

test("keeps the signed-container migration root as the default", () => {
  assert.equal(resolveRuntimeMigrationsRoot({}), "/opt/laundry/migrations");
});

test("accepts one normalized absolute native-runtime migration root", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "laundry-runtime-migrations-")));
  t.after(async () => await rm(root, { force: true, recursive: true }));

  assert.equal(resolveRuntimeMigrationsRoot({ LAUNDRY_RUNTIME_MIGRATIONS_DIR: root }), root);
});

test("rejects empty, relative, non-normalized, or nul-containing roots", () => {
  for (const value of ["", "relative/migrations", "/tmp/../migrations", "/tmp/bad\0root"]) {
    assert.throws(
      () => resolveRuntimeMigrationsRoot({ LAUNDRY_RUNTIME_MIGRATIONS_DIR: value }),
      /RUNTIME_MIGRATIONS_ROOT_INVALID/u,
    );
  }
});
