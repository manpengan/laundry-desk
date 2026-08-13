import assert from "node:assert/strict";
import test from "node:test";

import type { PgPool, PgPoolClient } from "../db/pg-pool.js";
import type { LocalServerConfig } from "./config.js";
import {
  createLocalRuntime,
  createPgLocalRuntime,
  loadPgStaffDirectory,
} from "./create-runtime.js";
import { LOCAL_PROFILE } from "./profile.js";

const SERVER_CONFIG = Object.freeze({
  listenHost: "127.0.0.1",
  port: 8787,
  browserOrigin: "http://127.0.0.1:5173",
  browserFetchSite: "same-site",
  cookieSecure: false,
  hostAuthorities: Object.freeze(["127.0.0.1:8787"] as const),
  trustedProxyClientIpRequired: false,
  accessTokenSecret: "a".repeat(32),
  csrfProofSecret: "b".repeat(32),
}) satisfies LocalServerConfig;

function createPoolDouble(endError?: Error): Readonly<{ pool: PgPool; endCalls: () => number }> {
  let ended = 0;
  const pool = {
    end: async (): Promise<void> => {
      ended += 1;
      if (endError !== undefined) {
        throw endError;
      }
    },
  } as unknown as PgPool;
  return Object.freeze({ pool, endCalls: () => ended });
}

type QueryRecord = Readonly<{ sql: string; values: readonly unknown[] }>;

function createStaffDirectoryPool(
  rows: readonly Record<string, unknown>[],
): Readonly<{ pool: PgPool; queries: QueryRecord[]; released: () => boolean }> {
  const queries: QueryRecord[] = [];
  let didRelease = false;
  const client = {
    query: async (sql: string, values: readonly unknown[] = []) => {
      queries.push(Object.freeze({ sql, values }));
      if (sql.includes("FROM staffs staff")) {
        return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: 0 };
    },
    release: (): void => {
      didRelease = true;
    },
  } as unknown as PgPoolClient;
  const pool = {
    connect: async (): Promise<PgPoolClient> => client,
  } as unknown as PgPool;
  return Object.freeze({ pool, queries, released: () => didRelease });
}

test("PG staff directory reads the active bootstrap administrator under tenant GUCs", async () => {
  const database = createStaffDirectoryPool([
    {
      staff_id: LOCAL_PROFILE.adminStaffId,
      display_name: "真实管理员",
      role: "admin",
      username: "owner",
      privacy_admin: true,
    },
  ]);

  const directory = await loadPgStaffDirectory(database.pool);

  assert.deepEqual(directory, [
    {
      staff_id: LOCAL_PROFILE.adminStaffId,
      display_name: "真实管理员",
      role: "admin",
      username: "owner",
      privacy_admin: true,
    },
  ]);
  assert.equal(Object.isFrozen(directory[0]), true);
  const select = database.queries.find((query) => query.sql.includes("FROM staffs staff"));
  assert.ok(select);
  assert.match(select.sql.trimStart(), /^SELECT\b/u);
  assert.match(select.sql, /staff\.is_active = true/u);
  assert.match(select.sql, /role\.is_active = true/u);
  assert.deepEqual(select.values, [LOCAL_PROFILE.orgId, LOCAL_PROFILE.storeId]);
  assert.ok(database.queries.some((query) => query.sql.includes("app.org_id")));
  assert.ok(database.queries.some((query) => query.sql.includes("app.store_id")));
  assert.equal(database.queries.at(-1)?.sql, "COMMIT");
  assert.equal(database.released(), true);
});

test("PG staff directory derives tenant GUCs and filters from the authenticated session", async () => {
  const scope = Object.freeze({
    orgId: "11111111-1111-4111-8111-111111111111",
    storeId: "22222222-2222-4222-8222-222222222222",
    staffId: "33333333-3333-4333-8333-333333333333",
  });
  const database = createStaffDirectoryPool([
    {
      staff_id: scope.staffId,
      display_name: "分店管理员",
      role: "admin",
      username: "branch-admin",
      privacy_admin: true,
    },
  ]);

  const directory = await loadPgStaffDirectory(database.pool, scope);

  assert.equal(directory[0]?.username, "branch-admin");
  const select = database.queries.find((query) => query.sql.includes("FROM staffs staff"));
  assert.deepEqual(select?.values, [scope.orgId, scope.storeId]);
  assert.ok(
    database.queries.some(
      (query) => query.sql.includes("app.org_id") && query.values[0] === scope.orgId,
    ),
  );
  assert.ok(
    database.queries.some(
      (query) => query.sql.includes("app.store_id") && query.values[0] === scope.storeId,
    ),
  );
  assert.ok(
    database.queries.some(
      (query) => query.sql.includes("app.staff_id") && query.values[0] === scope.staffId,
    ),
  );
});

test("PG staff directory rejects active database roles outside admin and staff", async () => {
  const database = createStaffDirectoryPool([
    {
      staff_id: LOCAL_PROFILE.adminStaffId,
      display_name: "未知角色",
      role: "owner",
      username: "owner",
    },
  ]);

  await assert.rejects(() => loadPgStaffDirectory(database.pool), /role/u);

  assert.equal(database.queries.at(-1)?.sql, "ROLLBACK");
  assert.equal(database.released(), true);
});

test("PG staff directory validates database identity fields", async (t) => {
  const validRow = Object.freeze({
    staff_id: LOCAL_PROFILE.adminStaffId,
    display_name: "真实管理员",
    role: "admin",
    username: "owner",
    privacy_admin: true,
  });
  for (const [name, override, expectedField] of [
    ["invalid staff id", { staff_id: "not-a-uuid" }, "staff_id"],
    ["empty display name", { display_name: "" }, "display_name"],
    ["empty username", { username: "" }, "username"],
  ] as const) {
    await t.test(name, async () => {
      const database = createStaffDirectoryPool([
        {
          ...validRow,
          ...override,
        },
      ]);

      await assert.rejects(
        () => loadPgStaffDirectory(database.pool),
        new RegExp(expectedField, "u"),
      );

      assert.equal(database.queries.at(-1)?.sql, "ROLLBACK");
      assert.equal(database.released(), true);
    });
  }
});

test("PG staff directory rejects unexpected database fields", async () => {
  const database = createStaffDirectoryPool([
    {
      staff_id: LOCAL_PROFILE.adminStaffId,
      display_name: "真实管理员",
      role: "admin",
      username: "owner",
      unexpected_secret: "must-not-flow-to-http",
    },
  ]);

  await assert.rejects(() => loadPgStaffDirectory(database.pool), /Unrecognized key/u);

  assert.equal(database.queries.at(-1)?.sql, "ROLLBACK");
  assert.equal(database.released(), true);
});

test("runtime refuses the process-memory fallback without laundry_app DATABASE_URL", async () => {
  await assert.rejects(
    () => createLocalRuntime({}),
    /Runtime requires an explicit database URL for the laundry_app role/u,
  );
});

test("runtime rejects local-PG defaults without an explicit DATABASE_URL", async () => {
  await assert.rejects(
    () =>
      createLocalRuntime({
        LAUNDRY_USE_LOCAL_PG: "1",
      }),
    /Runtime requires an explicit database URL for the laundry_app role/u,
  );
});

test("runtime rejects an admin-only URL instead of using it as the app role", async () => {
  await assert.rejects(
    () =>
      createLocalRuntime({
        DATABASE_ADMIN_URL: "postgresql://owner:owner@localhost:5432/laundry_v2",
      }),
    /Runtime requires an explicit database URL for the laundry_app role/u,
  );
});

test("PG runtime opens one app pool and verifies readiness without an admin connection", async () => {
  const connectionString = "postgresql://laundry_app:secret@localhost:5432/laundry_v2";
  const poolDouble = createPoolDouble();
  const opened: string[] = [];
  const lifecycle: string[] = [];
  const loadedDirectory = [
    {
      staff_id: "11111111-1111-4111-8111-111111111111",
      display_name: "真实管理员",
      role: "admin" as const,
      username: "owner",
      privacy_admin: true,
    },
  ];

  const runtime = await createPgLocalRuntime(connectionString, false, SERVER_CONFIG, {
    createPool: (options) => {
      opened.push(options.connectionString);
      return poolDouble.pool;
    },
    assertReady: async (pool, expectedDemoOnly) => {
      assert.equal(pool, poolDouble.pool);
      assert.equal(expectedDemoOnly, false);
      lifecycle.push("ready");
    },
    loadStaffDirectory: async (pool) => {
      assert.equal(pool, poolDouble.pool);
      lifecycle.push("directory");
      return loadedDirectory;
    },
  });

  assert.deepEqual(opened, [connectionString]);
  assert.deepEqual(lifecycle, ["ready", "directory"]);
  assert.equal(runtime.pool, poolDouble.pool);
  assert.deepEqual(runtime.staffDirectory, loadedDirectory);
  assert.equal(runtime.identity.sessions.csrfProofMinter, runtime.csrfProofSigner);
  assert.notEqual(runtime.printDispatch, null);
  assert.equal("worker" in runtime.print, false, "production must not auto-start mock printing");
  assert.equal(runtime.notification.delivery, undefined);
  assert.equal(runtime.notification.worker, undefined);
  assert.equal("csrfProofSecret" in runtime, false);
  assert.notEqual(runtime.staffDirectory, loadedDirectory);
  assert.equal(Object.isFrozen(runtime.staffDirectory), true);
  assert.equal(Object.isFrozen(runtime.staffDirectory[0]), true);
  assert.equal(poolDouble.endCalls(), 0);
});

test("PG runtime starts no-network notification support only in explicit software mode", async () => {
  const poolDouble = createPoolDouble();
  const runtime = await createPgLocalRuntime(
    "postgresql://laundry_app:secret@localhost:5432/laundry_v2",
    false,
    SERVER_CONFIG,
    {
      createPool: () => poolDouble.pool,
      assertReady: async () => undefined,
      loadStaffDirectory: async () => [
        {
          staff_id: LOCAL_PROFILE.adminStaffId,
          display_name: "管理员",
          role: "admin",
          username: "owner",
          privacy_admin: true,
        },
      ],
    },
    { LAUNDRY_NOTIFICATION_PROVIDER_MODE: "software_only" },
  );

  assert.equal(runtime.notification.delivery?.capability.state, "software_only");
  assert.equal(runtime.notification.delivery?.capability.provider_code, "software_only_fake");
  assert.equal(runtime.notification.worker?.status().state, "stopped");
  assert.equal(runtime.notification.worker?.status().assurance, "software_only");
});

test("PG runtime rejects an unknown notification provider before opening the pool", async () => {
  let opened = 0;
  await assert.rejects(
    () =>
      createPgLocalRuntime(
        "postgresql://laundry_app:secret@localhost:5432/laundry_v2",
        false,
        SERVER_CONFIG,
        {
          createPool: () => {
            opened += 1;
            return createPoolDouble().pool;
          },
          assertReady: async () => undefined,
          loadStaffDirectory: async () => [],
        },
        { LAUNDRY_NOTIFICATION_PROVIDER_MODE: "external" },
      ),
    /LAUNDRY_NOTIFICATION_PROVIDER_MODE/u,
  );
  assert.equal(opened, 0);
});

test("PG runtime closes its only pool when app-role readiness fails", async () => {
  const poolDouble = createPoolDouble();

  await assert.rejects(
    () =>
      createPgLocalRuntime(
        "postgresql://postgres:secret@localhost:5432/laundry_v2",
        false,
        SERVER_CONFIG,
        {
          createPool: () => poolDouble.pool,
          assertReady: async () => {
            throw new Error("runtime must connect as laundry_app");
          },
          loadStaffDirectory: async () => {
            throw new Error("directory load must not run before readiness");
          },
        },
      ),
    /runtime must connect as laundry_app/u,
  );

  assert.equal(poolDouble.endCalls(), 1);
});

test("PG runtime closes its only pool and preserves a staff-directory load failure", async () => {
  const poolDouble = createPoolDouble();
  const directoryError = new Error("staff directory unavailable");

  await assert.rejects(
    () =>
      createPgLocalRuntime(
        "postgresql://laundry_app:secret@localhost:5432/laundry_v2",
        false,
        SERVER_CONFIG,
        {
          createPool: () => poolDouble.pool,
          assertReady: async () => undefined,
          loadStaffDirectory: async () => {
            throw directoryError;
          },
        },
      ),
    (error) => error === directoryError,
  );

  assert.equal(poolDouble.endCalls(), 1);
});

test("PG runtime retains the initialization cause when pool cleanup also fails", async () => {
  const cleanupError = new Error("pool cleanup failed");
  const poolDouble = createPoolDouble(cleanupError);
  const directoryError = new Error("staff directory unavailable");

  await assert.rejects(
    () =>
      createPgLocalRuntime(
        "postgresql://laundry_app:secret@localhost:5432/laundry_v2",
        false,
        SERVER_CONFIG,
        {
          createPool: () => poolDouble.pool,
          assertReady: async () => undefined,
          loadStaffDirectory: async () => {
            throw directoryError;
          },
        },
      ),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.cause, directoryError);
      assert.deepEqual(error.errors, [directoryError, cleanupError]);
      return true;
    },
  );

  assert.equal(poolDouble.endCalls(), 1);
});
