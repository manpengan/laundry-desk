import assert from "node:assert/strict";
import test from "node:test";
import type { FastifyInstance } from "fastify";

import { CSRF_HEADER_NAME } from "@laundry/contracts";

import {
  createMemoryLocalRuntime,
  DEMO_PASSWORD,
  DEMO_PIN,
  type LocalRuntime,
} from "../local/demo-seed.js";
import type { StoreFeatureFlags } from "../platform/features.js";
import { resolveCookiePolicy } from "./cookie-policy.js";
import { createLocalApp } from "./create-app.js";
import { LOCAL_COOKIE_NAMES } from "./types.js";

const DEVICE_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const cookies = resolveCookiePolicy({ secure: false });
const browserMutationHeaders = Object.freeze({
  host: "127.0.0.1:8787",
  origin: "http://127.0.0.1:5173",
  "sec-fetch-site": "same-site",
});

function parseSetCookie(headers: Record<string, unknown>): Readonly<Record<string, string>> {
  const raw = headers["set-cookie"];
  const lines = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  return Object.freeze(
    Object.fromEntries(
      lines.flatMap((line) => {
        const pair = line.split(";", 1)[0];
        if (pair === undefined) return [];
        const separator = pair.indexOf("=");
        return separator > 0 ? [[pair.slice(0, separator), pair.slice(separator + 1)]] : [];
      }),
    ),
  );
}

function cookieHeader(values: Readonly<Record<string, string>>): string {
  return Object.entries(values)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

function withFailingProjection(runtime: LocalRuntime, message: string): LocalRuntime {
  return Object.freeze({
    ...runtime,
    platform: Object.freeze({
      ...runtime.platform,
      features: Object.freeze({
        async get(): Promise<StoreFeatureFlags> {
          throw new Error(message);
        },
      }),
    }),
  });
}

function withInvalidAccessTokenSigner(runtime: LocalRuntime): LocalRuntime {
  return Object.freeze({
    ...runtime,
    identity: Object.freeze({
      ...runtime.identity,
      sessions: Object.freeze({
        ...runtime.identity.sessions,
        accessTokenSigner: Object.freeze({
          ...runtime.identity.sessions.accessTokenSigner,
          sign: () => "invalid-access-token",
        }),
      }),
    }),
  });
}

async function login(app: FastifyInstance) {
  return app.inject({
    method: "POST",
    url: "/api/v2/auth/login",
    headers: browserMutationHeaders,
    payload: {
      org_code: "local",
      store_code: "main",
      username: "admin",
      password: DEMO_PASSWORD,
      device_id: DEVICE_ID,
    },
  });
}

test("login projection failure creates no identity state or cookies", async () => {
  const runtime = await createMemoryLocalRuntime();
  assert.ok(runtime.store);
  const sentinel = "projection-login-secret";
  const app = await createLocalApp({
    runtime: withFailingProjection(runtime, sentinel),
    cookiePolicy: cookies,
    logger: false,
  });

  const response = await login(app);

  assert.equal(response.statusCode, 500);
  assert.equal(response.headers["set-cookie"], undefined);
  assert.doesNotMatch(response.body, new RegExp(sentinel, "u"));
  assert.deepEqual(runtime.store.listSessions(), []);
  assert.deepEqual(runtime.store.listFamilies(), []);
  assert.deepEqual(runtime.store.listTokens(), []);
  await app.close();
});

test("login response validation precedes cookies and settles its limiter reservation once", async () => {
  const runtime = await createMemoryLocalRuntime();
  const settlements: string[] = [];
  const app = await createLocalApp({
    runtime: withInvalidAccessTokenSigner(runtime),
    cookiePolicy: cookies,
    loginRateLimiter: Object.freeze({
      beginAttempt: () =>
        Object.freeze({
          allowed: true as const,
          reservation: Object.freeze({
            succeed: () => settlements.push("succeed"),
            fail: () => {
              settlements.push("fail");
              return Object.freeze({ allowed: true as const });
            },
            release: () => settlements.push("release"),
          }),
        }),
    }),
    logger: false,
  });

  const response = await login(app);

  assert.equal(response.statusCode, 500, response.body);
  assert.equal(response.headers["set-cookie"], undefined);
  assert.deepEqual(settlements, ["release"]);
  await app.close();
});

test("refresh projection failure leaves the active secret retryable", async () => {
  const runtime = await createMemoryLocalRuntime();
  assert.ok(runtime.store);
  const healthyApp = await createLocalApp({ runtime, cookiePolicy: cookies, logger: false });
  const loginResponse = await login(healthyApp);
  assert.equal(loginResponse.statusCode, 200, loginResponse.body);
  const authCookies = parseSetCookie(loginResponse.headers as Record<string, unknown>);
  const failingApp = await createLocalApp({
    runtime: withFailingProjection(runtime, "projection-refresh-secret"),
    cookiePolicy: cookies,
    logger: false,
  });

  const failed = await failingApp.inject({
    method: "POST",
    url: "/api/v2/auth/refresh",
    headers: {
      ...browserMutationHeaders,
      cookie: cookieHeader(authCookies),
      [CSRF_HEADER_NAME]: authCookies[LOCAL_COOKIE_NAMES.csrf] ?? "",
    },
    payload: {},
  });

  assert.equal(failed.statusCode, 500);
  assert.equal(failed.headers["set-cookie"], undefined);
  assert.equal(runtime.store.listSessions().filter((row) => row.status === "active").length, 1);
  assert.equal(runtime.store.listFamilies().filter((row) => row.status === "active").length, 1);
  assert.deepEqual(
    runtime.store.listTokens().map((row) => row.status),
    ["active"],
  );

  const retry = await healthyApp.inject({
    method: "POST",
    url: "/api/v2/auth/refresh",
    headers: {
      ...browserMutationHeaders,
      cookie: cookieHeader(authCookies),
      [CSRF_HEADER_NAME]: authCookies[LOCAL_COOKIE_NAMES.csrf] ?? "",
    },
    payload: {},
  });
  assert.equal(retry.statusCode, 200, retry.body);
  await failingApp.close();
  await healthyApp.close();
});

test("refresh response validation precedes replacement cookies", async () => {
  const runtime = await createMemoryLocalRuntime();
  const healthyApp = await createLocalApp({ runtime, cookiePolicy: cookies, logger: false });
  const loginResponse = await login(healthyApp);
  assert.equal(loginResponse.statusCode, 200, loginResponse.body);
  const authCookies = parseSetCookie(loginResponse.headers as Record<string, unknown>);
  const failingApp = await createLocalApp({
    runtime: withInvalidAccessTokenSigner(runtime),
    cookiePolicy: cookies,
    logger: false,
  });

  const failed = await failingApp.inject({
    method: "POST",
    url: "/api/v2/auth/refresh",
    headers: {
      ...browserMutationHeaders,
      cookie: cookieHeader(authCookies),
      [CSRF_HEADER_NAME]: authCookies[LOCAL_COOKIE_NAMES.csrf] ?? "",
    },
    payload: {},
  });

  assert.equal(failed.statusCode, 500, failed.body);
  assert.equal(failed.headers["set-cookie"], undefined);
  await failingApp.close();
  await healthyApp.close();
});

test("quick-switch projection failure does not consume its challenge or session", async () => {
  const runtime = await createMemoryLocalRuntime();
  assert.ok(runtime.store);
  const healthyApp = await createLocalApp({ runtime, cookiePolicy: cookies, logger: false });
  const loginResponse = await login(healthyApp);
  assert.equal(loginResponse.statusCode, 200, loginResponse.body);
  const body = loginResponse.json() as { data: { access_token: string } };
  const authCookies = parseSetCookie(loginResponse.headers as Record<string, unknown>);
  const csrf = authCookies[LOCAL_COOKIE_NAMES.csrf];
  assert.ok(csrf);
  const target = runtime.staffDirectory.find((entry) => entry.username === "staff");
  assert.ok(target);
  const headers = {
    ...browserMutationHeaders,
    authorization: `Bearer ${body.data.access_token}`,
    [CSRF_HEADER_NAME]: csrf,
    cookie: cookieHeader(authCookies),
  };
  const challenge = await healthyApp.inject({
    method: "POST",
    url: "/api/v2/auth/pin/challenges",
    headers,
    payload: { purpose: "quick_switch", target_staff_id: target.staff_id },
  });
  assert.equal(challenge.statusCode, 200, challenge.body);
  const challengeId = (challenge.json() as { data: { challenge_id: string } }).data.challenge_id;
  const failingApp = await createLocalApp({
    runtime: withFailingProjection(runtime, "projection-pin-secret"),
    cookiePolicy: cookies,
    logger: false,
  });

  const failed = await failingApp.inject({
    method: "POST",
    url: `/api/v2/auth/pin/challenges/${challengeId}/verify`,
    headers,
    payload: { challenge_id: challengeId, pin: DEMO_PIN },
  });

  assert.equal(failed.statusCode, 500);
  assert.equal(runtime.store.listChallenges()[0]?.status, "active");
  assert.equal(runtime.store.listSessions().filter((row) => row.status === "active").length, 1);
  assert.deepEqual(
    runtime.store.listTokens().map((row) => row.status),
    ["active"],
  );

  const retry = await healthyApp.inject({
    method: "POST",
    url: `/api/v2/auth/pin/challenges/${challengeId}/verify`,
    headers,
    payload: { challenge_id: challengeId, pin: DEMO_PIN },
  });
  assert.equal(retry.statusCode, 200, retry.body);
  await failingApp.close();
  await healthyApp.close();
});
