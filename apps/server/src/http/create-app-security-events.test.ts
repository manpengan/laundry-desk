import assert from "node:assert/strict";
import test from "node:test";

import { CSRF_HEADER_NAME } from "@laundry/contracts";

import { createMemoryLocalRuntime, DEMO_PASSWORD } from "../local/demo-seed.js";
import { createLocalApp } from "./create-app.js";
import { resolveCookiePolicy } from "./cookie-policy.js";
import { createLoginRateLimiter } from "./login-rate-limit.js";
import { createSecurityEventSink, type SecurityEventSink } from "./security-events.js";
import { LOCAL_COOKIE_NAMES } from "./types.js";

const HOST = "127.0.0.1:8787";
const BROWSER_ORIGIN = "http://127.0.0.1:5173";
const DEVICE_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const REDACTION_KEY = "test-only-security-event-key-32-bytes";
const browserMutationHeaders = Object.freeze({
  host: HOST,
  origin: BROWSER_ORIGIN,
  "sec-fetch-site": "same-site",
});
const localCookies = resolveCookiePolicy({ secure: false });

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

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function capturingSecurityEventSink(records: unknown[]): SecurityEventSink {
  const redactingSink = createSecurityEventSink(REDACTION_KEY);
  return Object.freeze({
    record: (request, input): void => {
      redactingSink.record(
        Object.freeze({
          id: request.id,
          log: Object.freeze({
            warn: (record: unknown): void => {
              records.push(record);
            },
          }),
        }),
        input,
      );
    },
  });
}

function securityEvent(record: unknown): Readonly<Record<string, unknown>> {
  assert.ok(isRecord(record));
  const event = record.security_event;
  assert.ok(isRecord(event));
  return event;
}

const LOGIN_ACCOUNT = Object.freeze({
  org_code: "local",
  store_code: "main",
  username: "admin",
});
/*
 * No device_id at all — required by the login contract, and the exact shape that
 * cost hours on the cloud test host because it is answered like a bad password.
 */
const MALFORMED_LOGIN = Object.freeze({ ...LOGIN_ACCOUNT, password: DEMO_PASSWORD });
const WRONG_PASSWORD_LOGIN = Object.freeze({
  ...LOGIN_ACCOUNT,
  device_id: DEVICE_ID,
  password: "definitely-not-the-password",
});

async function loginDiagnosticsApp(
  loggedRecords: unknown[],
): Promise<Awaited<ReturnType<typeof createLocalApp>>> {
  return createLocalApp({
    runtime: await createMemoryLocalRuntime(),
    cookiePolicy: localCookies,
    // Generous ceilings: these cases must be observed as failures, not as rate limiting.
    loginRateLimiter: createLoginRateLimiter({
      clock: { nowMs: () => 1_700_000_000_000 },
      account: { maxFailures: 50 },
      ip: { maxFailures: 50 },
    }),
    securityEventSink: capturingSecurityEventSink(loggedRecords),
    logger: false,
  });
}

test("a login the schema rejects is recorded apart from a credential failure", async () => {
  const loggedRecords: unknown[] = [];
  const app = await loginDiagnosticsApp(loggedRecords);

  const malformed = await app.inject({
    method: "POST",
    url: "/api/v2/auth/login",
    headers: browserMutationHeaders,
    payload: MALFORMED_LOGIN,
  });
  assert.equal(malformed.statusCode, 401, malformed.body);

  const wrongPassword = await app.inject({
    method: "POST",
    url: "/api/v2/auth/login",
    headers: browserMutationHeaders,
    payload: WRONG_PASSWORD_LOGIN,
  });
  assert.equal(wrongPassword.statusCode, 401, wrongPassword.body);

  assert.deepEqual(
    loggedRecords.map(securityEvent).map((event) => event.reason_code),
    ["LOGIN_REQUEST_INVALID", "LOGIN_FAILED"],
  );
  await app.close();
});

test("a login the schema rejects is answered exactly like a credential failure", async () => {
  const loggedRecords: unknown[] = [];
  const app = await loginDiagnosticsApp(loggedRecords);

  const malformed = await app.inject({
    method: "POST",
    url: "/api/v2/auth/login",
    headers: browserMutationHeaders,
    payload: MALFORMED_LOGIN,
  });
  const wrongPassword = await app.inject({
    method: "POST",
    url: "/api/v2/auth/login",
    headers: browserMutationHeaders,
    payload: WRONG_PASSWORD_LOGIN,
  });

  assert.equal(malformed.statusCode, wrongPassword.statusCode);
  assert.equal(malformed.body, wrongPassword.body);
  assert.equal(malformed.headers["set-cookie"], undefined);
  assert.deepEqual(
    Object.keys(malformed.headers as Readonly<Record<string, unknown>>).sort(),
    Object.keys(wrongPassword.headers as Readonly<Record<string, unknown>>).sort(),
  );
  await app.close();
});

test("auth security events expose stable reason codes and only opaque dimensions", async () => {
  const loggedRecords: unknown[] = [];
  const runtime = await createMemoryLocalRuntime();
  const app = await createLocalApp({
    runtime,
    cookiePolicy: localCookies,
    loginRateLimiter: createLoginRateLimiter({
      clock: { nowMs: () => 1_700_000_000_000 },
      account: { maxFailures: 1 },
      ip: { maxFailures: 20 },
    }),
    securityEventSink: capturingSecurityEventSink(loggedRecords),
    logger: false,
  });

  const login = await app.inject({
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
  assert.equal(login.statusCode, 200, login.body);
  const loginData = (
    login.json() as {
      data: {
        access_token: string;
        session: { session_id: string };
      };
    }
  ).data;
  const firstCookies = parseSetCookie(login.headers as Readonly<Record<string, unknown>>);
  const firstCsrf = firstCookies[LOCAL_COOKIE_NAMES.csrf];
  const firstRefresh = firstCookies[LOCAL_COOKIE_NAMES.refresh];
  assert.ok(firstCsrf);
  assert.ok(firstRefresh);
  const firstCookieHeader = cookieHeader(firstCookies);
  const target = runtime.staffDirectory.find((entry) => entry.username === "staff");
  assert.ok(target);
  const pinHeaders = {
    ...browserMutationHeaders,
    authorization: `Bearer ${loginData.access_token}`,
    cookie: firstCookieHeader,
    [CSRF_HEADER_NAME]: firstCsrf,
  };
  const challenge = await app.inject({
    method: "POST",
    url: "/api/v2/auth/pin/challenges",
    headers: pinHeaders,
    payload: { purpose: "quick_switch", target_staff_id: target.staff_id },
  });
  assert.equal(challenge.statusCode, 200, challenge.body);
  const challengeId = (challenge.json() as { data: { challenge_id: string } }).data.challenge_id;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const failedPin = await app.inject({
      method: "POST",
      url: `/api/v2/auth/pin/challenges/${challengeId}/verify`,
      headers: pinHeaders,
      payload: { challenge_id: challengeId, pin: "0000" },
    });
    assert.equal(failedPin.statusCode, 401, failedPin.body);
  }
  const lockedPin = await app.inject({
    method: "POST",
    url: "/api/v2/auth/pin/challenges",
    headers: pinHeaders,
    payload: { purpose: "quick_switch", target_staff_id: target.staff_id },
  });
  assert.equal(lockedPin.statusCode, 429, lockedPin.body);

  const csrfRejected = await app.inject({
    method: "POST",
    url: "/v1/commands/platform.settings.set",
    headers: {
      ...browserMutationHeaders,
      authorization: `Bearer ${loginData.access_token}`,
      cookie: firstCookieHeader,
      [CSRF_HEADER_NAME]: "forged-csrf-proof",
    },
    payload: { entries: [{ key: "pricing.min_order_cents", value_json: "100" }] },
  });
  assert.equal(csrfRejected.statusCode, 403, csrfRejected.body);

  const refresh = await app.inject({
    method: "POST",
    url: "/api/v2/auth/refresh",
    headers: {
      ...browserMutationHeaders,
      cookie: firstCookieHeader,
      [CSRF_HEADER_NAME]: firstCsrf,
    },
    payload: {},
  });
  assert.equal(refresh.statusCode, 200, refresh.body);

  const replayedRefresh = await app.inject({
    method: "POST",
    url: "/api/v2/auth/refresh",
    headers: {
      ...browserMutationHeaders,
      cookie: firstCookieHeader,
      [CSRF_HEADER_NAME]: firstCsrf,
    },
    payload: {},
  });
  assert.equal(replayedRefresh.statusCode, 401, replayedRefresh.body);

  const rawAccount = Object.freeze({
    org_code: "LEAK_ORG_7f83",
    store_code: "LEAK_STORE_2a19",
    username: "LEAK_USER_6c41",
  });
  const rawPassword = "LEAK_PASSWORD_b524";
  const failedLogin = await app.inject({
    method: "POST",
    url: "/api/v2/auth/login",
    headers: browserMutationHeaders,
    payload: {
      ...rawAccount,
      password: rawPassword,
      device_id: DEVICE_ID,
    },
  });
  assert.equal(failedLogin.statusCode, 429, failedLogin.body);

  const events = loggedRecords.map(securityEvent);
  assert.deepEqual([...new Set(events.map((event) => event.reason_code))].sort(), [
    "CSRF_REJECTED",
    "LOGIN_FAILED",
    "LOGIN_RATE_LIMITED",
    "PIN_FAILED",
    "PIN_LOCKED",
    "REFRESH_REJECTED",
  ]);
  const allowedEventKeys = new Set([
    "event",
    "reason_code",
    "request_id",
    "account_ref",
    "ip_ref",
    "session_ref",
    "staff_ref",
  ]);
  for (const event of events) {
    assert.equal(event.event, "authentication_security");
    assert.equal(typeof event.request_id, "string");
    assert.equal(
      Object.keys(event).every((key) => allowedEventKeys.has(key)),
      true,
    );
    for (const key of ["account_ref", "ip_ref", "session_ref", "staff_ref"]) {
      if (event[key] !== undefined) {
        assert.match(String(event[key]), /^[A-Za-z0-9_-]{43}$/u);
      }
    }
    for (const rawKey of [
      "account",
      "ip",
      "session_id",
      "staff_id",
      "token",
      "password",
      "cookie",
    ]) {
      assert.equal(event[rawKey], undefined);
    }
  }

  const serialized = JSON.stringify(loggedRecords);
  for (const secret of [
    rawAccount.org_code,
    rawAccount.store_code,
    rawAccount.username,
    rawPassword,
    "127.0.0.1",
    loginData.session.session_id,
    loginData.access_token,
    firstCsrf,
    firstRefresh,
    firstCookieHeader,
    target.staff_id,
    DEMO_PASSWORD,
    "forged-csrf-proof",
    LOCAL_COOKIE_NAMES.refresh,
    LOCAL_COOKIE_NAMES.csrf,
    "authorization",
    "Bearer",
  ]) {
    assert.equal(serialized.includes(secret), false, `security event leaked ${secret}`);
  }
  await app.close();
});
