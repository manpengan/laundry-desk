import assert from "node:assert/strict";
import test from "node:test";

import type { FastifyInstance } from "fastify";

import { createMemoryLocalRuntime, type LocalRuntime } from "../local/demo-seed.js";
import type { PgPool } from "../db/pg-pool.js";
import {
  startLocalHttpServer,
  type ResourceCleanupFailure,
  type LocalHttpApp,
  type StartLocalHttpDependencies,
} from "./server-lifecycle.js";

const ENV = Object.freeze({
  DATABASE_URL: "postgresql://laundry_app:secret@127.0.0.1:8543/laundry_v2",
  LAUNDRY_LISTEN_HOST: "127.0.0.1",
  LAUNDRY_PORT: "8787",
  LAUNDRY_BROWSER_ORIGIN: "http://127.0.0.1:5173",
});

async function runtimeWithPool(end: () => Promise<void>): Promise<LocalRuntime> {
  const memory = await createMemoryLocalRuntime();
  return Object.freeze({
    ...memory,
    mode: "pg" as const,
    pool: Object.freeze({ end }) as unknown as PgPool,
  });
}

function fakeApp(input: {
  listen?: () => Promise<never | string>;
  close?: () => Promise<void>;
}): LocalHttpApp {
  return Object.freeze({
    listen: input.listen ?? (async () => "http://127.0.0.1:8787"),
    close: input.close ?? (async () => undefined),
  }) as unknown as Pick<FastifyInstance, "listen" | "close">;
}

function dependencies(
  runtime: LocalRuntime,
  createApp: StartLocalHttpDependencies["createApp"],
  reportCleanupFailures: StartLocalHttpDependencies["reportCleanupFailures"] = () => undefined,
): StartLocalHttpDependencies {
  return Object.freeze({
    createRuntime: async () => runtime,
    createApp,
    reportCleanupFailures,
  });
}

test("app construction failure closes an already-created PG pool and preserves the cause", async () => {
  const calls: string[] = [];
  const runtime = await runtimeWithPool(async () => {
    calls.push("pool.end");
  });
  const sentinel = new Error("listen configuration failed");

  await assert.rejects(
    () =>
      startLocalHttpServer(
        ENV,
        dependencies(runtime, async () => {
          throw sentinel;
        }),
      ),
    (error) => error === sentinel,
  );
  assert.deepEqual(calls, ["pool.end"]);
});

test("listen failure closes app and pool even when app cleanup also fails", async () => {
  const calls: string[] = [];
  const runtime = await runtimeWithPool(async () => {
    calls.push("pool.end");
  });
  const sentinel = new Error("address already in use");
  const app = fakeApp({
    listen: async () => {
      throw sentinel;
    },
    close: async () => {
      calls.push("app.close");
      throw new Error("secondary cleanup failure");
    },
  });

  await assert.rejects(
    () =>
      startLocalHttpServer(
        ENV,
        dependencies(runtime, async () => app),
      ),
    (error) => error === sentinel,
  );
  assert.deepEqual(calls, ["app.close", "pool.end"]);
});

test("successful startup returns an explicit shutdown that closes app and pool", async () => {
  const calls: string[] = [];
  const runtime = await runtimeWithPool(async () => {
    calls.push("pool.end");
  });
  const app = fakeApp({
    close: async () => {
      calls.push("app.close");
    },
  });

  const started = await startLocalHttpServer(
    ENV,
    dependencies(runtime, async () => app),
  );
  await started.shutdown();

  assert.equal(started.app, app);
  assert.equal(started.runtime, runtime);
  assert.deepEqual(calls, ["app.close", "pool.end"]);
});

test("shutdown drains Fastify before ending the PostgreSQL pool", async () => {
  const calls: string[] = [];
  let finishAppClose: () => void = () => undefined;
  const appCloseFinished = new Promise<void>((resolve) => {
    finishAppClose = resolve;
  });
  const runtime = await runtimeWithPool(async () => {
    calls.push("pool.end");
  });
  const app = fakeApp({
    close: async () => {
      calls.push("app.close:start");
      await appCloseFinished;
      calls.push("app.close:end");
    },
  });
  const started = await startLocalHttpServer(
    ENV,
    dependencies(runtime, async () => app),
  );

  const shutdown = started.shutdown();
  await Promise.resolve();
  assert.deepEqual(calls, ["app.close:start"]);

  finishAppClose();
  await shutdown;
  assert.deepEqual(calls, ["app.close:start", "app.close:end", "pool.end"]);
});

test("startup cleanup reports every resource failure without replacing the startup cause", async () => {
  const appCleanup = new TypeError("app cleanup failed");
  const poolCleanup = new RangeError("pool cleanup failed");
  const startup = new Error("listen failed");
  const reported: ResourceCleanupFailure[][] = [];
  const runtime = await runtimeWithPool(async () => {
    throw poolCleanup;
  });
  const app = fakeApp({
    listen: async () => {
      throw startup;
    },
    close: async () => {
      throw appCleanup;
    },
  });

  await assert.rejects(
    () =>
      startLocalHttpServer(
        ENV,
        dependencies(
          runtime,
          async () => app,
          (failures) => reported.push([...failures]),
        ),
      ),
    (error) => error === startup,
  );
  assert.deepEqual(reported, [
    [
      { resource: "http", error_type: "TypeError" },
      { resource: "database", error_type: "RangeError" },
    ],
  ]);
});

test("a failing cleanup reporter cannot replace or leak the startup cause", async (t) => {
  const stderr: string[] = [];
  t.mock.method(process.stderr, "write", (chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  });
  const startup = new Error("private startup detail");
  const runtime = await runtimeWithPool(async () => {
    throw new Error("private pool cleanup detail");
  });
  const app = fakeApp({
    listen: async () => {
      throw startup;
    },
  });

  await assert.rejects(
    () =>
      startLocalHttpServer(
        ENV,
        dependencies(
          runtime,
          async () => app,
          () => {
            throw new TypeError("private reporter detail");
          },
        ),
      ),
    (error) => error === startup,
  );
  assert.deepEqual(stderr, ["local cleanup reporter failed: TypeError\n"]);
});

test("shutdown still closes the pool and aggregates both cleanup failures", async () => {
  const calls: string[] = [];
  const appCleanup = new TypeError("app cleanup failed");
  const poolCleanup = new RangeError("pool cleanup failed");
  const runtime = await runtimeWithPool(async () => {
    calls.push("pool.end");
    throw poolCleanup;
  });
  const app = fakeApp({
    close: async () => {
      calls.push("app.close");
      throw appCleanup;
    },
  });
  const started = await startLocalHttpServer(
    ENV,
    dependencies(runtime, async () => app),
  );

  await assert.rejects(
    () => started.shutdown(),
    (error) =>
      error instanceof AggregateError &&
      error.errors[0] === appCleanup &&
      error.errors[1] === poolCleanup,
  );
  assert.deepEqual(calls, ["app.close", "pool.end"]);
});
