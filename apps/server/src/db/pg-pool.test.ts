import assert from "node:assert/strict";
import test from "node:test";

import { LOCAL_PG_URLS, resolveRuntimeDatabaseUrl } from "./pg-pool.js";

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

test("opt-in local PG runtime uses the app-role URL without consulting admin configuration", () => {
  assert.equal(
    resolveRuntimeDatabaseUrl({
      LAUNDRY_USE_LOCAL_PG: "1",
      DATABASE_ADMIN_URL: "postgresql://owner:secret@db.example.test/laundry",
    }),
    LOCAL_PG_URLS.app,
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
