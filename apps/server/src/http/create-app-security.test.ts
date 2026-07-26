import assert from "node:assert/strict";
import test from "node:test";

import { CSRF_HEADER_NAME } from "@laundry/contracts";

import { createMemoryLocalRuntime, DEMO_PASSWORD, DEMO_PIN } from "../local/demo-seed.js";
import { createLocalApp } from "./create-app.js";
import { resolveCookiePolicy } from "./cookie-policy.js";
import { createLoginRateLimiter } from "./login-rate-limit.js";
import { LOCAL_COOKIE_NAMES } from "./types.js";

const HOST = "127.0.0.1:8787";
const BROWSER_ORIGIN = "http://127.0.0.1:5173";
const DESKTOP_ORIGIN = "http://127.0.0.1:8787";
const DEVICE_A = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const DEVICE_B = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const localCookies = resolveCookiePolicy({ secure: false });

const hostHeaders = Object.freeze({ host: HOST });
const browserMutationHeaders = Object.freeze({
  ...hostHeaders,
  origin: BROWSER_ORIGIN,
  "sec-fetch-site": "same-site",
});
const desktopMutationHeaders = Object.freeze({
  ...hostHeaders,
  origin: DESKTOP_ORIGIN,
  "sec-fetch-site": "same-origin",
});

function deferred() {
  let resolvePromise: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return Object.freeze({ promise, resolve: resolvePromise });
}

async function beforeDeadline<T>(promise: PromiseLike<T>, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), 2_000);
  });
  try {
    return await Promise.race([Promise.resolve(promise), deadline]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function loginPayload(deviceId = DEVICE_A, password = DEMO_PASSWORD) {
  return Object.freeze({
    org_code: "local",
    store_code: "main",
    username: "admin",
    password,
    device_id: deviceId,
  });
}

function parseSetCookie(headers: Readonly<Record<string, unknown>>): Record<string, string> {
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

function cookieHeader(cookies: Readonly<Record<string, string>>): string {
  return Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

async function buildApp() {
  const runtime = await createMemoryLocalRuntime();
  const app = await createLocalApp({ runtime, cookiePolicy: localCookies, logger: false });
  return { app, runtime };
}

test("health exposes only readiness behind the exact local Host", async () => {
  const { app } = await buildApp();
  const healthy = await app.inject({ method: "GET", url: "/health", headers: hostHeaders });
  assert.equal(healthy.statusCode, 200, healthy.body);
  assert.deepEqual(healthy.json(), { ok: true, data: { status: "ready" } });

  for (const headers of [
    { host: "localhost:8787" },
    { host: "attacker.invalid" },
    { host: HOST, forwarded: "host=attacker.invalid;proto=https" },
    { host: HOST, "x-forwarded-host": "attacker.invalid" },
    { host: HOST, "x-forwarded-proto": "https" },
  ]) {
    const rejected = await app.inject({ method: "GET", url: "/health", headers });
    assert.equal(rejected.statusCode, 400, JSON.stringify(headers));
  }
  await app.close();
});

test("login requires an exact surface Origin, matching Fetch Metadata, and JSON", async () => {
  const { app } = await buildApp();
  for (const headers of [
    hostHeaders,
    { ...browserMutationHeaders, origin: "null" },
    { ...browserMutationHeaders, origin: "http://localhost:5173" },
    { ...browserMutationHeaders, origin: "https://attacker.invalid" },
    { ...browserMutationHeaders, "sec-fetch-site": "cross-site" },
    { ...browserMutationHeaders, "sec-fetch-site": "none" },
    { ...desktopMutationHeaders, "sec-fetch-site": "none" },
    { ...desktopMutationHeaders, "sec-fetch-site": "same-site" },
  ]) {
    const rejected = await app.inject({
      method: "POST",
      url: "/api/v2/auth/login",
      headers,
      payload: loginPayload(),
    });
    assert.equal(rejected.statusCode, 403, JSON.stringify(headers));
  }

  const nonJson = await app.inject({
    method: "POST",
    url: "/api/v2/auth/login",
    headers: { ...browserMutationHeaders, "content-type": "text/plain" },
    payload: JSON.stringify(loginPayload()),
  });
  assert.equal(nonJson.statusCode, 415, nonJson.body);

  for (const headers of [browserMutationHeaders, desktopMutationHeaders]) {
    const accepted = await app.inject({
      method: "POST",
      url: "/api/v2/auth/login",
      headers,
      payload: loginPayload(headers === browserMutationHeaders ? DEVICE_A : DEVICE_B),
    });
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.equal(accepted.headers["cache-control"], "no-store");
  }
  await app.close();
});

test("trusted desktop surface supports refresh, PIN, command, and logout CSRF", async () => {
  const { app, runtime } = await buildApp();
  const target = runtime.staffDirectory.find((staff) => staff.username === "staff");
  assert.ok(target);
  const login = await app.inject({
    method: "POST",
    url: "/api/v2/auth/login",
    headers: desktopMutationHeaders,
    payload: loginPayload(),
  });
  assert.equal(login.statusCode, 200, login.body);
  let access = (login.json() as { data: { access_token: string } }).data.access_token;
  let cookies = parseSetCookie(login.headers as Readonly<Record<string, unknown>>);

  const mutate = (csrf: string) => ({
    ...desktopMutationHeaders,
    authorization: `Bearer ${access}`,
    cookie: cookieHeader(cookies),
    [CSRF_HEADER_NAME]: csrf,
  });
  const challenge = await app.inject({
    method: "POST",
    url: "/api/v2/auth/pin/challenges",
    headers: mutate(cookies[LOCAL_COOKIE_NAMES.csrf] ?? ""),
    payload: { purpose: "quick_switch", target_staff_id: target.staff_id },
  });
  assert.equal(challenge.statusCode, 200, challenge.body);
  const challengeId = (challenge.json() as { data: { challenge_id: string } }).data.challenge_id;
  const verify = await app.inject({
    method: "POST",
    url: `/api/v2/auth/pin/challenges/${challengeId}/verify`,
    headers: mutate(cookies[LOCAL_COOKIE_NAMES.csrf] ?? ""),
    payload: { challenge_id: challengeId, pin: DEMO_PIN },
  });
  assert.equal(verify.statusCode, 200, verify.body);
  access = (verify.json() as { data: { access_token: string } }).data.access_token;
  cookies = parseSetCookie(verify.headers as Readonly<Record<string, unknown>>);

  const command = await app.inject({
    method: "POST",
    url: "/v1/commands/platform.settings.set",
    headers: mutate(cookies[LOCAL_COOKIE_NAMES.csrf] ?? ""),
    payload: { entries: [{ key: "pricing.min_order_cents", value_json: "100" }] },
  });
  assert.equal(command.statusCode, 403, command.body);
  assert.notEqual((command.json() as { error?: { code?: string } }).error?.code, "CSRF_REJECTED");

  const refresh = await app.inject({
    method: "POST",
    url: "/api/v2/auth/refresh",
    headers: mutate(cookies[LOCAL_COOKIE_NAMES.csrf] ?? ""),
    payload: {},
  });
  assert.equal(refresh.statusCode, 200, refresh.body);
  cookies = parseSetCookie(refresh.headers as Readonly<Record<string, unknown>>);
  const logout = await app.inject({
    method: "POST",
    url: "/api/v2/auth/logout",
    headers: mutate(cookies[LOCAL_COOKIE_NAMES.csrf] ?? ""),
    payload: {},
  });
  assert.equal(logout.statusCode, 200, logout.body);
  await app.close();
});

test("CORS never reflects an untrusted Origin", async () => {
  const { app } = await buildApp();
  const allowed = await app.inject({
    method: "OPTIONS",
    url: "/api/v2/auth/login",
    headers: {
      ...hostHeaders,
      origin: BROWSER_ORIGIN,
      "access-control-request-method": "POST",
    },
  });
  assert.equal(allowed.headers["access-control-allow-origin"], BROWSER_ORIGIN);

  const denied = await app.inject({
    method: "OPTIONS",
    url: "/api/v2/auth/login",
    headers: {
      ...hostHeaders,
      origin: "https://attacker.invalid",
      "access-control-request-method": "POST",
    },
  });
  assert.notEqual(denied.headers["access-control-allow-origin"], "https://attacker.invalid");
  assert.notEqual(denied.headers["access-control-allow-origin"], "*");
  await app.close();
});

test("a valid CSRF proof is bound to the active bearer session", async () => {
  const { app } = await buildApp();
  const firstLogin = await app.inject({
    method: "POST",
    url: "/api/v2/auth/login",
    headers: browserMutationHeaders,
    payload: loginPayload(DEVICE_A),
  });
  const secondLogin = await app.inject({
    method: "POST",
    url: "/api/v2/auth/login",
    headers: browserMutationHeaders,
    payload: loginPayload(DEVICE_B),
  });
  assert.equal(firstLogin.statusCode, 200, firstLogin.body);
  assert.equal(secondLogin.statusCode, 200, secondLogin.body);

  const firstAccess = (firstLogin.json() as { data: { access_token: string } }).data.access_token;
  const secondCookies = parseSetCookie(secondLogin.headers as Readonly<Record<string, unknown>>);
  const secondCsrf = secondCookies[LOCAL_COOKIE_NAMES.csrf];
  assert.ok(secondCsrf);

  const rejected = await app.inject({
    method: "POST",
    url: "/v1/commands/platform.settings.set",
    headers: {
      ...browserMutationHeaders,
      authorization: `Bearer ${firstAccess}`,
      cookie: cookieHeader(secondCookies),
      [CSRF_HEADER_NAME]: secondCsrf,
    },
    payload: { entries: [{ key: "pricing.min_order_cents", value_json: "100" }] },
  });
  assert.equal(rejected.statusCode, 403, rejected.body);
  assert.equal((rejected.json() as { error?: { code?: string } }).error?.code, "CSRF_REJECTED");
  await app.close();
});

test("refresh rotates the CSRF cookie and rejects a stale header", async () => {
  const { app } = await buildApp();
  const login = await app.inject({
    method: "POST",
    url: "/api/v2/auth/login",
    headers: browserMutationHeaders,
    payload: loginPayload(),
  });
  assert.equal(login.statusCode, 200, login.body);
  const firstCookies = parseSetCookie(login.headers as Readonly<Record<string, unknown>>);
  const firstCsrf = firstCookies[LOCAL_COOKIE_NAMES.csrf];
  assert.ok(firstCsrf);

  const refresh = await app.inject({
    method: "POST",
    url: "/api/v2/auth/refresh",
    headers: {
      ...browserMutationHeaders,
      cookie: cookieHeader(firstCookies),
      [CSRF_HEADER_NAME]: firstCsrf,
    },
    payload: {},
  });
  assert.equal(refresh.statusCode, 200, refresh.body);
  const rotatedCookies = parseSetCookie(refresh.headers as Readonly<Record<string, unknown>>);
  const rotatedCsrf = rotatedCookies[LOCAL_COOKIE_NAMES.csrf];
  assert.ok(rotatedCsrf);
  assert.notEqual(rotatedCsrf, firstCsrf);
  const refreshedAccess = (refresh.json() as { data: { access_token: string } }).data.access_token;

  const stale = await app.inject({
    method: "POST",
    url: "/api/v2/auth/refresh",
    headers: {
      ...browserMutationHeaders,
      cookie: cookieHeader(rotatedCookies),
      [CSRF_HEADER_NAME]: firstCsrf,
    },
    payload: {},
  });
  assert.equal(stale.statusCode, 403, stale.body);
  assert.equal((stale.json() as { error?: { code?: string } }).error?.code, "CSRF_REJECTED");

  const replayedPair = await app.inject({
    method: "POST",
    url: "/v1/commands/platform.settings.set",
    headers: {
      ...browserMutationHeaders,
      authorization: `Bearer ${refreshedAccess}`,
      cookie: cookieHeader({
        ...rotatedCookies,
        [LOCAL_COOKIE_NAMES.csrf]: firstCsrf,
      }),
      [CSRF_HEADER_NAME]: firstCsrf,
    },
    payload: { entries: [{ key: "pricing.min_order_cents", value_json: "100" }] },
  });
  assert.equal(replayedPair.statusCode, 403, replayedPair.body);
  assert.equal((replayedPair.json() as { error?: { code?: string } }).error?.code, "CSRF_REJECTED");
  await app.close();
});

test("login applies the normalized account limiter before credential verification", async () => {
  const runtime = await createMemoryLocalRuntime();
  const loginRateLimiter = createLoginRateLimiter({
    clock: { nowMs: () => 1_700_000_000_000 },
    account: { maxFailures: 2 },
    ip: { maxFailures: 20 },
  });
  const app = await createLocalApp({
    runtime,
    cookiePolicy: localCookies,
    loginRateLimiter,
    logger: false,
  });

  const first = await app.inject({
    method: "POST",
    url: "/api/v2/auth/login",
    headers: browserMutationHeaders,
    payload: {
      ...loginPayload(),
      password: "wrong",
    },
  });
  assert.equal(first.statusCode, 401, first.body);

  const threshold = await app.inject({
    method: "POST",
    url: "/api/v2/auth/login",
    headers: browserMutationHeaders,
    payload: {
      ...loginPayload(),
      org_code: "LOCAL",
      store_code: "MAIN",
      username: "ADMIN",
      password: "wrong",
    },
  });
  assert.equal(threshold.statusCode, 429, threshold.body);
  assert.equal(threshold.headers["retry-after"], "900");

  const blockedCorrectCredential = await app.inject({
    method: "POST",
    url: "/api/v2/auth/login",
    headers: browserMutationHeaders,
    payload: loginPayload(),
  });
  assert.equal(blockedCorrectCredential.statusCode, 429, blockedCorrectCredential.body);
  assert.doesNotMatch(blockedCorrectCredential.body, new RegExp(`admin|${DEMO_PASSWORD}`, "iu"));
  await app.close();
});

test("login sanitizes an internal rate-limiter failure as a server error", async () => {
  const runtime = await createMemoryLocalRuntime();
  const internalSecret = "limiter storage password /private/rate-limit.db";
  const app = await createLocalApp({
    runtime,
    cookiePolicy: localCookies,
    loginRateLimiter: Object.freeze({
      beginAttempt: () => {
        throw new Error(internalSecret);
      },
    }),
    logger: false,
  });

  const response = await app.inject({
    method: "POST",
    url: "/api/v2/auth/login",
    headers: browserMutationHeaders,
    payload: loginPayload(),
  });
  assert.equal(response.statusCode, 500, response.body);
  assert.deepEqual(response.json(), {
    ok: false,
    error: {
      code: "TRANSACTION_FAILED",
      message: "Command transaction failed",
    },
  });
  assert.doesNotMatch(response.body, /limiter|storage|password|private|rate-limit/iu);
  await app.close();
});

test("a concurrent login reservation blocks the threshold request before password verification", async () => {
  const runtime = await createMemoryLocalRuntime();
  const verifierEntered = deferred();
  const releaseVerifier = deferred();
  const originalPasswordPort = runtime.identity.login.passwordPort;
  let verificationCalls = 0;
  const guardedPasswordPort = Object.freeze({
    hashPassword: originalPasswordPort.hashPassword,
    verifyPassword: async (password: string, storedHash: string): Promise<boolean> => {
      verificationCalls += 1;
      verifierEntered.resolve();
      await releaseVerifier.promise;
      return originalPasswordPort.verifyPassword(password, storedHash);
    },
  });
  const guardedRuntime = Object.freeze({
    ...runtime,
    identity: Object.freeze({
      ...runtime.identity,
      login: Object.freeze({
        ...runtime.identity.login,
        passwordPort: guardedPasswordPort,
      }),
    }),
  });
  const app = await createLocalApp({
    runtime: guardedRuntime,
    cookiePolicy: localCookies,
    loginRateLimiter: createLoginRateLimiter({
      clock: { nowMs: () => 1_700_000_000_000 },
      account: { maxFailures: 1 },
      ip: { maxFailures: 20 },
    }),
    logger: false,
  });
  const inFlightRequests: PromiseLike<unknown>[] = [];

  try {
    const firstRequest = app.inject({
      method: "POST",
      url: "/api/v2/auth/login",
      headers: browserMutationHeaders,
      payload: loginPayload(DEVICE_A, "wrong"),
    });
    inFlightRequests.push(firstRequest);
    await beforeDeadline(
      verifierEntered.promise,
      "first login did not enter password verification",
    );

    const thresholdRequest = app.inject({
      method: "POST",
      url: "/api/v2/auth/login",
      headers: browserMutationHeaders,
      payload: loginPayload(DEVICE_B),
    });
    inFlightRequests.push(thresholdRequest);
    const threshold = await beforeDeadline(
      thresholdRequest,
      "concurrent threshold login reached the blocked verifier",
    );
    assert.equal(threshold.statusCode, 429, threshold.body);
    assert.equal(verificationCalls, 1);

    releaseVerifier.resolve();
    const first = await beforeDeadline(firstRequest, "first login did not complete");
    assert.equal(first.statusCode, 429, first.body);
    assert.equal(verificationCalls, 1);
  } finally {
    releaseVerifier.resolve();
    await Promise.allSettled(inFlightRequests);
    await app.close();
  }
});

test("PIN routes validate strict contract bodies and the path binding before password work", async () => {
  const runtime = await createMemoryLocalRuntime();
  const originalPinPort = runtime.identity.pin.pinPort;
  let pinVerificationCalls = 0;
  const guardedRuntime = Object.freeze({
    ...runtime,
    identity: Object.freeze({
      ...runtime.identity,
      pin: Object.freeze({
        ...runtime.identity.pin,
        pinPort: Object.freeze({
          ...originalPinPort,
          verifyPassword: async (pin: string, storedHash: string): Promise<boolean> => {
            pinVerificationCalls += 1;
            return originalPinPort.verifyPassword(pin, storedHash);
          },
        }),
      }),
    }),
  });
  const app = await createLocalApp({
    runtime: guardedRuntime,
    cookiePolicy: localCookies,
    logger: false,
  });
  const login = await app.inject({
    method: "POST",
    url: "/api/v2/auth/login",
    headers: browserMutationHeaders,
    payload: loginPayload(),
  });
  assert.equal(login.statusCode, 200, login.body);
  const access = (login.json() as { data: { access_token: string } }).data.access_token;
  const cookies = parseSetCookie(login.headers as Readonly<Record<string, unknown>>);
  const headers = {
    ...browserMutationHeaders,
    authorization: `Bearer ${access}`,
    cookie: cookieHeader(cookies),
    [CSRF_HEADER_NAME]: cookies[LOCAL_COOKIE_NAMES.csrf] ?? "",
  };
  const target = runtime.staffDirectory.find((entry) => entry.username === "staff");
  assert.ok(target);

  for (const payload of [
    { purpose: "quick_switch", target_staff_id: "not-a-uuid" },
    { purpose: "quick_switch", target_staff_id: target.staff_id, extra: "rejected" },
  ]) {
    const response = await app.inject({
      method: "POST",
      url: "/api/v2/auth/pin/challenges",
      headers,
      payload,
    });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(
      (response.json() as { error?: { code?: string } }).error?.code,
      "VALIDATION_FAILED",
    );
  }

  const challenge = await app.inject({
    method: "POST",
    url: "/api/v2/auth/pin/challenges",
    headers,
    payload: { purpose: "quick_switch", target_staff_id: target.staff_id },
  });
  assert.equal(challenge.statusCode, 200, challenge.body);
  const challengeId = (challenge.json() as { data: { challenge_id: string } }).data.challenge_id;
  const otherChallengeId = "99999999-9999-4999-8999-999999999999";
  const invalidVerifications = [
    {
      pathId: "not-a-uuid",
      payload: { challenge_id: challengeId, pin: "9999" },
    },
    {
      pathId: challengeId,
      payload: { challenge_id: otherChallengeId, pin: "9999" },
    },
    {
      pathId: challengeId,
      payload: { challenge_id: challengeId, pin: "1" },
    },
    {
      pathId: challengeId,
      payload: { challenge_id: challengeId, pin: "9999", extra: "rejected" },
    },
  ] as const;
  for (const invalid of invalidVerifications) {
    const response = await app.inject({
      method: "POST",
      url: `/api/v2/auth/pin/challenges/${invalid.pathId}/verify`,
      headers,
      payload: invalid.payload,
    });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(
      (response.json() as { error?: { code?: string } }).error?.code,
      "VALIDATION_FAILED",
    );
  }
  assert.equal(pinVerificationCalls, 0);
  await app.close();
});

test("logout requires refresh-bound CSRF, revokes the session, and clears exact cookies", async () => {
  const { app } = await buildApp();
  const login = await app.inject({
    method: "POST",
    url: "/api/v2/auth/login",
    headers: browserMutationHeaders,
    payload: loginPayload(),
  });
  assert.equal(login.statusCode, 200, login.body);
  const access = (login.json() as { data: { access_token: string } }).data.access_token;
  const cookies = parseSetCookie(login.headers as Readonly<Record<string, unknown>>);
  const csrf = cookies[LOCAL_COOKIE_NAMES.csrf];
  assert.ok(csrf);

  const missingCsrf = await app.inject({
    method: "POST",
    url: "/api/v2/auth/logout",
    headers: {
      ...browserMutationHeaders,
      cookie: cookieHeader(cookies),
    },
    payload: {},
  });
  assert.equal(missingCsrf.statusCode, 403, missingCsrf.body);
  assert.equal((missingCsrf.json() as { error?: { code?: string } }).error?.code, "CSRF_REJECTED");

  const logout = await app.inject({
    method: "POST",
    url: "/api/v2/auth/logout",
    headers: {
      ...browserMutationHeaders,
      cookie: cookieHeader(cookies),
      [CSRF_HEADER_NAME]: csrf,
    },
    payload: {},
  });
  assert.equal(logout.statusCode, 200, logout.body);
  assert.deepEqual(logout.json(), { ok: true, data: { logged_out: true } });
  const raw = logout.headers["set-cookie"];
  const lines = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  assert.equal(lines.length, 2);
  for (const line of lines) {
    assert.match(line, /Max-Age=0/iu);
    assert.match(line, /Path=\//iu);
    assert.match(line, /SameSite=Strict/iu);
    assert.doesNotMatch(line, /Domain=/iu);
  }

  const oldBearer = await app.inject({
    method: "GET",
    url: "/api/v2/local/staff",
    headers: {
      ...hostHeaders,
      authorization: `Bearer ${access}`,
    },
  });
  assert.equal(oldBearer.statusCode, 401, oldBearer.body);
  await app.close();
});
