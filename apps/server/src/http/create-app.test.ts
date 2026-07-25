/**
 * Local Fastify inject tests — no real listen / no Postgres.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { FastifyInstance } from "fastify";

import { CSRF_HEADER_NAME } from "@laundry/contracts";

import { createLocalApp } from "./create-app.js";
import { createMemoryLocalRuntime, DEMO_PASSWORD, DEMO_PIN } from "../local/demo-seed.js";
import { resolveCookiePolicy } from "./cookie-policy.js";
import { LOCAL_COOKIE_NAMES } from "./types.js";

const DEVICE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const OTHER_ORG_ID = "77777777-7777-4777-8777-777777777777";
const OTHER_STORE_ID = "88888888-8888-4888-8888-888888888888";
const OTHER_STAFF_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER_DEVICE_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const OTHER_SESSION_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const OTHER_FAMILY_ID = "99999999-9999-4999-8999-999999999999";
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

async function loginAdmin(app: FastifyInstance): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v2/auth/login",
    payload: {
      org_code: "local",
      store_code: "main",
      username: "admin",
      password: DEMO_PASSWORD,
      device_id: DEVICE,
    },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as { data: { access_token: string } };
  return body.data.access_token;
}

async function assertStaffDirectoryDenied(
  app: FastifyInstance,
  accessToken?: string,
): Promise<void> {
  const response =
    accessToken === undefined
      ? await app.inject({ method: "GET", url: "/api/v2/local/staff" })
      : await app.inject({
          method: "GET",
          url: "/api/v2/local/staff",
          headers: { authorization: `Bearer ${accessToken}` },
        });
  assert.equal(response.statusCode, 401);
  const body = response.json() as {
    ok: boolean;
    error: { code: string };
    data?: unknown;
  };
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "AUTHENTICATION_FAILED");
  assert.equal(body.data, undefined);
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

test("does not expose bootstrap or reset over HTTP", async () => {
  const { app } = await buildApp();
  for (const url of ["/api/v2/local/bootstrap", "/api/v2/local/reset", "/bootstrap", "/reset"]) {
    const response = await app.inject({ method: "POST", url, payload: {} });
    assert.equal(response.statusCode, 404, `${url} must not be routable`);
  }
  await app.close();
});

test("GET /api/v2/local/staff requires a valid bearer session", async (t) => {
  const { app, runtime } = await buildApp();
  const accessToken = await loginAdmin(app);
  const signer = runtime.identity.sessions.accessTokenSigner;
  const claims = signer.verify(accessToken);
  assert.ok(claims);
  const session = await runtime.identity.sessions.sessions.get(claims.session_id);
  assert.ok(session);

  await t.test("anonymous request", async () => {
    await assertStaffDirectoryDenied(app);
  });

  await t.test("invalid bearer", async () => {
    await assertStaffDirectoryDenied(app, "invalid-token");
  });

  await t.test("session lookup failure does not leak internal details", async () => {
    const sentinel = "sentinel-session-store-detail";
    const failingRuntime = Object.freeze({
      ...runtime,
      identity: Object.freeze({
        ...runtime.identity,
        sessions: Object.freeze({
          ...runtime.identity.sessions,
          sessions: Object.freeze({
            ...runtime.identity.sessions.sessions,
            get: async () => {
              throw new Error(sentinel);
            },
          }),
        }),
      }),
    });
    const failingApp = await createLocalApp({
      runtime: failingRuntime,
      cookiePolicy: localCookies,
    });
    const failingAccessToken = await loginAdmin(failingApp);
    const response = await failingApp.inject({
      method: "GET",
      url: "/api/v2/local/staff",
      headers: { authorization: `Bearer ${failingAccessToken}` },
    });
    assert.equal(response.statusCode, 500);
    const body = response.json() as { ok?: boolean; error?: { code?: string } };
    assert.equal(body.ok, false);
    assert.equal(body.error?.code, "TRANSACTION_FAILED");
    assert.doesNotMatch(response.body, new RegExp(sentinel, "u"));
    await failingApp.close();
  });

  await t.test("expired signed bearer", async () => {
    const now = runtime.identity.sessions.clock.nowEpochSeconds();
    const expiredAt = now - 1;
    const expiredToken = signer.sign({
      ...claims,
      iat: expiredAt - (claims.exp - claims.iat),
      exp: expiredAt,
    });
    await assertStaffDirectoryDenied(app, expiredToken);
  });

  await t.test("signed claims must match the stored session", async () => {
    const mismatches = [
      { label: "org", claims: { ...claims, org_id: OTHER_ORG_ID } },
      { label: "store", claims: { ...claims, store_id: OTHER_STORE_ID } },
      { label: "staff", claims: { ...claims, staff_id: OTHER_STAFF_ID } },
      { label: "device", claims: { ...claims, device_id: OTHER_DEVICE_ID } },
      {
        label: "permission version",
        claims: { ...claims, permission_version: claims.permission_version + 1 },
      },
    ] as const;
    for (const mismatch of mismatches) {
      await assertStaffDirectoryDenied(app, signer.sign(mismatch.claims)).catch((error) => {
        assert.fail(`${mismatch.label} mismatch was not rejected: ${String(error)}`);
      });
    }
  });

  await t.test("valid session for another tenant", async () => {
    await runtime.identity.sessions.sessions.insert(
      Object.freeze({
        ...session,
        session_id: OTHER_SESSION_ID,
        family_id: OTHER_FAMILY_ID,
        org_id: OTHER_ORG_ID,
        store_id: OTHER_STORE_ID,
        staff_id: OTHER_STAFF_ID,
      }),
    );
    const otherTenantToken = signer.sign({
      ...claims,
      session_id: OTHER_SESSION_ID,
      org_id: OTHER_ORG_ID,
      store_id: OTHER_STORE_ID,
      staff_id: OTHER_STAFF_ID,
    });
    await assertStaffDirectoryDenied(app, otherTenantToken);
  });

  await t.test("active local session bearer", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v2/local/staff",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { ok: true, data: runtime.staffDirectory });
  });

  await app.close();
});

test("POST /api/v2/auth/login succeeds with demo credentials and sets cookies", async () => {
  const { app } = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/v2/auth/login",
    payload: {
      org_code: "local",
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
      org_code: "local",
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
      org_code: "local",
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
      org_code: "local",
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
