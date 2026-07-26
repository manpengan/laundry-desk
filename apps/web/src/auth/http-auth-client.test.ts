/**
 * HttpAuthClient unit tests with a fake fetch (no network).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createHttpAuthClient } from "./HttpAuthClient.js";

const ADMIN_STAFF_ID = "11111111-1111-4111-8111-111111111103";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const ORG_ID = "33333333-3333-4333-8333-333333333333";
const STORE_ID = "44444444-4444-4444-8444-444444444444";
const DEVICE_ID = "55555555-5555-4555-8555-555555555555";

function staffDirectoryResponse(displayName = "店长", role: "admin" | "staff" = "admin"): Response {
  return new Response(
    JSON.stringify({
      ok: true,
      data: [
        {
          staff_id: ADMIN_STAFF_ID,
          display_name: displayName,
          role,
        },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function serverProjection(
  role: "admin" | "staff" = "admin",
  display = {
    store_name: "服务端门店",
    staff_name: "服务端店长",
    org_code: "server-org",
    store_code: "server-store",
  },
  features: Readonly<Record<string, boolean>> = {
    ai_enabled: false,
    member_enabled: true,
  },
) {
  return {
    role,
    features,
    display,
  };
}

function accessSessionData(
  accessToken = "aaa.bbb.ccc",
  sessionId = SESSION_ID,
  projection: ReturnType<typeof serverProjection> | null = serverProjection(),
) {
  const base = {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: 900,
    storage: "memory_only",
    session: {
      session_id: sessionId,
      session_version: 1,
      org_id: ORG_ID,
      store_id: STORE_ID,
      staff_id: ADMIN_STAFF_ID,
      device_id: DEVICE_ID,
      permission_version: 1,
    },
  };
  return projection === null ? base : { ...base, ...projection };
}

function successResponse(data: unknown): Response {
  return new Response(
    JSON.stringify({
      ok: true,
      data,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function loginResponse(
  accessToken = "aaa.bbb.ccc",
  sessionId = SESSION_ID,
  projection: ReturnType<typeof serverProjection> = serverProjection(),
): Response {
  return successResponse(accessSessionData(accessToken, sessionId, projection));
}

function loginFailureResponse(message = "用户名或密码错误"): Response {
  return new Response(
    JSON.stringify({
      ok: false,
      error: { code: "AUTHENTICATION_FAILED", message },
    }),
    { status: 401, headers: { "content-type": "application/json" } },
  );
}

function createTestClient(fetchImpl: typeof fetch) {
  return createHttpAuthClient({ apiBaseUrl: "http://127.0.0.1:8787", fetchImpl });
}

test("login rejects an access response that omits the server session projection", async () => {
  let directoryCalls = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/v2/auth/login") && init?.method === "POST") {
      return successResponse(accessSessionData("aaa.bbb.ccc", SESSION_ID, null));
    }
    if (url.endsWith("/api/v2/local/staff")) {
      directoryCalls += 1;
      return staffDirectoryResponse();
    }
    return new Response("not found", { status: 404 });
  };
  const client = createTestClient(fetchImpl);

  const result = await client.login(loginValues());

  assert.equal(result.ok, false);
  assert.equal(directoryCalls, 0);
  assert.deepEqual(client.listSwitchableStaff(), []);
  if (!result.ok) {
    assert.match(result.error.message, /响应格式错误/u);
  }
});

test("login uses the access response projection even when the staff directory disagrees", async () => {
  const authoritativeProjection = serverProjection(
    "staff",
    {
      store_name: "权威门店",
      staff_name: "权威员工",
      org_code: "authoritative-org",
      store_code: "authoritative-store",
    },
    {
      ai_enabled: true,
      member_enabled: false,
      custom_server_feature: true,
    },
  );
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/v2/auth/login") && init?.method === "POST") {
      return loginResponse("server.token.sig", SESSION_ID, authoritativeProjection);
    }
    if (url.endsWith("/api/v2/local/staff")) {
      return staffDirectoryResponse("目录店长", "admin");
    }
    return new Response("not found", { status: 404 });
  };
  const client = createTestClient(fetchImpl);

  const result = await client.login(loginValues("form-org"));

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.role, "staff");
  assert.deepEqual(result.data.features, authoritativeProjection.features);
  assert.deepEqual(result.data.display, authoritativeProjection.display);
  assert.deepEqual(client.listSwitchableStaff(), [
    {
      staff_id: ADMIN_STAFF_ID,
      display_name: "目录店长",
      role: "admin",
    },
  ]);
});

test("login rejects malformed or non-strict access response projections", async (t) => {
  const valid = {
    ...accessSessionData("aaa.bbb.ccc", SESSION_ID, null),
    ...serverProjection(),
  };
  const cases: ReadonlyArray<Readonly<{ name: string; data: unknown }>> = [
    {
      name: "unknown root field",
      data: { ...valid, unexpected: true },
    },
    {
      name: "unknown session field",
      data: { ...valid, session: { ...valid.session, unexpected: true } },
    },
    {
      name: "invalid session UUID",
      data: { ...valid, session: { ...valid.session, session_id: "not-a-uuid" } },
    },
    {
      name: "unknown display field",
      data: { ...valid, display: { ...valid.display, unexpected: true } },
    },
    {
      name: "invalid role",
      data: { ...valid, role: "owner" },
    },
    {
      name: "non-boolean feature",
      data: { ...valid, features: { ai_enabled: "yes" } },
    },
    {
      name: "wrong token type",
      data: { ...valid, token_type: "Basic" },
    },
    {
      name: "wrong storage",
      data: { ...valid, storage: "local_storage" },
    },
    {
      name: "wrong expiry",
      data: { ...valid, expires_in: 901 },
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      let directoryCalls = 0;
      const fetchImpl: typeof fetch = async (input, init) => {
        const url = String(input);
        if (url.endsWith("/api/v2/auth/login") && init?.method === "POST") {
          return successResponse(entry.data);
        }
        if (url.endsWith("/api/v2/local/staff")) {
          directoryCalls += 1;
          return staffDirectoryResponse();
        }
        return new Response("not found", { status: 404 });
      };
      const client = createTestClient(fetchImpl);

      const result = await client.login(loginValues());

      assert.equal(result.ok, false);
      assert.equal(directoryCalls, 0);
      assert.deepEqual(client.listSwitchableStaff(), []);
      if (!result.ok) {
        assert.match(result.error.message, /响应格式错误/u);
      }
    });
  }
});

test("quick switch replaces role features and display from the access response", async () => {
  const switchedProjection = serverProjection(
    "staff",
    {
      store_name: "切换后门店",
      staff_name: "切换后员工",
      org_code: "switched-org",
      store_code: "switched-store",
    },
    {
      ai_enabled: false,
      member_enabled: false,
      shift_closing_enabled: true,
    },
  );
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/v2/auth/login") && init?.method === "POST") {
      return loginResponse("login.token.sig");
    }
    if (url.endsWith("/api/v2/local/staff")) {
      return staffDirectoryResponse("缓存店长", "admin");
    }
    if (url.endsWith("/api/v2/auth/pin/challenges/challenge-1/verify")) {
      return loginResponse("switched.token.sig", SESSION_ID, switchedProjection);
    }
    return new Response("not found", { status: 404 });
  };
  const client = createTestClient(fetchImpl);
  assert.equal((await client.login(loginValues())).ok, true);

  await withCsrfCookie(async () => {
    const result = await client.verifyPin({ challenge_id: "challenge-1", pin: "1234" });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data.role, "staff");
    assert.deepEqual(result.data.features, switchedProjection.features);
    assert.deepEqual(result.data.display, switchedProjection.display);
  });
});

type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}>;

function createDeferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (reason: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return Object.freeze({
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  });
}

async function withCsrfCookie<T>(run: () => Promise<T>): Promise<T> {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: Object.freeze({ cookie: "laundry_csrf=csrf-token" }),
  });
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      Reflect.deleteProperty(globalThis, "document");
    } else {
      Object.defineProperty(globalThis, "document", previous);
    }
  }
}

function loginValues(orgCode = "local") {
  return Object.freeze({
    org_code: orgCode,
    store_code: "main",
    username: "admin",
    password: "fixture-password",
  });
}

async function assertSecondLoginRejectsStaleDirectory(
  secondDirectory: () => Response | Promise<Response>,
): Promise<void> {
  let directoryCalls = 0;
  let loginCalls = 0;
  const directoryAuthorizations: Array<string | null> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/v2/auth/login") && init?.method === "POST") {
      loginCalls += 1;
      return loginResponse(`login.token-${loginCalls}.sig`);
    }
    if (url.endsWith("/api/v2/local/staff")) {
      directoryCalls += 1;
      directoryAuthorizations.push(new Headers(init?.headers).get("authorization"));
      return directoryCalls === 1 ? staffDirectoryResponse() : secondDirectory();
    }
    return new Response("not found", { status: 404 });
  };
  const client = createTestClient(fetchImpl);

  const first = await client.login(loginValues());
  const second = await client.login(loginValues());

  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  if (!second.ok) {
    assert.match(second.error.message, /员工目录/u);
  }
  assert.equal(loginCalls, 2);
  assert.deepEqual(directoryAuthorizations, [
    "Bearer login.token-1.sig",
    "Bearer login.token-2.sig",
  ]);
}

test("login returns a token-free view and privately uses the token to load the switch directory", async () => {
  const requests: Array<Readonly<{ path: "login" | "staff"; authorization: string | null }>> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/v2/auth/login") && init?.method === "POST") {
      requests.push(
        Object.freeze({
          path: "login",
          authorization: new Headers(init.headers).get("authorization"),
        }),
      );
      return loginResponse();
    }
    if (url.endsWith("/api/v2/local/staff")) {
      requests.push(
        Object.freeze({
          path: "staff",
          authorization: new Headers(init?.headers).get("authorization"),
        }),
      );
      return staffDirectoryResponse();
    }
    return new Response("not found", { status: 404 });
  };

  const client = createTestClient(fetchImpl);
  const result = await client.login(loginValues());
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.data.role, "admin");
    assert.equal(result.data.features.ai_enabled, false);
    assert.equal(result.data.display.store_name, "服务端门店");
    assert.equal(result.data.display.staff_name, "服务端店长");
    assert.deepEqual(Object.keys(result.data).sort(), ["display", "features", "role", "session"]);
    assert.doesNotMatch(
      JSON.stringify(result.data),
      /access_token|refresh_token|authorization|cookie|header|aaa\.bbb\.ccc/iu,
    );
  }
  assert.deepEqual(requests, [
    { path: "login", authorization: null },
    { path: "staff", authorization: "Bearer aaa.bbb.ccc" },
  ]);
});

test("second login rejects a network failure instead of reusing the prior staff directory", async () => {
  await assertSecondLoginRejectsStaleDirectory(() => {
    throw new Error("directory offline");
  });
});

test("second login rejects an invalid staff directory instead of reusing prior roles", async () => {
  await assertSecondLoginRejectsStaleDirectory(
    () =>
      new Response(
        JSON.stringify({
          ok: true,
          data: [{ staff_id: ADMIN_STAFF_ID, display_name: "旧店长", role: "owner" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );
});

test("second login rejects a non-2xx staff directory instead of reusing prior roles", async () => {
  await assertSecondLoginRejectsStaleDirectory(
    () =>
      new Response(JSON.stringify({ ok: false }), {
        status: 503,
        headers: { "content-type": "application/json" },
      }),
  );
});

test("an empty switch directory does not replace the access response projection", async () => {
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/v2/local/staff")) {
      return new Response(JSON.stringify({ ok: true, data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/api/v2/auth/login") && init?.method === "POST") {
      return loginResponse();
    }
    return new Response("not found", { status: 404 });
  };

  const client = createTestClient(fetchImpl);
  const result = await client.login(loginValues());

  assert.equal(result.ok, true);
  assert.deepEqual(client.listSwitchableStaff(), []);
  if (!result.ok) return;
  assert.equal(result.data.role, "admin");
  assert.equal(result.data.display.store_name, "服务端门店");
});

test("login surfaces network failure message", async () => {
  const fetchImpl: typeof fetch = async () => {
    throw new Error("offline");
  };
  const client = createTestClient(fetchImpl);
  const result = await client.login(loginValues());
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error.message, /本地服务器/);
  }
});

test("failed relogin clears the prior token before a later PIN request", async () => {
  let loginCalls = 0;
  let logoutCalls = 0;
  const pinAuthorizations: Array<string | null> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/v2/local/staff")) return staffDirectoryResponse();
    if (url.endsWith("/api/v2/auth/login") && init?.method === "POST") {
      loginCalls += 1;
      return loginCalls === 1 ? loginResponse("old.token.sig") : loginFailureResponse();
    }
    if (url.endsWith("/api/v2/auth/logout")) {
      logoutCalls += 1;
      return successResponse({ logged_out: true });
    }
    if (url.endsWith("/api/v2/auth/pin/challenges")) {
      pinAuthorizations.push(new Headers(init?.headers).get("authorization"));
      return new Response(
        JSON.stringify({
          ok: true,
          data: {
            challenge_id: "challenge-1",
            purpose: "quick_switch",
            expires_at: 1_800_000_000,
            max_attempts: 5,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("not found", { status: 404 });
  };
  const client = createTestClient(fetchImpl);

  assert.equal((await client.login(loginValues())).ok, true);
  assert.equal((await client.login(loginValues())).ok, false);
  assert.deepEqual(client.listSwitchableStaff(), []);

  await withCsrfCookie(async () => {
    const pin = await client.createPinChallenge({
      purpose: "quick_switch",
      target_staff_id: ADMIN_STAFF_ID,
    });
    assert.equal(pin.ok, false);
    if (!pin.ok) assert.match(pin.error.message, /未登录/u);
  });
  assert.deepEqual(pinAuthorizations, []);
  assert.equal(logoutCalls, 0, "an ordinary 401 must not log out an established cookie session");
});

test("a delayed stale failure cannot clear a newer successful login", async () => {
  const staleDirectory = createDeferred<Response>();
  const staleDirectoryStarted = createDeferred<void>();
  let directoryCalls = 0;
  let loginCalls = 0;
  const directoryAuthorizations: Array<string | null> = [];
  const pinAuthorizations: Array<string | null> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/v2/auth/login")) {
      loginCalls += 1;
      return loginResponse(loginCalls === 1 ? "old.token.sig" : "new.token.sig");
    }
    if (url.endsWith("/api/v2/local/staff")) {
      directoryCalls += 1;
      directoryAuthorizations.push(new Headers(init?.headers).get("authorization"));
      if (directoryCalls === 1) {
        staleDirectoryStarted.resolve();
        return staleDirectory.promise;
      }
      return staffDirectoryResponse("新店长");
    }
    if (url.endsWith("/api/v2/auth/pin/challenges/challenge-1/verify")) {
      pinAuthorizations.push(new Headers(init?.headers).get("authorization"));
      return loginResponse("rotated.token.sig");
    }
    return new Response("not found", { status: 404 });
  };
  const client = createTestClient(fetchImpl);

  const staleAttempt = client.login(loginValues("old-org"));
  await staleDirectoryStarted.promise;
  const currentAttempt = client.login(loginValues("new-org"));
  assert.equal(loginCalls, 1);
  staleDirectory.reject(new Error("stale directory failed"));
  const [staleResult, currentResult] = await Promise.all([staleAttempt, currentAttempt]);
  assert.equal(currentResult.ok, true);
  assert.equal(staleResult.ok, false);
  if (!staleResult.ok) assert.match(staleResult.error.message, /取代|取消/u);
  assert.equal(client.listSwitchableStaff()[0]?.display_name, "新店长");

  await withCsrfCookie(async () => {
    const pin = await client.verifyPin({ challenge_id: "challenge-1", pin: "1234" });
    assert.equal(pin.ok, true);
    if (pin.ok) {
      assert.equal(pin.data.display.staff_name, "服务端店长");
      assert.equal(pin.data.display.org_code, "server-org");
    }
  });
  assert.deepEqual(directoryAuthorizations, ["Bearer old.token.sig", "Bearer new.token.sig"]);
  assert.deepEqual(pinAuthorizations, ["Bearer new.token.sig"]);
});

test("a superseded successful login is logged out before a queued login failure", async () => {
  const staleLogin = createDeferred<Response>();
  const staleLoginStarted = createDeferred<void>();
  let loginCalls = 0;
  const requestOrder: string[] = [];
  const cleanupRequests: Array<Readonly<Record<string, unknown>>> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/v2/auth/login")) {
      loginCalls += 1;
      requestOrder.push(`login:${loginCalls}`);
      if (loginCalls === 1) {
        staleLoginStarted.resolve();
        return staleLogin.promise;
      }
      return loginFailureResponse("new login rejected");
    }
    if (url.endsWith("/api/v2/auth/logout")) {
      requestOrder.push("logout");
      const headers = new Headers(init?.headers);
      cleanupRequests.push({
        url,
        method: init?.method,
        credentials: init?.credentials,
        authorization: headers.get("authorization"),
        csrf: headers.get("x-csrf-token"),
      });
      throw new Error("cleanup-private-sentinel");
    }
    return new Response("not found", { status: 404 });
  };
  const client = createHttpAuthClient({ apiBaseUrl: "http://127.0.0.1:8787/", fetchImpl });

  await withCsrfCookie(async () => {
    const staleAttempt = client.login(loginValues("old-org"));
    await staleLoginStarted.promise;
    const currentAttempt = client.login(loginValues("new-org"));
    assert.equal(loginCalls, 1);
    staleLogin.resolve(loginResponse("old.token.sig"));
    const [staleResult, currentResult] = await Promise.all([staleAttempt, currentAttempt]);

    assert.equal(staleResult.ok, false);
    if (!staleResult.ok) assert.equal(staleResult.error.message, "登录请求已被新的登录操作取代");
    assert.equal(currentResult.ok, false);
    if (!currentResult.ok) assert.equal(currentResult.error.message, "new login rejected");
  });

  assert.equal(loginCalls, 2);
  assert.deepEqual(requestOrder, ["login:1", "logout", "login:2"]);
  assert.deepEqual(cleanupRequests, [
    {
      url: "http://127.0.0.1:8787/api/v2/auth/logout",
      method: "POST",
      credentials: "include",
      authorization: null,
      csrf: "csrf-token",
    },
  ]);
  assert.deepEqual(client.listSwitchableStaff(), []);
});

test("401 and step-up preserve auth while malformed quick-switch logs out", async () => {
  let logoutCalls = 0;
  let accessToken: string | null = null;
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/api/v2/auth/login")) return loginResponse("initial.token.sig");
    if (url.endsWith("/api/v2/local/staff")) return staffDirectoryResponse();
    if (url.endsWith("/api/v2/auth/pin/challenges/step-up/verify")) {
      return successResponse({ unexpected: true });
    }
    if (url.endsWith("/api/v2/auth/pin/challenges/rejected/verify")) {
      return loginFailureResponse();
    }
    if (url.endsWith("/api/v2/auth/pin/challenges/quick-switch/verify")) {
      return successResponse({ malformed: true });
    }
    if (url.endsWith("/api/v2/auth/logout")) {
      logoutCalls += 1;
      return successResponse({ logged_out: true });
    }
    return new Response("not found", { status: 404 });
  };
  const client = createHttpAuthClient({
    apiBaseUrl: "http://127.0.0.1:8787",
    fetchImpl,
    credentialStore: {
      getAccessToken: () => accessToken,
      replaceAccessToken: (next) => {
        accessToken = next;
      },
      readCsrf: () => "csrf-token",
    },
  });
  assert.equal((await client.login(loginValues())).ok, true);
  assert.equal(accessToken, "initial.token.sig");

  const stepUp = await client.verifyStepUpPin({ challenge_id: "step-up", pin: "1234" });
  assert.equal(stepUp.ok, false);
  assert.equal(logoutCalls, 0);
  assert.equal(accessToken, "initial.token.sig");
  assert.equal(client.listSwitchableStaff().length, 1);

  const rejected = await client.verifyPin({ challenge_id: "rejected", pin: "0000" });
  assert.equal(rejected.ok, false);
  assert.equal(logoutCalls, 0);
  assert.equal(accessToken, "initial.token.sig");

  const switched = await client.verifyPin({ challenge_id: "quick-switch", pin: "1234" });
  assert.equal(switched.ok, false);
  assert.equal(logoutCalls, 1);
  assert.equal(accessToken, null);
  assert.deepEqual(client.listSwitchableStaff(), []);
});

test("quick-switch and relogin share one complete cookie-mutation queue", async () => {
  const delayedPin = createDeferred<Response>();
  const pinStarted = createDeferred<void>();
  let loginCalls = 0;
  let pinCalls = 0;
  const challengeAuthorizations: Array<string | null> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/v2/auth/login")) {
      loginCalls += 1;
      return loginResponse(loginCalls === 1 ? "initial.token.sig" : "latest.login.sig");
    }
    if (url.endsWith("/api/v2/local/staff")) return staffDirectoryResponse();
    if (url.endsWith("/api/v2/auth/pin/challenges/delayed/verify")) {
      pinCalls += 1;
      pinStarted.resolve();
      return delayedPin.promise;
    }
    if (url.endsWith("/api/v2/auth/pin/challenges")) {
      challengeAuthorizations.push(new Headers(init?.headers).get("authorization"));
      return successResponse({
        challenge_id: "next-challenge",
        purpose: "quick_switch",
        expires_at: 1_800_000_000,
        max_attempts: 5,
      });
    }
    return new Response("not found", { status: 404 });
  };
  const client = createTestClient(fetchImpl);
  assert.equal((await client.login(loginValues())).ok, true);

  await withCsrfCookie(async () => {
    const stalePin = client.verifyPin({ challenge_id: "delayed", pin: "1234" });
    await pinStarted.promise;
    const latestLogin = client.login(loginValues("latest-org"));
    assert.equal(loginCalls, 1);
    delayedPin.resolve(loginResponse("stale.switch.sig"));
    const [pinResult, loginResult] = await Promise.all([stalePin, latestLogin]);

    assert.equal(pinResult.ok, false);
    assert.equal(loginResult.ok, true);
    assert.equal(loginCalls, 2);
    assert.equal(pinCalls, 1);
    const challenge = await client.createPinChallenge({
      purpose: "quick_switch",
      target_staff_id: ADMIN_STAFF_ID,
    });
    assert.equal(challenge.ok, true);
  });
  assert.deepEqual(challengeAuthorizations, ["Bearer latest.login.sig"]);
});

test("a second queued quick-switch is discarded before it can replace cookies", async () => {
  const firstPin = createDeferred<Response>();
  const firstPinStarted = createDeferred<void>();
  let pinCalls = 0;
  const challengeAuthorizations: Array<string | null> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/v2/auth/login")) return loginResponse("initial.token.sig");
    if (url.endsWith("/api/v2/local/staff")) return staffDirectoryResponse();
    if (url.includes("/api/v2/auth/pin/challenges/") && url.endsWith("/verify")) {
      pinCalls += 1;
      firstPinStarted.resolve();
      return firstPin.promise;
    }
    if (url.endsWith("/api/v2/auth/pin/challenges")) {
      challengeAuthorizations.push(new Headers(init?.headers).get("authorization"));
      return successResponse({
        challenge_id: "next-challenge",
        purpose: "quick_switch",
        expires_at: 1_800_000_000,
        max_attempts: 5,
      });
    }
    return new Response("not found", { status: 404 });
  };
  const client = createTestClient(fetchImpl);
  assert.equal((await client.login(loginValues())).ok, true);

  await withCsrfCookie(async () => {
    const first = client.verifyPin({ challenge_id: "first", pin: "1234" });
    await firstPinStarted.promise;
    const staleSecond = client.verifyPin({ challenge_id: "second", pin: "1234" });
    firstPin.resolve(loginResponse("first.switch.sig"));
    const [firstResult, secondResult] = await Promise.all([first, staleSecond]);

    assert.equal(firstResult.ok, true);
    assert.equal(secondResult.ok, false);
    assert.equal(pinCalls, 1);
    const challenge = await client.createPinChallenge({
      purpose: "quick_switch",
      target_staff_id: ADMIN_STAFF_ID,
    });
    assert.equal(challenge.ok, true);
  });
  assert.deepEqual(challengeAuthorizations, ["Bearer first.switch.sig"]);
});
