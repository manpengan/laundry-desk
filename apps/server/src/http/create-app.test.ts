/**
 * Local Fastify inject tests — no real listen / no Postgres.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { CSRF_HEADER_NAME } from "@laundry/contracts";

import { createLocalApp } from "./create-app.js";
import { createMemoryLocalRuntime, DEMO_PASSWORD, DEMO_PIN } from "../local/demo-seed.js";
import { resolveCookiePolicy } from "./cookie-policy.js";
import { LOCAL_COOKIE_NAMES } from "./types.js";

const DEVICE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const localCookies = resolveCookiePolicy({ secure: false });

async function buildApp() {
  // Inject tests must stay offline — force memory even if DATABASE_URL is set.
  const runtime = await createMemoryLocalRuntime();
  const app = await createLocalApp({ runtime, cookiePolicy: localCookies });
  return { app, runtime };
}

function parseSetCookie(headers: Record<string, unknown>): Record<string, string> {
  const raw = headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  const out: Record<string, string> = {};
  for (const line of list) {
    const [pair] = line.split(";");
    if (pair === undefined) continue;
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

test("GET /health returns ok local-memory", async () => {
  const { app } = await buildApp();
  const res = await app.inject({ method: "GET", url: "/health" });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { ok: boolean; data: { mode: string } };
  assert.equal(body.ok, true);
  assert.equal(body.data.mode, "local-memory");
  await app.close();
});

test("POST /api/v2/auth/login succeeds with demo credentials and sets cookies", async () => {
  const { app } = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/v2/auth/login",
    payload: {
      org_code: "hongfa",
      store_code: "main",
      username: "admin",
      password: DEMO_PASSWORD,
      device_id: DEVICE,
    },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as {
    ok: boolean;
    data: { access_token: string; storage: string; session: { staff_id: string } };
  };
  assert.equal(body.ok, true);
  assert.equal(body.data.storage, "memory_only");
  assert.ok(body.data.access_token.length > 10);
  const cookies = parseSetCookie(res.headers as Record<string, unknown>);
  assert.ok(cookies[LOCAL_COOKIE_NAMES.refresh]);
  assert.ok(cookies[LOCAL_COOKIE_NAMES.csrf]);
  assert.equal(LOCAL_COOKIE_NAMES.refresh, "laundry_refresh");
  assert.equal(LOCAL_COOKIE_NAMES.csrf, "laundry_csrf");
  // Set-Cookie lines should advertise SameSite=Strict (contracts alignment)
  const raw = res.headers["set-cookie"];
  const lines = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  assert.ok(lines.some((line) => /SameSite=Strict/i.test(line)));
  await app.close();
});

test("POST /api/v2/auth/login rejects bad password", async () => {
  const { app } = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/v2/auth/login",
    payload: {
      org_code: "hongfa",
      store_code: "main",
      username: "admin",
      password: "wrong",
      device_id: DEVICE,
    },
  });
  assert.equal(res.statusCode, 401);
  const body = res.json() as { ok: boolean };
  assert.equal(body.ok, false);
  await app.close();
});

test("authenticated command path requires bearer", async () => {
  const { app } = await buildApp();
  const denied = await app.inject({
    method: "POST",
    url: "/v1/commands/platform.settings.set",
    payload: { key: "pricing.min_order_cents", value: 100 },
  });
  assert.equal(denied.statusCode, 401);

  const login = await app.inject({
    method: "POST",
    url: "/api/v2/auth/login",
    payload: {
      org_code: "hongfa",
      store_code: "main",
      username: "admin",
      password: DEMO_PASSWORD,
      device_id: DEVICE,
    },
  });
  const loginBody = login.json() as { data: { access_token: string } };
  const cmd = await app.inject({
    method: "POST",
    url: "/v1/commands/platform.settings.set",
    headers: { authorization: `Bearer ${loginBody.data.access_token}` },
    payload: {
      entries: [{ key: "pricing.min_order_cents", value_json: "100" }],
    },
  });
  // R5 settings require step-up — direct execute is blocked.
  assert.equal(cmd.statusCode, 403, cmd.body);
  const cmdBody = cmd.json() as {
    ok: boolean;
    error: { code: string; detail?: { kind: string; confirm_ref?: string } };
  };
  assert.equal(cmdBody.ok, false);
  assert.equal(cmdBody.error.code, "POLICY_STEP_UP_REQUIRED");
  assert.equal(cmdBody.error.detail?.kind, "confirmation");
  assert.ok(cmdBody.error.detail?.confirm_ref);
  await app.close();
});

test("health reports platform persistence mode", async () => {
  const { app } = await buildApp();
  const res = await app.inject({ method: "GET", url: "/health" });
  const body = res.json() as { data: { platform: string; mode: string } };
  assert.equal(body.data.mode, "local-memory");
  assert.equal(body.data.platform, "memory");
  await app.close();
});

test("PIN challenge + verify with CSRF cookies", async () => {
  const { app, runtime } = await buildApp();
  const staffA = runtime.staffDirectory.find((s) => s.username === "staff");
  assert.ok(staffA);

  const login = await app.inject({
    method: "POST",
    url: "/api/v2/auth/login",
    payload: {
      org_code: "hongfa",
      store_code: "main",
      username: "admin",
      password: DEMO_PASSWORD,
      device_id: DEVICE,
    },
  });
  assert.equal(login.statusCode, 200);
  const loginBody = login.json() as { data: { access_token: string } };
  const cookies = parseSetCookie(login.headers as Record<string, unknown>);
  const csrf = cookies[LOCAL_COOKIE_NAMES.csrf] ?? "";
  const cookieHeader = Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");

  const challenge = await app.inject({
    method: "POST",
    url: "/api/v2/auth/pin/challenges",
    headers: {
      authorization: `Bearer ${loginBody.data.access_token}`,
      [CSRF_HEADER_NAME]: csrf,
      cookie: cookieHeader,
    },
    payload: { purpose: "quick_switch", target_staff_id: staffA.staff_id },
  });
  assert.equal(challenge.statusCode, 200, challenge.body);
  const challengeBody = challenge.json() as {
    ok: boolean;
    data: { challenge_id: string };
  };
  assert.equal(challengeBody.ok, true);

  const verify = await app.inject({
    method: "POST",
    url: `/api/v2/auth/pin/challenges/${challengeBody.data.challenge_id}/verify`,
    headers: {
      authorization: `Bearer ${loginBody.data.access_token}`,
      [CSRF_HEADER_NAME]: csrf,
      cookie: cookieHeader,
    },
    payload: { challenge_id: challengeBody.data.challenge_id, pin: DEMO_PIN },
  });
  assert.equal(verify.statusCode, 200, verify.body);
  const verifyBody = verify.json() as { ok: boolean; data: { access_token: string } };
  assert.equal(verifyBody.ok, true);
  assert.ok(verifyBody.data.access_token.length > 10);
  await app.close();
});
