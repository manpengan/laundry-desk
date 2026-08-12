import assert from "node:assert/strict";
import test from "node:test";

import type { FastifyInstance } from "fastify";

import { CSRF_HEADER_NAME } from "@laundry/contracts";

import { createMemoryLocalRuntime, DEMO_PASSWORD } from "../local/demo-seed.js";
import { createLocalApp } from "./create-app.js";
import { resolveCookiePolicy } from "./cookie-policy.js";
import { createNotificationCommandRateLimiter } from "./notification-command-rate-limit.js";
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

test("notification command buckets are session/store scoped and recover after the window", () => {
  let now = 10_000;
  const limiter = createNotificationCommandRateLimiter({
    maxRequests: 1,
    windowMs: 60_000,
    nowMs: () => now,
  });
  assert.deepEqual(limiter.check(SESSION, ORG, STORE), { allowed: true });
  assert.deepEqual(limiter.check(SESSION, ORG, STORE), {
    allowed: false,
    retryAfterSeconds: 60,
  });
  assert.deepEqual(limiter.check(SESSION, ORG, OTHER_STORE), { allowed: true });
  now += 60_000;
  assert.deepEqual(limiter.check(SESSION, ORG, STORE), { allowed: true });
});

test("notification command limiter bounds dimensions and validates configuration", () => {
  let now = 10_000;
  const limiter = createNotificationCommandRateLimiter({
    maxBuckets: 1,
    windowMs: 60_000,
    nowMs: () => now,
  });
  assert.deepEqual(limiter.check(SESSION, ORG, STORE), { allowed: true });
  assert.deepEqual(limiter.check(`${SESSION}-other`, ORG, STORE), {
    allowed: false,
    retryAfterSeconds: 60,
  });
  now += 60_000;
  assert.deepEqual(limiter.check(`${SESSION}-other`, ORG, STORE), { allowed: true });
  assert.throws(
    () => createNotificationCommandRateLimiter({ maxRequests: 0 }),
    /Invalid notification command rate-limit configuration/u,
  );
});

test("HTTP notification enqueue is rate limited before repeated command work", async () => {
  const app = await createLocalApp({
    runtime: await createMemoryLocalRuntime(),
    cookiePolicy: resolveCookiePolicy({ secure: false }),
    logger: false,
    notificationCommandRateLimiter: createNotificationCommandRateLimiter({
      maxRequests: 1,
      nowMs: () => 10_000,
    }),
  });
  const authorization = await login(app);
  const request = Object.freeze({
    method: "POST" as const,
    url: "/v1/commands/notification.delivery_batch.enqueue",
    headers: Object.freeze({ ...browserHeaders, ...authorization }),
    payload: Object.freeze({}),
  });
  const first = await app.inject(request);
  assert.equal(first.statusCode, 400, first.body);
  const limited = await app.inject(request);
  assert.equal(limited.statusCode, 429, limited.body);
  assert.equal(limited.headers["retry-after"], "60");
  assert.deepEqual(limited.json(), {
    ok: false,
    error: { code: "RATE_LIMITED", message: "Too many requests" },
  });
  await app.close();
});
