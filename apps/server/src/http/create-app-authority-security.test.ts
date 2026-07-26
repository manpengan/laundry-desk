import assert from "node:assert/strict";
import test from "node:test";

import type { FastifyInstance } from "fastify";

import { AccessSessionResponseSchema, CSRF_HEADER_NAME } from "@laundry/contracts";

import type { StaffRecord } from "../identity/types.js";
import { createMemoryLocalRuntime, DEMO_PASSWORD } from "../local/demo-seed.js";
import { createLocalApp } from "./create-app.js";
import { resolveCookiePolicy } from "./cookie-policy.js";
import { LOCAL_COOKIE_NAMES } from "./types.js";

const DEVICE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const OTHER_ORG_ID = "77777777-7777-4777-8777-777777777777";
const OTHER_SESSION_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const localCookies = resolveCookiePolicy({ secure: false });
const localHostHeaders = Object.freeze({ host: "127.0.0.1:8787" });
const browserMutationHeaders = Object.freeze({
  ...localHostHeaders,
  origin: "http://127.0.0.1:5173",
  "sec-fetch-site": "same-site",
});

async function buildApp() {
  const runtime = await createMemoryLocalRuntime();
  const app = await createLocalApp({ runtime, cookiePolicy: localCookies, logger: false });
  return { app, runtime };
}

function parseSetCookie(headers: Record<string, unknown>): Record<string, string> {
  const raw = headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  return Object.fromEntries(
    list.flatMap((line) => {
      const pair = line.split(";", 1)[0];
      if (pair === undefined) return [];
      const separator = pair.indexOf("=");
      return separator > 0 ? [[pair.slice(0, separator), pair.slice(separator + 1)]] : [];
    }),
  );
}

async function loginAdmin(app: FastifyInstance): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v2/auth/login",
    headers: browserMutationHeaders,
    payload: {
      org_code: "local",
      store_code: "main",
      username: "admin",
      password: DEMO_PASSWORD,
      device_id: DEVICE,
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  return (response.json() as { data: { access_token: string } }).data.access_token;
}

async function assertBearerDeniedAcrossProtectedRoutes(
  app: FastifyInstance,
  accessToken: string,
  extraHeaders: Readonly<Record<string, string>>,
): Promise<void> {
  const protectedRequests = [
    { label: "staff directory", method: "GET" as const, url: "/api/v2/local/staff" },
    {
      label: "command",
      method: "POST" as const,
      url: "/v1/commands/platform.settings.set",
      payload: {},
    },
    {
      label: "query",
      method: "POST" as const,
      url: "/v1/queries/platform.audit.list",
      payload: {},
    },
    {
      label: "PIN challenge",
      method: "POST" as const,
      url: "/api/v2/auth/pin/challenges",
      payload: {},
    },
    {
      label: "PIN verify",
      method: "POST" as const,
      url: `/api/v2/auth/pin/challenges/${OTHER_SESSION_ID}/verify`,
      payload: {},
    },
  ] as const;

  for (const protectedRequest of protectedRequests) {
    const response = await app.inject({
      ...protectedRequest,
      headers: {
        ...(protectedRequest.method === "POST" ? browserMutationHeaders : localHostHeaders),
        ...extraHeaders,
        authorization: `Bearer ${accessToken}`,
      },
    });
    assert.equal(response.statusCode, 401, `${protectedRequest.label}: ${response.body}`);
    const body = response.json() as { ok?: boolean; error?: { code?: string } };
    assert.equal(body.ok, false, protectedRequest.label);
    assert.equal(body.error?.code, "AUTHENTICATION_FAILED", protectedRequest.label);
  }
}

test("all bearer-protected routes reject tenant authority headers from the real request", async () => {
  const { app } = await buildApp();
  const accessToken = await loginAdmin(app);
  await assertBearerDeniedAcrossProtectedRoutes(
    app,
    accessToken,
    Object.freeze({ "x-org-id": OTHER_ORG_ID }),
  );
  await app.close();
});

test("protected routes sanitize live-authority failures and logout still clears cookies", async () => {
  const { app: healthyApp, runtime } = await buildApp();
  const login = await healthyApp.inject({
    method: "POST",
    url: "/api/v2/auth/login",
    headers: browserMutationHeaders,
    payload: {
      org_code: "local",
      store_code: "main",
      username: "admin",
      password: DEMO_PASSWORD,
      device_id: DEVICE,
    },
  });
  assert.equal(login.statusCode, 200, login.body);
  const access = AccessSessionResponseSchema.parse((login.json() as { data: unknown }).data);
  const authCookies = parseSetCookie(login.headers as Record<string, unknown>);
  const authCookieHeader = Object.entries(authCookies)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
  const sentinel = "authority-db-password=TOPSECRET";
  const failingRuntime = Object.freeze({
    ...runtime,
    identity: Object.freeze({
      ...runtime.identity,
      sessions: Object.freeze({
        ...runtime.identity.sessions,
        lifecycle: Object.freeze({
          ...runtime.identity.sessions.lifecycle,
          async revokeSessionFamily(): Promise<never> {
            throw new Error(sentinel);
          },
        }),
      }),
      login: Object.freeze({
        ...runtime.identity.login,
        staff: Object.freeze({
          ...runtime.identity.login.staff,
          async findById(): Promise<StaffRecord | null> {
            throw new Error(sentinel);
          },
        }),
      }),
    }),
  });
  const failingApp = await createLocalApp({
    runtime: failingRuntime,
    cookiePolicy: localCookies,
    logger: false,
  });
  for (const request of [
    {
      label: "PIN challenge",
      method: "POST" as const,
      url: "/api/v2/auth/pin/challenges",
      payload: {},
    },
    {
      label: "command",
      method: "POST" as const,
      url: "/v1/commands/platform.settings.set",
      payload: {},
    },
    {
      label: "query",
      method: "POST" as const,
      url: "/v1/queries/platform.audit.list",
      payload: {},
    },
  ]) {
    const response = await failingApp.inject({
      ...request,
      headers: {
        ...browserMutationHeaders,
        authorization: `Bearer ${access.access_token}`,
      },
    });
    assert.equal(response.statusCode, 500, `${request.label}: ${response.body}`);
    assert.equal(
      (response.json() as { error?: { code?: string } }).error?.code,
      "TRANSACTION_FAILED",
    );
    assert.doesNotMatch(response.body, new RegExp(sentinel, "u"));
  }

  const logout = await failingApp.inject({
    method: "POST",
    url: "/api/v2/auth/logout",
    headers: {
      ...browserMutationHeaders,
      authorization: `Bearer ${access.access_token}`,
      cookie: authCookieHeader,
      [CSRF_HEADER_NAME]: authCookies[LOCAL_COOKIE_NAMES.csrf] ?? "",
    },
    payload: {},
  });
  assert.equal(logout.statusCode, 500, logout.body);
  assert.equal((logout.json() as { error?: { code?: string } }).error?.code, "TRANSACTION_FAILED");
  assert.doesNotMatch(logout.body, new RegExp(sentinel, "u"));
  assert.ok(logout.headers["set-cookie"], "logout must clear browser cookies on failure");

  await failingApp.close();
  await healthyApp.close();
});
