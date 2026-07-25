/**
 * HttpAuthClient unit tests with a fake fetch (no network).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createHttpAuthClient } from "./HttpAuthClient.js";

const ADMIN_STAFF_ID = "11111111-1111-4111-8111-111111111103";

function staffDirectoryResponse(displayName = "店长"): Response {
  return new Response(
    JSON.stringify({
      ok: true,
      data: [
        {
          staff_id: ADMIN_STAFF_ID,
          display_name: displayName,
          role: "admin",
        },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function loginResponse(accessToken = "aaa.bbb.ccc", sessionId = "s1"): Response {
  return new Response(
    JSON.stringify({
      ok: true,
      data: {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: 900,
        storage: "memory_only",
        session: {
          session_id: sessionId,
          session_version: 1,
          org_id: "o1",
          store_id: "st1",
          staff_id: ADMIN_STAFF_ID,
          device_id: "d1",
          permission_version: 1,
        },
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
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
      return loginResponse(`login-token-${loginCalls}`, `session-${loginCalls}`);
    }
    if (url.endsWith("/api/v2/local/staff")) {
      directoryCalls += 1;
      directoryAuthorizations.push(new Headers(init?.headers).get("authorization"));
      return directoryCalls === 1 ? staffDirectoryResponse() : secondDirectory();
    }
    return new Response("not found", { status: 404 });
  };
  const client = createHttpAuthClient({
    apiBaseUrl: "http://127.0.0.1:8787",
    fetchImpl,
  });
  const credentials = {
    org_code: "local",
    store_code: "main",
    username: "admin",
    password: "fixture-password",
  };

  const first = await client.login(credentials);
  const second = await client.login(credentials);

  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  if (!second.ok) {
    assert.match(second.error.message, /员工目录/u);
  }
  assert.equal(loginCalls, 2);
  assert.deepEqual(directoryAuthorizations, ["Bearer login-token-1", "Bearer login-token-2"]);
}

test("login uses the server staff projection without client-side product mapping", async () => {
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

  const client = createHttpAuthClient({
    apiBaseUrl: "http://127.0.0.1:8787",
    fetchImpl,
  });
  const result = await client.login({
    org_code: "local",
    store_code: "main",
    username: "admin",
    password: "fixture-password",
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.data.storage, "memory_only");
    assert.equal(result.data.role, "admin");
    assert.equal(result.data.access_token, "aaa.bbb.ccc");
    assert.equal(result.data.display.store_name, "");
    assert.equal(result.data.display.staff_name, "店长");
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

test("login rejects a missing server staff projection instead of inferring a role", async () => {
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/v2/local/staff")) {
      return new Response(JSON.stringify({ ok: true, data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/api/v2/auth/login") && init?.method === "POST") {
      return new Response(
        JSON.stringify({
          ok: true,
          data: {
            access_token: "aaa.bbb.ccc",
            expires_in: 900,
            session: {
              session_id: "s1",
              session_version: 1,
              org_id: "o1",
              store_id: "st1",
              staff_id: "11111111-1111-4111-8111-111111111103",
              device_id: "d1",
              permission_version: 1,
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("not found", { status: 404 });
  };

  const client = createHttpAuthClient({
    apiBaseUrl: "http://127.0.0.1:8787",
    fetchImpl,
  });
  const result = await client.login({
    org_code: "local",
    store_code: "main",
    username: "admin",
    password: "fixture-password",
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error.message, /员工权限/u);
  }
});

test("login surfaces network failure message", async () => {
  const fetchImpl: typeof fetch = async () => {
    throw new Error("offline");
  };
  const client = createHttpAuthClient({
    apiBaseUrl: "http://127.0.0.1:8787",
    fetchImpl,
  });
  const result = await client.login({
    org_code: "local",
    store_code: "main",
    username: "admin",
    password: "fixture-password",
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error.message, /本地服务器/);
  }
});

test("failed relogin clears the prior token before a later PIN request", async () => {
  let loginCalls = 0;
  const pinAuthorizations: Array<string | null> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/v2/local/staff")) return staffDirectoryResponse();
    if (url.endsWith("/api/v2/auth/login") && init?.method === "POST") {
      loginCalls += 1;
      return loginCalls === 1 ? loginResponse("old-token") : loginFailureResponse();
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
  const client = createHttpAuthClient({ apiBaseUrl: "http://127.0.0.1:8787", fetchImpl });

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
      return loginResponse(
        loginCalls === 1 ? "old-token" : "new-token",
        loginCalls === 1 ? "old-session" : "new-session",
      );
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
      return loginResponse("rotated-token", "rotated-session");
    }
    return new Response("not found", { status: 404 });
  };
  const client = createHttpAuthClient({ apiBaseUrl: "http://127.0.0.1:8787", fetchImpl });

  const staleAttempt = client.login(loginValues("old-org"));
  await staleDirectoryStarted.promise;
  const currentResult = await client.login(loginValues("new-org"));
  assert.equal(currentResult.ok, true);
  staleDirectory.reject(new Error("stale directory failed"));
  const staleResult = await staleAttempt;
  assert.equal(staleResult.ok, false);
  if (!staleResult.ok) assert.match(staleResult.error.message, /取代|取消/u);
  assert.equal(client.listSwitchableStaff()[0]?.display_name, "新店长");

  await withCsrfCookie(async () => {
    const pin = await client.verifyPin({ challenge_id: "challenge-1", pin: "1234" });
    assert.equal(pin.ok, true);
    if (pin.ok) {
      assert.equal(pin.data.display.staff_name, "新店长");
      assert.equal(pin.data.display.org_code, "new-org");
    }
  });
  assert.deepEqual(directoryAuthorizations, ["Bearer old-token", "Bearer new-token"]);
  assert.deepEqual(pinAuthorizations, ["Bearer new-token"]);
});

test("a delayed stale success cannot replace a newer successful login", async () => {
  const staleLogin = createDeferred<Response>();
  const staleLoginStarted = createDeferred<void>();
  let loginCalls = 0;
  const directoryAuthorizations: Array<string | null> = [];
  const pinAuthorizations: Array<string | null> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/v2/auth/login")) {
      loginCalls += 1;
      if (loginCalls === 1) {
        staleLoginStarted.resolve();
        return staleLogin.promise;
      }
      return loginResponse("new-token", "new-session");
    }
    if (url.endsWith("/api/v2/local/staff")) {
      const authorization = new Headers(init?.headers).get("authorization");
      directoryAuthorizations.push(authorization);
      return staffDirectoryResponse(authorization === "Bearer new-token" ? "新店长" : "旧店长");
    }
    if (url.endsWith("/api/v2/auth/pin/challenges/challenge-1/verify")) {
      pinAuthorizations.push(new Headers(init?.headers).get("authorization"));
      return loginResponse("rotated-token", "rotated-session");
    }
    return new Response("not found", { status: 404 });
  };
  const client = createHttpAuthClient({ apiBaseUrl: "http://127.0.0.1:8787", fetchImpl });

  const staleAttempt = client.login(loginValues("old-org"));
  await staleLoginStarted.promise;
  const currentResult = await client.login(loginValues("new-org"));
  assert.equal(currentResult.ok, true);
  staleLogin.resolve(loginResponse("old-token", "old-session"));
  const staleResult = await staleAttempt;
  assert.equal(staleResult.ok, false);
  if (!staleResult.ok) assert.match(staleResult.error.message, /取代|取消/u);
  assert.equal(client.listSwitchableStaff()[0]?.display_name, "新店长");

  await withCsrfCookie(async () => {
    const pin = await client.verifyPin({ challenge_id: "challenge-1", pin: "1234" });
    assert.equal(pin.ok, true);
    if (pin.ok) {
      assert.equal(pin.data.display.staff_name, "新店长");
      assert.equal(pin.data.display.org_code, "new-org");
    }
  });
  assert.deepEqual(directoryAuthorizations, ["Bearer new-token"]);
  assert.deepEqual(pinAuthorizations, ["Bearer new-token"]);
});
