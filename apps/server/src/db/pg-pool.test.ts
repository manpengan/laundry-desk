import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { securePrivateFile } from "@laundry/platform-fs";

import { resolvePgUrls, resolveRuntimeDatabaseUrl } from "./pg-pool.js";

test("runtime database resolution never falls back to an admin URL", () => {
  assert.equal(
    resolveRuntimeDatabaseUrl({
      DATABASE_ADMIN_URL: "postgresql://owner:secret@db.example.test/laundry",
      SUPERUSER_DATABASE_URL: "postgresql://superuser:secret@db.example.test/laundry",
    }),
    null,
  );
});

test("runtime database resolution accepts only the explicit app URL", () => {
  const appUrl = "postgresql://laundry_app:secret@db.example.test/laundry";
  assert.equal(
    resolveRuntimeDatabaseUrl({
      DATABASE_URL: appUrl,
      DATABASE_ADMIN_URL: "postgresql://owner:secret@db.example.test/laundry",
    }),
    appUrl,
  );
});

test("runtime database resolution accepts a private DATABASE_URL_FILE", async () => {
  const root = await mkdtemp(join(tmpdir(), "laundry-database-file-"));
  const path = join(root, "database-url");
  const appUrl = "postgresql://laundry_app:file-secret@postgres:5432/laundry_v2";
  await writeFile(path, appUrl, { mode: 0o600 });
  await securePrivateFile(path);

  assert.equal(resolveRuntimeDatabaseUrl({ DATABASE_URL_FILE: path }), appUrl);
  assert.throws(
    () => resolveRuntimeDatabaseUrl({ DATABASE_URL: appUrl, DATABASE_URL_FILE: path }),
    /SECRET_SOURCE_AMBIGUOUS/u,
  );
});

test("opt-in local PG requires an explicit app-role URL", () => {
  assert.throws(
    () =>
      resolveRuntimeDatabaseUrl({
        LAUNDRY_USE_LOCAL_PG: "1",
        DATABASE_ADMIN_URL: "postgresql://owner:secret@db.example.test/laundry",
      }),
    /Runtime requires an explicit database URL for the laundry_app role/u,
  );

  const appUrl = "postgresql://laundry_app:other@127.0.0.1:8543/laundry_v2";
  assert.equal(
    resolveRuntimeDatabaseUrl({
      LAUNDRY_USE_LOCAL_PG: "true",
      LAUNDRY_PG_APP_URL: appUrl,
      DATABASE_ADMIN_URL: "postgresql://owner:secret@db.example.test/laundry",
    }),
    appUrl,
  );
});

test("opt-in PG integration requires explicit and separate app/admin URLs", () => {
  const appUrl = "postgresql://laundry_app:app-test@127.0.0.1:8543/laundry_v2";
  const adminUrl = "postgresql://postgres:admin-test@127.0.0.1:8543/laundry_v2";

  assert.throws(
    () => resolvePgUrls({ LAUNDRY_USE_LOCAL_PG: "1" }),
    /requires explicit app and admin database URLs/u,
  );
  assert.throws(
    () =>
      resolvePgUrls({
        LAUNDRY_USE_LOCAL_PG: "1",
        LAUNDRY_PG_APP_URL: appUrl,
      }),
    /requires explicit app and admin database URLs/u,
  );
  assert.throws(
    () =>
      resolvePgUrls({
        LAUNDRY_USE_LOCAL_PG: "1",
        LAUNDRY_PG_APP_URL: appUrl,
        DATABASE_ADMIN_URL: appUrl,
      }),
    /must use distinct app and admin database URLs/u,
  );
  assert.deepEqual(
    resolvePgUrls({
      LAUNDRY_USE_LOCAL_PG: "1",
      LAUNDRY_PG_APP_URL: appUrl,
      DATABASE_ADMIN_URL: adminUrl,
    }),
    { app: appUrl, admin: adminUrl },
  );
});
