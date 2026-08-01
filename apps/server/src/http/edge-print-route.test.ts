import assert from "node:assert/strict";
import test from "node:test";

import type { FastifyInstance } from "fastify";

import { CSRF_HEADER_NAME } from "@laundry/contracts";

import { createMemoryLocalRuntime, DEMO_PASSWORD } from "../local/demo-seed.js";
import type { PrintDispatchService } from "../print/dispatch-service.js";
import { createLocalApp } from "./create-app.js";
import { resolveCookiePolicy } from "./cookie-policy.js";
import { createEdgePrintRateLimiter } from "./edge-print-rate-limit.js";
import { LOCAL_COOKIE_NAMES } from "./types.js";

const DEVICE_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const JOB_ID = "11111111-1111-4111-8111-111111111111";
const localCookies = resolveCookiePolicy({ secure: false });
const browserHeaders = Object.freeze({
  host: "127.0.0.1:8787",
  origin: "http://127.0.0.1:5173",
  "sec-fetch-site": "same-site",
});
const desktopHeaders = Object.freeze({
  host: "127.0.0.1:8787",
  origin: "http://127.0.0.1:8787",
  "sec-fetch-site": "same-origin",
});

function parseSetCookie(headers: Record<string, unknown>): Record<string, string> {
  const raw = headers["set-cookie"];
  const lines = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  return Object.fromEntries(
    lines.flatMap((line) => {
      const pair = line.split(";", 1)[0];
      if (pair === undefined) return [];
      const separator = pair.indexOf("=");
      return separator > 0 ? [[pair.slice(0, separator), pair.slice(separator + 1)]] : [];
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
  const cookies = parseSetCookie(response.headers as Record<string, unknown>);
  const csrf = cookies[LOCAL_COOKIE_NAMES.csrf];
  assert.ok(csrf);
  return Object.freeze({
    accessToken: (response.json() as { data: { access_token: string } }).data.access_token,
    csrf,
    cookie: Object.entries(cookies)
      .map(([name, value]) => `${name}=${value}`)
      .join("; "),
  });
}

function authorizedHeaders(
  auth: Awaited<ReturnType<typeof login>>,
  surface: "desktop" | "browser" = "desktop",
) {
  return Object.freeze({
    ...(surface === "desktop" ? desktopHeaders : browserHeaders),
    authorization: `Bearer ${auth.accessToken}`,
    cookie: auth.cookie,
    [CSRF_HEADER_NAME]: auth.csrf,
  });
}

async function buildApp(service: PrintDispatchService, options: Readonly<{ limit?: number }> = {}) {
  const base = await createMemoryLocalRuntime();
  const runtime = Object.freeze({ ...base, printDispatch: service });
  return createLocalApp({
    runtime,
    cookiePolicy: localCookies,
    logger: false,
    edgePrintRateLimiter: createEdgePrintRateLimiter({
      maxRequests: options.limit ?? 20,
      nowMs: () => 1_800_000_000_000,
    }),
  });
}

function service(calls: string[]): PrintDispatchService {
  return Object.freeze({
    claim: async (session) => {
      calls.push(`claim:${session.deviceId}`);
      return null;
    },
    settle: async (session, request) => {
      calls.push(`receipt:${session.deviceId}:${request.receipt.payload.seq}`);
      return Object.freeze({
        job_id: request.receipt.payload.job_id,
        status: "done" as const,
        result: "succeeded" as const,
        cups_job_id: "xp58-42",
        settled_at: "2026-08-01T00:00:00.000Z",
        duplicate: false,
      });
    },
  });
}

test("main-only claim uses session authority and rejects browser or body device authority", async () => {
  const calls: string[] = [];
  const app = await buildApp(service(calls));
  const auth = await login(app);
  const validPayload = { supported_printer_kinds: ["xp58"] };

  const claimed = await app.inject({
    method: "POST",
    url: "/api/v2/edge/print/claim",
    headers: authorizedHeaders(auth),
    payload: validPayload,
  });
  assert.equal(claimed.statusCode, 200, claimed.body);
  assert.deepEqual(claimed.json(), { ok: true, data: null });
  assert.equal(claimed.headers["cache-control"], "no-store");
  assert.deepEqual(calls, [`claim:${DEVICE_ID}`]);

  const browser = await app.inject({
    method: "POST",
    url: "/api/v2/edge/print/claim",
    headers: authorizedHeaders(auth, "browser"),
    payload: validPayload,
  });
  assert.equal(browser.statusCode, 403, browser.body);

  const injectedDevice = await app.inject({
    method: "POST",
    url: "/api/v2/edge/print/claim",
    headers: authorizedHeaders(auth),
    payload: { ...validPayload, device_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" },
  });
  assert.equal(injectedDevice.statusCode, 400, injectedDevice.body);
  assert.deepEqual(calls, [`claim:${DEVICE_ID}`]);

  const forwarded = await app.inject({
    method: "POST",
    url: "/api/v2/edge/print/claim",
    headers: { ...authorizedHeaders(auth), forwarded: "for=127.0.0.1" },
    payload: validPayload,
  });
  assert.equal(forwarded.statusCode, 400, forwarded.body);
  await app.close();
});

test("receipt route is strict, main-only and covered by a dedicated limiter", async () => {
  const calls: string[] = [];
  const app = await buildApp(service(calls), { limit: 1 });
  const auth = await login(app);
  const receipt = {
    receipt: {
      protocol_version: "1.0.0",
      payload: {
        job_id: JOB_ID,
        device_id: DEVICE_ID,
        ticket_nonce: "22222222-2222-4222-8222-222222222222",
        snapshot_sha256: "a".repeat(64),
        result: "succeeded",
        cups_job_id: "xp58-42",
        seq: 1,
        at: "2026-08-01T00:00:00.000Z",
      },
      sig: "A".repeat(86),
    },
  };

  const settled = await app.inject({
    method: "POST",
    url: "/api/v2/edge/print/receipt",
    headers: authorizedHeaders(auth),
    payload: receipt,
  });
  assert.equal(settled.statusCode, 200, settled.body);
  assert.equal((settled.json() as { data: { duplicate: boolean } }).data.duplicate, false);
  assert.deepEqual(calls, [`receipt:${DEVICE_ID}:1`]);

  const limited = await app.inject({
    method: "POST",
    url: "/api/v2/edge/print/receipt",
    headers: authorizedHeaders(auth),
    payload: receipt,
  });
  assert.equal(limited.statusCode, 429, limited.body);
  assert.equal(limited.headers["retry-after"], "60");
  assert.deepEqual(calls, [`receipt:${DEVICE_ID}:1`]);
  await app.close();
});
