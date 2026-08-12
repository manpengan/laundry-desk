import assert from "node:assert/strict";
import test from "node:test";

import type { FastifyInstance } from "fastify";

import {
  CSRF_HEADER_NAME,
  FACTORY_HANDOFF_COMMAND_NAMES,
  FACTORY_HANDOFF_QUERY_NAMES,
} from "@laundry/contracts";

import { createMemoryLocalRuntime, DEMO_PASSWORD } from "../local/demo-seed.js";
import { createLocalApp } from "./create-app.js";
import { resolveCookiePolicy } from "./cookie-policy.js";
import {
  createFactoryOperationRateLimiter,
  type FactoryOperationKind,
  type FactoryOperationRateLimiter,
} from "./factory-operation-rate-limit.js";
import { LOCAL_COOKIE_NAMES } from "./types.js";

const DEVICE_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const SESSION = "11111111-1111-4111-8111-111111111111";
const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STORE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER_STORE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const browserHeaders = Object.freeze({
  host: "127.0.0.1:8787",
  origin: "http://127.0.0.1:5173",
  "sec-fetch-site": "same-site",
});

function cookiesFrom(response: Readonly<{ headers: Readonly<Record<string, unknown>> }>) {
  const raw = response.headers["set-cookie"];
  const lines = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  return Object.fromEntries(
    lines.map((line) => {
      const pair = line.split(";", 1)[0] ?? "";
      const separator = pair.indexOf("=");
      return [pair.slice(0, separator), pair.slice(separator + 1)];
    }),
  );
}

async function login(app: FastifyInstance) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v2/auth/login",
    headers: browserHeaders,
    payload: {
      org_code: "local",
      store_code: "main",
      username: "admin",
      password: DEMO_PASSWORD,
      device_id: DEVICE_ID,
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  const cookies = cookiesFrom(response);
  return Object.freeze({
    authorization: `Bearer ${(response.json() as { data: { access_token: string } }).data.access_token}`,
    cookie: Object.entries(cookies)
      .map(([name, value]) => `${name}=${value}`)
      .join("; "),
    [CSRF_HEADER_NAME]: cookies[LOCAL_COOKIE_NAMES.csrf] ?? "",
  });
}

test("factory operation buckets separate commands, queries, sessions, and stores", () => {
  let now = 10_000;
  const limiter = createFactoryOperationRateLimiter({
    maxCommands: 1,
    maxQueries: 1,
    windowMs: 60_000,
    nowMs: () => now,
  });
  assert.deepEqual(limiter.check("command", SESSION, ORG, STORE), { allowed: true });
  assert.deepEqual(limiter.check("command", SESSION, ORG, STORE), {
    allowed: false,
    retryAfterSeconds: 60,
  });
  assert.deepEqual(limiter.check("query", SESSION, ORG, STORE), { allowed: true });
  assert.deepEqual(limiter.check("command", SESSION, ORG, OTHER_STORE), { allowed: true });
  assert.deepEqual(limiter.check("command", `${SESSION}-other`, ORG, STORE), { allowed: true });
  now += 60_000;
  assert.deepEqual(limiter.check("command", SESSION, ORG, STORE), { allowed: true });
});

test("factory operation limiter bounds dimensions and validates configuration", () => {
  const limiter = createFactoryOperationRateLimiter({
    maxBuckets: 1,
    windowMs: 60_000,
    nowMs: () => 10_000,
  });
  assert.deepEqual(limiter.check("command", SESSION, ORG, STORE), { allowed: true });
  assert.deepEqual(limiter.check("query", SESSION, ORG, STORE), {
    allowed: false,
    retryAfterSeconds: 60,
  });
  assert.throws(
    () => createFactoryOperationRateLimiter({ maxCommands: 0 }),
    /Invalid factory operation rate-limit configuration/u,
  );
});

test("all factory command and query routes pass through the dedicated limiter", async () => {
  const observed: FactoryOperationKind[] = [];
  const limiter: FactoryOperationRateLimiter = Object.freeze({
    check: (kind) => {
      observed.push(kind);
      return Object.freeze({ allowed: true as const });
    },
  });
  const app = await createLocalApp({
    runtime: await createMemoryLocalRuntime(),
    cookiePolicy: resolveCookiePolicy({ secure: false }),
    logger: false,
    factoryOperationRateLimiter: limiter,
  });
  const authorization = await login(app);
  for (const name of FACTORY_HANDOFF_COMMAND_NAMES) {
    await app.inject({
      method: "POST",
      url: `/v1/commands/${name}`,
      headers: Object.freeze({ ...browserHeaders, ...authorization }),
      payload: Object.freeze({}),
    });
  }
  for (const name of FACTORY_HANDOFF_QUERY_NAMES) {
    await app.inject({
      method: "POST",
      url: `/v1/queries/${name}`,
      headers: Object.freeze({ ...browserHeaders, ...authorization }),
      payload: Object.freeze({}),
    });
  }
  assert.deepEqual(observed, [
    ...FACTORY_HANDOFF_COMMAND_NAMES.map(() => "command" as const),
    ...FACTORY_HANDOFF_QUERY_NAMES.map(() => "query" as const),
  ]);
  await app.close();
});

test("HTTP factory writes and reads return 429 with Retry-After at their limits", async () => {
  const app = await createLocalApp({
    runtime: await createMemoryLocalRuntime(),
    cookiePolicy: resolveCookiePolicy({ secure: false }),
    logger: false,
    factoryOperationRateLimiter: createFactoryOperationRateLimiter({
      maxCommands: 1,
      maxQueries: 1,
      nowMs: () => 10_000,
    }),
  });
  const authorization = await login(app);
  const command = Object.freeze({
    method: "POST" as const,
    url: "/v1/commands/fulfillment.batch.create",
    headers: Object.freeze({ ...browserHeaders, ...authorization }),
    payload: Object.freeze({}),
  });
  const query = Object.freeze({
    method: "POST" as const,
    url: "/v1/queries/fulfillment.batches.list",
    headers: Object.freeze({ ...browserHeaders, ...authorization }),
    payload: Object.freeze({}),
  });
  assert.equal((await app.inject(command)).statusCode, 400);
  assert.equal((await app.inject(query)).statusCode, 200);
  for (const request of [command, query]) {
    const limited = await app.inject(request);
    assert.equal(limited.statusCode, 429, limited.body);
    assert.equal(limited.headers["retry-after"], "60");
    assert.deepEqual(limited.json(), {
      ok: false,
      error: { code: "RATE_LIMITED", message: "Too many requests" },
    });
  }
  await app.close();
});
