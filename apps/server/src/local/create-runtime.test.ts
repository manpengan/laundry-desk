import assert from "node:assert/strict";
import test from "node:test";

import type { PgPool } from "../db/pg-pool.js";
import type { LocalServerConfig } from "./config.js";
import { createLocalRuntime, createPgLocalRuntime } from "./create-runtime.js";

const SERVER_CONFIG = Object.freeze({
  listenHost: "127.0.0.1",
  port: 8787,
  browserOrigin: "http://127.0.0.1:5173",
  hostAuthorities: Object.freeze(["127.0.0.1:8787"] as const),
  accessTokenSecret: "a".repeat(32),
  csrfProofSecret: "b".repeat(32),
}) satisfies LocalServerConfig;

function createPoolDouble(): Readonly<{ pool: PgPool; endCalls: () => number }> {
  let ended = 0;
  const pool = {
    end: async (): Promise<void> => {
      ended += 1;
    },
  } as unknown as PgPool;
  return Object.freeze({ pool, endCalls: () => ended });
}

test("production runtime refuses the process-memory fallback without laundry_app DATABASE_URL", async () => {
  await assert.rejects(
    () => createLocalRuntime({ NODE_ENV: "production" }),
    /Production runtime requires DATABASE_URL for the laundry_app role/u,
  );
});

test("production runtime rejects an admin-only URL instead of using it as the app role", async () => {
  await assert.rejects(
    () =>
      createLocalRuntime({
        NODE_ENV: "production",
        DATABASE_ADMIN_URL: "postgresql://owner:owner@localhost:5432/laundry_v2",
      }),
    /Production runtime requires DATABASE_URL for the laundry_app role/u,
  );
});

test("PG runtime opens one app pool and verifies readiness without an admin connection", async () => {
  const connectionString = "postgresql://laundry_app:secret@localhost:5432/laundry_v2";
  const poolDouble = createPoolDouble();
  const opened: string[] = [];
  const checked: PgPool[] = [];

  const runtime = await createPgLocalRuntime(connectionString, SERVER_CONFIG, {
    createPool: (options) => {
      opened.push(options.connectionString);
      return poolDouble.pool;
    },
    assertReady: async (pool) => {
      checked.push(pool);
    },
  });

  assert.deepEqual(opened, [connectionString]);
  assert.deepEqual(checked, [poolDouble.pool]);
  assert.equal(runtime.pool, poolDouble.pool);
  assert.equal(poolDouble.endCalls(), 0);
});

test("PG runtime closes its only pool when app-role readiness fails", async () => {
  const poolDouble = createPoolDouble();

  await assert.rejects(
    () =>
      createPgLocalRuntime(
        "postgresql://postgres:secret@localhost:5432/laundry_v2",
        SERVER_CONFIG,
        {
          createPool: () => poolDouble.pool,
          assertReady: async () => {
            throw new Error("runtime must connect as laundry_app");
          },
        },
      ),
    /runtime must connect as laundry_app/u,
  );

  assert.equal(poolDouble.endCalls(), 1);
});
