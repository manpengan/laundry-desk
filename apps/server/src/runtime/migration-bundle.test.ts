import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadMigrationBundle } from "./migration-bundle.js";

test("migration bundle checksum is deterministic and binds names, order, and contents", async () => {
  const root = await mkdtemp(join(tmpdir(), "laundry-runtime-migrations-"));
  await writeFile(join(root, "0002_second.sql"), "SELECT 2;\n");
  await writeFile(join(root, "0001_first.sql"), "SELECT 1;\n");
  await writeFile(join(root, "README.md"), "ignored\n");

  const first = await loadMigrationBundle(root);
  const second = await loadMigrationBundle(root);
  assert.equal(first.aggregateChecksum, second.aggregateChecksum);
  assert.deepEqual(
    first.entries.map((entry) => entry.filename),
    ["0001_first.sql", "0002_second.sql"],
  );
  assert.equal(first.head, "0002_second.sql");

  await writeFile(join(root, "0001_first.sql"), "SELECT 3;\n");
  const changed = await loadMigrationBundle(root);
  assert.notEqual(changed.aggregateChecksum, first.aggregateChecksum);
});

test("migration bundle rejects gaps, links, and empty directories", async () => {
  const { symlink } = await import("node:fs/promises");
  const empty = await mkdtemp(join(tmpdir(), "laundry-runtime-empty-"));
  await assert.rejects(() => loadMigrationBundle(empty), /RUNTIME_MIGRATION_BUNDLE_INVALID/u);

  const gap = await mkdtemp(join(tmpdir(), "laundry-runtime-gap-"));
  await writeFile(join(gap, "0001_first.sql"), "SELECT 1;");
  await writeFile(join(gap, "0003_third.sql"), "SELECT 3;");
  await assert.rejects(() => loadMigrationBundle(gap), /RUNTIME_MIGRATION_BUNDLE_INVALID/u);

  const linked = await mkdtemp(join(tmpdir(), "laundry-runtime-link-"));
  const target = join(linked, "target.sql");
  await writeFile(target, "SELECT 1;");
  await symlink(target, join(linked, "0001_link.sql"));
  await assert.rejects(() => loadMigrationBundle(linked), /RUNTIME_MIGRATION_BUNDLE_INVALID/u);
});
