import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { maintenanceAcceptance } from "./maintenance-acceptance.mjs";
import { canonicalManifest, digest, parseManifest, REQUIRED_FILES } from "./companion-contract.mjs";
import { COMPANION_SOURCES } from "./companion-sources.mjs";

test("cross-schema acceptance builds an ordinal canonical candidate before launching upgrade", async (t) => {
  const folder = await mkdtemp(join(tmpdir(), "laundry-maintenance-manifest-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  await mkdir(join(folder, "migrations"));
  const paths = [
    ...new Set([
      ...REQUIRED_FILES,
      "postgres/bin/libecpg_compat.dll",
      "postgres/bin/libecpg.dll",
      "migrations/0001_initial.sql",
      "migrations/0002_fixture.sql",
    ]),
  ].sort();
  const original = {
    schema: "laundry.windows.runtime-payload",
    version: 1,
    assurance: "development_only",
    platform: "win32-x64",
    source_git_sha: "a".repeat(40),
    runtime_release: "0.1.0-win-dev.4",
    sources: COMPANION_SOURCES,
    migration_head: "0002_fixture.sql",
    migrations_sha256: "b".repeat(64),
    files: paths.map((path) => ({ path, size: 1, sha256: digest("x") })),
  };
  const originalBytes = canonicalManifest(original);
  await writeFile(join(folder, "runtime-payload.json"), originalBytes);
  assert.throws(
    () =>
      canonicalManifest({
        ...original,
        files: [...original.files].sort((a, b) => a.path.localeCompare(b.path)),
      }),
    /WINDOWS_COMPANION_FILE_SET_INVALID/u,
  );
  const reachedUpgrade = new Error("SYNTHETIC_CANDIDATE_VALIDATED");
  let launches = 0;
  await assert.rejects(
    maintenanceAcceptance({
      // This regression executes the real candidate builder, stopping before any service action.
      scenario: async (name, action) => {
        if (name === "cross-schema-shadow-upgrade-and-paired-snapshot-rollback") await action();
      },
      variant: async () => ({ folder, hash: digest(originalBytes) }),
      command: async (action, source, hash) => {
        launches += 1;
        assert.equal(action, "upgrade");
        assert.equal(source, folder);
        const bytes = await readFile(join(folder, "runtime-payload.json"));
        const candidate = parseManifest(bytes, hash);
        const migration = await readFile(join(folder, "migrations/0003_runtime_acceptance.sql"));
        const added = candidate.files.find(
          (file) => file.path === "migrations/0003_runtime_acceptance.sql",
        );
        assert.deepEqual(added, {
          path: "migrations/0003_runtime_acceptance.sql",
          size: migration.length,
          sha256: digest(migration),
        });
        assert.equal(candidate.migration_head, "0003_runtime_acceptance.sql");
        assert.equal(candidate.files.length, original.files.length + 1);
        assert.deepEqual(
          candidate.files.filter((file) => file !== added),
          original.files,
        );
        assert.equal(
          candidate.migrations_sha256,
          digest(
            candidate.files
              .filter((file) => file.path.startsWith("migrations/"))
              .map((file) => `${file.path.slice(11)}\0${file.sha256}\n`)
              .join(""),
          ),
        );
        throw reachedUpgrade;
      },
      digest,
      canonicalManifest,
    }),
    (error) => error === reachedUpgrade,
  );
  assert.equal(launches, 1);
});
