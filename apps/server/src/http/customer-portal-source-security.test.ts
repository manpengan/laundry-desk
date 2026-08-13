import assert from "node:assert/strict";
import test from "node:test";

import { CUSTOMER_PORTAL_AUTHORITY_HEADER_NAME } from "@laundry/contracts";

import {
  createCustomerPortalLoginTimingGuard,
  type CustomerPortalStore,
} from "../customer-self-service/index.js";
import { createMemoryLocalRuntime } from "../local/demo-seed.js";
import { createLocalApp } from "./create-app.js";
import { resolveCookiePolicy } from "./cookie-policy.js";
import { createLoginRateLimiter } from "./login-rate-limit.js";
import { TRUSTED_PROXY_CLIENT_IP_HEADER_NAME } from "./request-security.js";

const AUTHORITY = `v1.${"a".repeat(43)}`;
const rejectingStore: CustomerPortalStore = Object.freeze({
  async createSession() {
    return null;
  },
  async resolveSession() {
    return null;
  },
  async revokeSession() {
    return false;
  },
  async executeQuery() {
    return null;
  },
  async updateProfile() {
    throw new Error("unreachable");
  },
});

test("Caddy source authority blocks rotating-number spray and rejects spoofed metadata", async () => {
  const app = await createLocalApp({
    runtime: await createMemoryLocalRuntime(),
    cookiePolicy: resolveCookiePolicy({ secure: true }),
    browserOrigin: "https://desk.manpengan.xyz",
    browserFetchSite: "same-origin",
    trustedProxyClientIpRequired: true,
    customerPortalStore: rejectingStore,
    customerPortalLoginTimingGuard: createCustomerPortalLoginTimingGuard({
      minimumResponseMs: 1,
      nowMs: () => 0,
      waitMs: async () => undefined,
    }),
    customerPortalLoginRateLimiter: createLoginRateLimiter({
      account: { maxFailures: 100, windowMs: 60_000, blockMs: 60_000 },
      ip: { maxFailures: 3, windowMs: 60_000, blockMs: 60_000 },
    }),
    logger: false,
  });
  const proxyHeaders = Object.freeze({
    host: "127.0.0.1:8787",
    origin: "https://desk.manpengan.xyz",
    "sec-fetch-site": "same-origin",
    [CUSTOMER_PORTAL_AUTHORITY_HEADER_NAME]: AUTHORITY,
  });
  const attempt = (
    phone: string,
    extraHeaders: Readonly<Record<string, string>> = {},
    remoteAddress?: string,
  ) =>
    app.inject({
      method: "POST",
      url: "/api/v2/customer/auth/login",
      headers: Object.freeze({
        ...proxyHeaders,
        [TRUSTED_PROXY_CLIENT_IP_HEADER_NAME]: "198.51.100.8",
        ...extraHeaders,
      }),
      ...(remoteAddress === undefined ? {} : { remoteAddress }),
      payload: {
        org_code: "local",
        store_code: "main",
        phone,
        pickup_code: "PK-WRONG",
      },
    });

  assert.equal((await attempt("13800000001", { forwarded: "for=198.51.100.8" })).statusCode, 400);
  assert.equal((await attempt("13800000001", { "x-real-ip": "198.51.100.8" })).statusCode, 400);
  assert.equal(
    (
      await attempt("13800000001", {
        [TRUSTED_PROXY_CLIENT_IP_HEADER_NAME]: "198.51.100.8, 203.0.113.9",
      })
    ).statusCode,
    400,
  );
  assert.equal((await attempt("13800000001", {}, "203.0.113.9")).statusCode, 400);
  assert.equal((await attempt("13800000001")).statusCode, 401);
  assert.equal((await attempt("13900000002")).statusCode, 401);
  assert.equal((await attempt("13700000003")).statusCode, 429);
  assert.equal(
    (
      await attempt("13600000004", {
        [TRUSTED_PROXY_CLIENT_IP_HEADER_NAME]: "198.51.100.9",
      })
    ).statusCode,
    401,
  );
  await app.close();
});
