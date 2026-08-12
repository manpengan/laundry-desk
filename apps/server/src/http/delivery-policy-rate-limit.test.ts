import assert from "node:assert/strict";
import test from "node:test";

import {
  CSRF_HEADER_NAME,
  DELIVERY_APPOINTMENT_COMMAND_NAMES,
  DELIVERY_APPOINTMENT_QUERY_NAMES,
  DELIVERY_ORDER_COMMAND_NAMES,
  DELIVERY_ORDER_QUERY_NAMES,
  DELIVERY_POLICY_COMMAND_NAMES,
  DELIVERY_POLICY_QUERY_NAMES,
} from "@laundry/contracts";
import type { FastifyInstance } from "fastify";

import { createMemoryLocalRuntime, DEMO_PASSWORD } from "../local/demo-seed.js";
import { createLocalApp } from "./create-app.js";
import { resolveCookiePolicy } from "./cookie-policy.js";
import {
  createDeliveryPolicyRateLimiter,
  type DeliveryPolicyOperationKind,
  type DeliveryPolicyRateLimiter,
} from "./delivery-policy-rate-limit.js";
import { LOCAL_COOKIE_NAMES } from "./types.js";

const DEVICE_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const SESSION = "11111111-1111-4111-8111-111111111111";
const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STORE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
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

test("delivery policy limiter separates commands and queries and bounds buckets", () => {
  const limiter = createDeliveryPolicyRateLimiter({
    maxCommands: 1,
    maxQueries: 1,
    maxBuckets: 2,
    windowMs: 60_000,
    nowMs: () => 10_000,
  });
  assert.deepEqual(limiter.check("command", SESSION, ORG, STORE), { allowed: true });
  assert.deepEqual(limiter.check("command", SESSION, ORG, STORE), {
    allowed: false,
    retryAfterSeconds: 60,
  });
  assert.deepEqual(limiter.check("query", SESSION, ORG, STORE), { allowed: true });
  assert.deepEqual(limiter.check("query", `${SESSION}-other`, ORG, STORE), {
    allowed: false,
    retryAfterSeconds: 60,
  });
  assert.throws(
    () => createDeliveryPolicyRateLimiter({ maxQueries: 0 }),
    /Invalid delivery policy rate-limit configuration/u,
  );
});

test("every delivery policy, appointment and order route passes through the dedicated limiter", async () => {
  const observed: DeliveryPolicyOperationKind[] = [];
  const limiter: DeliveryPolicyRateLimiter = Object.freeze({
    check: (kind) => {
      observed.push(kind);
      return Object.freeze({ allowed: true as const });
    },
  });
  const app = await createLocalApp({
    runtime: await createMemoryLocalRuntime(),
    cookiePolicy: resolveCookiePolicy({ secure: false }),
    logger: false,
    deliveryPolicyRateLimiter: limiter,
  });
  const authorization = await login(app);
  for (const name of DELIVERY_POLICY_COMMAND_NAMES) {
    await app.inject({
      method: "POST",
      url: `/v1/commands/${name}`,
      headers: Object.freeze({ ...browserHeaders, ...authorization }),
      payload: Object.freeze({}),
    });
  }
  for (const name of DELIVERY_POLICY_QUERY_NAMES) {
    const payload =
      name === "delivery.availability.quote"
        ? { direction: "pickup", service_area_code: "north", requested_start_at: 1_800_000_000 }
        : {};
    await app.inject({
      method: "POST",
      url: `/v1/queries/${name}`,
      headers: Object.freeze({ ...browserHeaders, ...authorization }),
      payload,
    });
  }
  for (const name of DELIVERY_APPOINTMENT_COMMAND_NAMES) {
    await app.inject({
      method: "POST",
      url: `/v1/commands/${name}`,
      headers: Object.freeze({ ...browserHeaders, ...authorization }),
      payload: Object.freeze({}),
    });
  }
  for (const name of DELIVERY_APPOINTMENT_QUERY_NAMES) {
    await app.inject({
      method: "POST",
      url: `/v1/queries/${name}`,
      headers: Object.freeze({ ...browserHeaders, ...authorization }),
      payload: Object.freeze({}),
    });
  }
  for (const name of DELIVERY_ORDER_COMMAND_NAMES) {
    await app.inject({
      method: "POST",
      url: `/v1/commands/${name}`,
      headers: Object.freeze({ ...browserHeaders, ...authorization }),
      payload: Object.freeze({}),
    });
  }
  for (const name of DELIVERY_ORDER_QUERY_NAMES) {
    await app.inject({
      method: "POST",
      url: `/v1/queries/${name}`,
      headers: Object.freeze({ ...browserHeaders, ...authorization }),
      payload: Object.freeze({}),
    });
  }
  assert.deepEqual(observed, [
    ...DELIVERY_POLICY_COMMAND_NAMES.map(() => "command" as const),
    ...DELIVERY_POLICY_QUERY_NAMES.map(() => "query" as const),
    ...DELIVERY_APPOINTMENT_COMMAND_NAMES.map(() => "command" as const),
    ...DELIVERY_APPOINTMENT_QUERY_NAMES.map(() => "query" as const),
    ...DELIVERY_ORDER_COMMAND_NAMES.map(() => "command" as const),
    ...DELIVERY_ORDER_QUERY_NAMES.map(() => "query" as const),
  ]);
  await app.close();
});

test("HTTP quote reports delivery-disabled and then rate limits repeated reads", async () => {
  const app = await createLocalApp({
    runtime: await createMemoryLocalRuntime(),
    cookiePolicy: resolveCookiePolicy({ secure: false }),
    logger: false,
    deliveryPolicyRateLimiter: createDeliveryPolicyRateLimiter({
      maxQueries: 1,
      nowMs: () => 10_000,
    }),
  });
  const authorization = await login(app);
  const request = Object.freeze({
    method: "POST" as const,
    url: "/v1/queries/delivery.availability.quote",
    headers: Object.freeze({ ...browserHeaders, ...authorization }),
    payload: Object.freeze({
      direction: "pickup",
      service_area_code: "north",
      requested_start_at: 1_800_000_000,
    }),
  });
  const first = await app.inject(request);
  assert.equal(first.statusCode, 200, first.body);
  const result = first.json() as { data: { result: { quote: { reason: string } } } };
  assert.equal(result.data.result.quote.reason, "delivery_disabled");

  const limited = await app.inject(request);
  assert.equal(limited.statusCode, 429, limited.body);
  assert.equal(limited.headers["retry-after"], "60");
  await app.close();
});
