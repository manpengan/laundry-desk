import assert from "node:assert/strict";
import test from "node:test";

import type { FastifyInstance } from "fastify";

import {
  CSRF_HEADER_NAME,
  MARKETING_COMMAND_NAMES,
  MARKETING_QUERY_NAMES,
} from "@laundry/contracts";

import { createMemoryLocalRuntime, DEMO_PASSWORD } from "../local/demo-seed.js";
import { createLocalApp } from "./create-app.js";
import { resolveCookiePolicy } from "./cookie-policy.js";
import {
  createMarketingOperationRateLimiter,
  type MarketingOperationKind,
  type MarketingOperationRateLimiter,
} from "./marketing-operation-rate-limit.js";
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

test("marketing buckets separate command, query, session and store authority", () => {
  let now = 10_000;
  const limiter = createMarketingOperationRateLimiter({
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

test("marketing limiter bounds cardinality and configuration", () => {
  const limiter = createMarketingOperationRateLimiter({
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
    () => createMarketingOperationRateLimiter({ maxCommands: 0 }),
    /Invalid marketing operation rate-limit configuration/u,
  );
});

test("all two marketing commands and three queries pass the dedicated limiter", async () => {
  const observed: MarketingOperationKind[] = [];
  const limiter: MarketingOperationRateLimiter = Object.freeze({
    check: (kind) => {
      observed.push(kind);
      return Object.freeze({ allowed: true as const });
    },
  });
  const app = await createLocalApp({
    runtime: await createMemoryLocalRuntime(),
    cookiePolicy: resolveCookiePolicy({ secure: false }),
    logger: false,
    marketingOperationRateLimiter: limiter,
  });
  const authorization = await login(app);
  for (const name of MARKETING_COMMAND_NAMES) {
    await app.inject({
      method: "POST",
      url: `/v1/commands/${name}`,
      headers: Object.freeze({ ...browserHeaders, ...authorization }),
      payload: Object.freeze({}),
    });
  }
  for (const name of MARKETING_QUERY_NAMES) {
    await app.inject({
      method: "POST",
      url: `/v1/queries/${name}`,
      headers: Object.freeze({ ...browserHeaders, ...authorization }),
      payload: Object.freeze({}),
    });
  }
  assert.deepEqual(observed, [
    ...MARKETING_COMMAND_NAMES.map(() => "command" as const),
    ...MARKETING_QUERY_NAMES.map(() => "query" as const),
  ]);
  await app.close();
});

test("marketing routes return 429 with Retry-After before validation, database or bus work", async () => {
  const limiter: MarketingOperationRateLimiter = Object.freeze({
    check: () => Object.freeze({ allowed: false as const, retryAfterSeconds: 37 }),
  });
  const app = await createLocalApp({
    runtime: await createMemoryLocalRuntime(),
    cookiePolicy: resolveCookiePolicy({ secure: false }),
    logger: false,
    marketingOperationRateLimiter: limiter,
  });
  const authorization = await login(app);
  for (const [surface, name] of [
    ["commands", MARKETING_COMMAND_NAMES[0]],
    ["queries", MARKETING_QUERY_NAMES[0]],
  ] as const) {
    const response = await app.inject({
      method: "POST",
      url: `/v1/${surface}/${name}`,
      headers: Object.freeze({ ...browserHeaders, ...authorization }),
      payload: Object.freeze({ invalid_for_marketing_schema: true }),
    });
    assert.equal(response.statusCode, 429, response.body);
    assert.equal(response.headers["retry-after"], "37");
    assert.deepEqual(response.json(), {
      ok: false,
      error: { code: "RATE_LIMITED", message: "Too many requests" },
    });
  }
  await app.close();
});
