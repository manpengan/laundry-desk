import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

async function assertPgpassCleanup({ script, environment, prefix }) {
  const fixture = await mkdtemp(join(tmpdir(), "laundry-pgpass-cleanup-"));
  const fakePsql = join(fixture, "psql");

  try {
    await writeFile(fakePsql, "#!/usr/bin/env bash\nexit 31\n", { mode: 0o700 });
    await chmod(fakePsql, 0o700);

    await assert.rejects(
      () =>
        execFileAsync("/bin/bash", [join(repositoryRoot, script)], {
          cwd: repositoryRoot,
          env: {
            PATH: `${fixture}:${process.env.PATH ?? "/usr/bin:/bin"}`,
            TMPDIR: fixture,
            ...environment,
          },
        }),
      (error) => {
        assert.doesNotMatch(`${error.stdout ?? ""}\n${error.stderr ?? ""}`, /test-secret/u);
        assert.doesNotMatch(`${error.stderr ?? ""}`, /unbound variable/u);
        return true;
      },
    );

    const residue = (await readdir(fixture)).filter((name) => name.startsWith(prefix));
    assert.deepEqual(residue, []);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

test("migration failure removes its private host pgpass file", async () => {
  await assertPgpassCleanup({
    script: "tools/compose/migrate-v2.sh",
    environment: { POSTGRES_PASSWORD: "migration-test-secret" },
    prefix: "laundry-migrate-pgpass.",
  });
});

test("RLS smoke failure removes its private host pgpass file", async () => {
  await assertPgpassCleanup({
    script: "tools/compose/smoke-rls.sh",
    environment: {
      LAUNDRY_APP_PASSWORD: "app-test-secret",
      POSTGRES_PASSWORD: "admin-test-secret",
    },
    prefix: "laundry-smoke-pgpass.",
  });
});
