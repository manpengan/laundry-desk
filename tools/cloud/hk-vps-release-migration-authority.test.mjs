import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { sha256File } from "./hk-vps-release-core.mjs";
import {
  captureMigrationAuthority,
  verifyMigrationAuthority,
} from "./hk-vps-release-migration-authority.mjs";

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "laundry-migration-authority-")));
  await mkdir(join(root, "tools/compose"), { recursive: true });
  await mkdir(join(root, "packages/db/src/migrations"), { recursive: true });
  const runner = join(root, "tools/compose/migrate-v2.sh");
  const migration = join(root, "packages/db/src/migrations/0001_roles.sql");
  await writeFile(runner, "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  await writeFile(migration, "SELECT 1;\n", { mode: 0o644 });
  return Object.freeze({ migration, root, runner });
}

test("candidate migration tampering after ownership handoff fails closed", async () => {
  const files = await fixture();
  const identity = Object.freeze({ gid: process.getgid(), uid: process.getuid() });
  try {
    const authority = await captureMigrationAuthority(
      files.root,
      [
        Object.freeze({
          checksum: await sha256File(files.migration),
          filename: "0001_roles.sql",
        }),
      ],
      identity,
    );
    await writeFile(files.migration, "SELECT pg_sleep(10);\n", { mode: 0o644 });
    await assert.rejects(() => verifyMigrationAuthority(files.root, authority, identity), {
      code: "CLOUD_RELEASE_MIGRATION_AUTHORITY_MISMATCH",
    });
  } finally {
    await rm(files.root, { force: true, recursive: true });
  }
});
