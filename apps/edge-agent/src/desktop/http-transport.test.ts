import assert from "node:assert/strict";
import test from "node:test";

import { DesktopLoginInputSchema } from "@laundry/contracts";

import {
  createDesktopHttpTransport,
  DESKTOP_API_BASE_URL,
  DESKTOP_REQUEST_ORIGIN,
  type DesktopCookie,
  type DesktopHttpRequest,
  type DesktopHttpResponse,
  type DesktopHttpTransportDependencies,
} from "./http-transport.js";

const DEVICE_ID = "00000000-0000-4000-8000-000000000001";
const SESSION_ID = "00000000-0000-4000-8000-000000000002";
const ORG_ID = "00000000-0000-4000-8000-000000000003";
const STORE_ID = "00000000-0000-4000-8000-000000000004";
const ADMIN_ID = "00000000-0000-4000-8000-000000000005";
const STAFF_ID = "00000000-0000-4000-8000-000000000006";
const CHALLENGE_ID = "00000000-0000-4000-8000-000000000007";
const CONFIRM_REF = "00000000-0000-4000-8000-000000000008";
const STEP_UP_PROOF_ID = "00000000-0000-4000-8000-000000000009";
const ACCESS_A = "header.payload.signature-a";
const ACCESS_B = "header.payload.signature-b";
const ACCESS_C = "header.payload.signature-c";
const CSRF_A = `v1.${"a".repeat(43)}`;
const CSRF_B = `v1.${"b".repeat(43)}`;
const CSRF_C = `v1.${"c".repeat(43)}`;
// prettier-ignore
const LOGIN_INPUT = Object.freeze({ org_code: "demo-org", store_code: "demo-store", username: "admin", password: "password" });
// prettier-ignore
const CUSTOMER_COMMAND = Object.freeze({ name: "customer.upsert" as const, body: Object.freeze({ phone: "13800000000" }) });
const CUSTOMER_QUERY = Object.freeze({ name: "customer.search" as const, body: Object.freeze({}) });

type ResponseStep =
  | DesktopHttpResponse
  | Error
  | ((request: DesktopHttpRequest) => DesktopHttpResponse | Promise<DesktopHttpResponse>);

type HarnessInput = Readonly<{
  responses?: readonly ResponseStep[];
  cookieReads?: readonly (readonly DesktopCookie[])[];
  clearError?: Error;
  nowMs?: () => number;
  loginInputSchema?: Pick<typeof DesktopLoginInputSchema, "safeParseAsync">;
}>;

function jsonResponse(payload: unknown, statusCode = 200): DesktopHttpResponse {
  return Object.freeze({ statusCode, bodyText: JSON.stringify(payload) });
}

function executionResponse(result: unknown): DesktopHttpResponse {
  return jsonResponse({ ok: true, data: { execution: "executed", result } });
}

function failureResponse(code: string, message: string, statusCode: number): DesktopHttpResponse {
  return jsonResponse({ ok: false, error: { code, message } }, statusCode);
}

function csrfReads(...values: string[]): readonly (readonly DesktopCookie[])[] {
  return Object.freeze(values.map((value) => Object.freeze([{ name: "laundry_csrf", value }])));
}

function accessSession(
  accessToken: string,
  staffId = ADMIN_ID,
  staffName = "Admin",
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: 900,
    storage: "memory_only",
    session: Object.freeze({
      session_id: SESSION_ID,
      session_version: 1,
      org_id: ORG_ID,
      store_id: STORE_ID,
      staff_id: staffId,
      device_id: DEVICE_ID,
      permission_version: 1,
    }),
    role: staffId === ADMIN_ID ? "admin" : "staff",
    features: Object.freeze({ pin_quick_switch: true }),
    display: Object.freeze({
      store_name: "Demo Store",
      staff_name: staffName,
      org_code: "demo-org",
      store_code: "demo-store",
    }),
  });
}

function staffDirectoryResponse(): DesktopHttpResponse {
  // prettier-ignore
  return jsonResponse({ ok: true, data: [
    { staff_id: ADMIN_ID, display_name: "Admin", role: "admin", username: "admin-secret-login" },
    { staff_id: STAFF_ID, display_name: "Staff", role: "staff", username: "staff-secret-login" },
  ] });
}

function createHarness(input: HarnessInput = {}) {
  let pendingResponses = [...(input.responses ?? [])];
  let pendingCookieReads = [...(input.cookieReads ?? [])];
  let requests: readonly DesktopHttpRequest[] = [];
  let clearedUrls: readonly string[] = [];

  const dependencies = Object.freeze({
    async request(request) {
      requests = Object.freeze([...requests, request]);
      const [next, ...remaining] = pendingResponses;
      pendingResponses = remaining;
      if (next === undefined) throw new Error("Unexpected HTTP request");
      if (next instanceof Error) throw next;
      return typeof next === "function" ? next(request) : next;
    },
    cookies: Object.freeze({
      async get() {
        const [next = Object.freeze([]), ...remaining] = pendingCookieReads;
        pendingCookieReads = remaining;
        return next;
      },
      async clear(url: string) {
        clearedUrls = Object.freeze([...clearedUrls, url]);
        if (input.clearError !== undefined) throw input.clearError;
      },
    }),
    deviceId: DEVICE_ID,
    ...(input.nowMs === undefined ? {} : { nowMs: input.nowMs }),
    ...(input.loginInputSchema === undefined ? {} : { loginInputSchema: input.loginInputSchema }),
  }) as DesktopHttpTransportDependencies;

  return Object.freeze({
    dependencies,
    get requests(): readonly DesktopHttpRequest[] {
      return requests;
    },
    get clearedUrls(): readonly string[] {
      return clearedUrls;
    },
  });
}

async function createAuthenticatedTransport(
  input: HarnessInput = {},
  cookie: DesktopCookie = { name: "laundry_csrf", value: CSRF_A },
) {
  const harness = createHarness({
    ...input,
    responses: [
      jsonResponse({ ok: true, data: accessSession(ACCESS_A) }),
      staffDirectoryResponse(),
      ...(input.responses ?? []),
    ],
    cookieReads: [[cookie], ...(input.cookieReads ?? [])],
  });
  const transport = createDesktopHttpTransport(harness.dependencies);
  assert.equal((await transport.auth.login(LOGIN_INPUT)).ok, true);
  return Object.freeze({ harness, transport });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return Object.freeze({ promise, resolve });
}

function assertFixedRequest(request: DesktopHttpRequest): void {
  assert.equal(request.credentials, "include");
  assert.equal(request.redirect, "error");
  assert.equal(request.origin, DESKTOP_REQUEST_ORIGIN);
  assert.equal(request.headers.Origin, DESKTOP_REQUEST_ORIGIN);
  assert.equal(request.headers["Sec-Fetch-Site"], "same-origin");
  assert.equal(
    Object.keys(request.headers).some((name) => /^x-forwarded-/iu.test(name)),
    false,
  );
}

function assertFailure(
  result: Readonly<{ ok: boolean; error?: Readonly<{ code: string }> }>,
  code: string,
  message?: string,
): void {
  assert.equal(result.ok, false, message);
  assert.equal(result.error?.code, code);
}

test("login fixes every transport control, injects one stable device id, and strips credentials", async () => {
  const harness = createHarness({
    responses: [
      jsonResponse({ ok: true, data: accessSession(ACCESS_A) }),
      staffDirectoryResponse(),
    ],
    cookieReads: [[{ name: "laundry_csrf", value: CSRF_A }]],
  });
  const transport = createDesktopHttpTransport(harness.dependencies);

  const result = await transport.auth.login(LOGIN_INPUT);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.session_view.session.session_id, SESSION_ID);
  assert.equal(result.data.session_view.display.staff_name, "Admin");
  assert.deepEqual(result.data.staff_directory, [
    { staff_id: ADMIN_ID, display_name: "Admin", role: "admin" },
    { staff_id: STAFF_ID, display_name: "Staff", role: "staff" },
  ]);
  assert.equal(JSON.stringify(result).includes(ACCESS_A), false);
  assert.equal(JSON.stringify(result).includes("username"), false);
  assert.equal(JSON.stringify(result).includes(LOGIN_INPUT.password), false);

  assert.equal(harness.requests.length, 2);
  const loginRequest = harness.requests[0]!;
  assertFixedRequest(loginRequest);
  assert.equal(loginRequest.url, `${DESKTOP_API_BASE_URL}/api/v2/auth/login`);
  assert.equal(loginRequest.method, "POST");
  assert.equal(loginRequest.headers["Content-Type"], "application/json");
  assert.equal(loginRequest.headers.Authorization, undefined);
  assert.equal(loginRequest.headers["X-CSRF-Token"], undefined);
  assert.equal(typeof loginRequest.body, "string");
  assert.deepEqual(JSON.parse(typeof loginRequest.body === "string" ? loginRequest.body : ""), {
    ...LOGIN_INPUT,
    device_id: DEVICE_ID,
  });

  const staffRequest = harness.requests[1]!;
  assertFixedRequest(staffRequest);
  assert.equal(staffRequest.url, `${DESKTOP_API_BASE_URL}/api/v2/local/staff`);
  assert.equal(staffRequest.method, "GET");
  assert.equal(staffRequest.headers.Authorization, `Bearer ${ACCESS_A}`);
  assert.equal(staffRequest.body, undefined);
});

test("renderer input cannot select a URL, method, headers, cookies, token, or operation name", async () => {
  const harness = createHarness();
  const transport = createDesktopHttpTransport(harness.dependencies);

  const login = await transport.auth.login({
    ...LOGIN_INPUT,
    url: "https://attacker.invalid",
    method: "DELETE",
    headers: { "X-Forwarded-Host": "attacker.invalid" },
    cookies: "laundry_csrf=stolen",
    token: ACCESS_A,
  });
  const command = await transport.command.execute({
    name: "customer.upsert",
    body: { phone: "13800000000" },
    headers: { Authorization: `Bearer ${ACCESS_A}` },
  });
  const query = await transport.query.execute({
    name: "../../health",
    body: {},
  });
  assertFailure(login, "VALIDATION_FAILED");
  assertFailure(command, "VALIDATION_FAILED");
  assertFailure(query, "VALIDATION_FAILED");
  assert.deepEqual(harness.requests, []);
});

test("command, confirm, and query use only contract-selected routes with process-held auth", async () => {
  const { harness, transport } = await createAuthenticatedTransport(
    {
      responses: [
        executionResponse({ customer_id: STAFF_ID }),
        jsonResponse(
          {
            ok: false,
            error: {
              code: "POLICY_CONFIRMATION_REQUIRED",
              message: "Confirmation is required",
              detail: { kind: "confirmation", confirm_ref: CONFIRM_REF },
            },
          },
          403,
        ),
        executionResponse({ customers: [] }),
      ],
    },
    { name: "__Host-laundry_csrf", value: CSRF_A },
  );
  const direct = await transport.command.execute({
    name: "customer.upsert",
    body: { phone: "13800000000", name: "Customer" },
  });
  const confirm = await transport.command.execute({
    name: "shift.close",
    confirm_ref: CONFIRM_REF,
  });
  const query = await transport.query.execute({
    name: "customer.search",
    body: { query: "138", limit: 10 },
  });
  assert.equal(direct.ok, true);
  assert.equal(confirm.ok, false);
  assert.equal(query.ok, true);
  const expected = [
    {
      index: 2,
      path: "/v1/commands/customer.upsert",
      body: { phone: "13800000000", name: "Customer" },
    },
    {
      index: 3,
      path: "/v1/commands/shift.close",
      body: { confirm_ref: CONFIRM_REF },
    },
    {
      index: 4,
      path: "/v1/queries/customer.search",
      body: { query: "138", limit: 10 },
    },
  ] as const;
  expected.forEach(({ index, path, body }) => {
    const request = harness.requests[index]!;
    assertFixedRequest(request);
    assert.equal(request.url, `${DESKTOP_API_BASE_URL}${path}`);
    assert.equal(request.method, "POST");
    assert.equal(request.headers.Authorization, `Bearer ${ACCESS_A}`);
    assert.equal(request.headers["X-CSRF-Token"], CSRF_A);
    assert.equal(typeof request.body, "string");
    assert.deepEqual(JSON.parse(typeof request.body === "string" ? request.body : ""), body);
  });
});

test("refresh and quick-switch PIN replace access and CSRF state only after valid responses", async () => {
  const { harness, transport } = await createAuthenticatedTransport({
    responses: [
      jsonResponse({ ok: true, data: accessSession(ACCESS_B) }),
      jsonResponse({
        ok: true,
        data: {
          challenge_id: CHALLENGE_ID,
          purpose: "quick_switch",
          expires_at: 2_000_000_000,
          max_attempts: 5,
        },
      }),
      jsonResponse({
        ok: true,
        data: accessSession(ACCESS_C, STAFF_ID, "Staff"),
      }),
      executionResponse({ customers: [] }),
    ],
    cookieReads: [
      [{ name: "laundry_csrf", value: CSRF_A }],
      [{ name: "laundry_csrf", value: CSRF_B }],
      [{ name: "__Host-laundry_csrf", value: CSRF_C }],
    ],
  });
  const refreshed = await transport.auth.refresh();
  const challenged = await transport.auth.pinChallenge({
    purpose: "quick_switch",
    target_staff_id: STAFF_ID,
  });
  const switched = await transport.auth.pinVerify({
    challenge_id: CHALLENGE_ID,
    pin: "1234",
  });
  await transport.query.execute(CUSTOMER_QUERY);

  assert.equal(refreshed.ok, true);
  assert.equal(JSON.stringify(refreshed).includes(ACCESS_B), false);
  assert.equal(challenged.ok, true);
  assert.equal(switched.ok, true);
  assert.equal(JSON.stringify(switched).includes(ACCESS_C), false);
  assert.deepEqual(
    harness.requests
      .slice(2)
      .map((request) => [
        new URL(request.url).pathname,
        request.headers.Authorization,
        request.headers["X-CSRF-Token"],
      ]),
    [
      ["/api/v2/auth/refresh", undefined, CSRF_A],
      ["/api/v2/auth/pin/challenges", `Bearer ${ACCESS_B}`, CSRF_B],
      [`/api/v2/auth/pin/challenges/${CHALLENGE_ID}/verify`, `Bearer ${ACCESS_B}`, CSRF_B],
      ["/v1/queries/customer.search", `Bearer ${ACCESS_C}`, CSRF_C],
    ],
  );
});

test("step-up PIN returns its proof without rotating the current process auth state", async () => {
  const { harness, transport } = await createAuthenticatedTransport({
    responses: [
      jsonResponse({
        ok: true,
        data: {
          step_up_proof_id: STEP_UP_PROOF_ID,
          expires_at: 2_000_000_000,
        },
      }),
      executionResponse({ customers: [] }),
    ],
  });
  const verified = await transport.auth.pinVerify({
    challenge_id: CHALLENGE_ID,
    pin: "1234",
  });
  await transport.query.execute(CUSTOMER_QUERY);

  assert.deepEqual(verified, {
    ok: true,
    data: {
      step_up_proof_id: STEP_UP_PROOF_ID,
      expires_at: 2_000_000_000,
    },
  });
  const queryRequest = harness.requests[3]!;
  assert.equal(queryRequest.headers.Authorization, `Bearer ${ACCESS_A}`);
  assert.equal(queryRequest.headers["X-CSRF-Token"], CSRF_A);
});

test("auth mutations are serialized and a superseded refresh cannot overwrite a newer login", async () => {
  const refreshStarted = deferred<void>();
  const refreshResponse = deferred<DesktopHttpResponse>();
  const { harness, transport } = await createAuthenticatedTransport({
    responses: [
      () => {
        refreshStarted.resolve();
        return refreshResponse.promise;
      },
      jsonResponse({ ok: true, data: accessSession(ACCESS_C) }),
      staffDirectoryResponse(),
      executionResponse({ customers: [] }),
    ],
    cookieReads: csrfReads(CSRF_A, CSRF_C),
  });
  const refreshing = transport.auth.refresh();
  await refreshStarted.promise;
  const relogging = transport.auth.login(LOGIN_INPUT);
  await Promise.resolve();
  assert.equal(harness.requests.length, 3);

  refreshResponse.resolve(jsonResponse({ ok: true, data: accessSession(ACCESS_B) }));
  const [refresh, login] = await Promise.all([refreshing, relogging]);
  assertFailure(refresh, "RESOURCE_UNAVAILABLE");
  assert.equal(login.ok, true);

  await transport.query.execute(CUSTOMER_QUERY);
  const queryRequest = harness.requests[5]!;
  assert.equal(queryRequest.headers.Authorization, `Bearer ${ACCESS_C}`);
  assert.equal(queryRequest.headers["X-CSRF-Token"], CSRF_C);
});

test("an invalid queued login cannot supersede a valid in-flight refresh", async () => {
  const refreshStarted = deferred<void>();
  const refreshResponse = deferred<DesktopHttpResponse>();
  const { harness, transport } = await createAuthenticatedTransport({
    responses: [
      () => {
        refreshStarted.resolve();
        return refreshResponse.promise;
      },
      executionResponse({ customers: [] }),
    ],
    cookieReads: csrfReads(CSRF_A, CSRF_B),
  });
  const refreshing = transport.auth.refresh();
  await refreshStarted.promise;
  const invalidLogin = transport.auth.login({
    ...LOGIN_INPUT,
    url: "https://attacker.invalid",
  });
  await Promise.resolve();
  refreshResponse.resolve(jsonResponse({ ok: true, data: accessSession(ACCESS_B) }));

  const [refresh, invalid] = await Promise.all([refreshing, invalidLogin]);
  assert.equal(refresh.ok, true);
  assertFailure(invalid, "VALIDATION_FAILED");

  await transport.query.execute(CUSTOMER_QUERY);
  const queryRequest = harness.requests[3]!;
  assert.equal(queryRequest.headers.Authorization, `Bearer ${ACCESS_B}`);
  assert.equal(queryRequest.headers["X-CSRF-Token"], CSRF_B);
});

test("a logout invoked while an earlier login validates prevents that login request", async () => {
  const validation = deferred<void>();
  const harness = createHarness({
    loginInputSchema: {
      async safeParseAsync(input) {
        await validation.promise;
        return DesktopLoginInputSchema.safeParseAsync(input);
      },
    },
    // prettier-ignore
    responses: [jsonResponse({ ok: true, data: { logged_out: true } }), jsonResponse({ ok: true, data: accessSession(ACCESS_A) }), staffDirectoryResponse()],
    cookieReads: csrfReads(CSRF_A, CSRF_A),
  });
  const transport = createDesktopHttpTransport(harness.dependencies);
  const login = transport.auth.login(LOGIN_INPUT);
  const logout = transport.auth.logout();
  assert.equal((await logout).ok, true);
  validation.resolve();

  assertFailure(await login, "RESOURCE_UNAVAILABLE");
  assertFailure(await transport.command.execute(CUSTOMER_COMMAND), "AUTHENTICATION_FAILED");
  assert.equal(harness.requests.length, 1);
  assert.equal(harness.requests[0]?.url, `${DESKTOP_API_BASE_URL}/api/v2/auth/logout`);
});

test("command, query, and PIN challenge suppress an old response after logout changes auth", async () => {
  const scenarios = [
    {
      name: "command",
      invoke: (transport: ReturnType<typeof createDesktopHttpTransport>) =>
        transport.command.execute(CUSTOMER_COMMAND),
      response: executionResponse({ customer_id: STAFF_ID }),
    },
    {
      name: "query",
      invoke: (transport: ReturnType<typeof createDesktopHttpTransport>) =>
        transport.query.execute(CUSTOMER_QUERY),
      response: executionResponse({ customers: [] }),
    },
    {
      name: "PIN challenge",
      invoke: (transport: ReturnType<typeof createDesktopHttpTransport>) =>
        transport.auth.pinChallenge({
          purpose: "quick_switch",
          target_staff_id: STAFF_ID,
        }),
      response: jsonResponse({
        ok: true,
        data: {
          challenge_id: CHALLENGE_ID,
          purpose: "quick_switch",
          expires_at: 2_000_000_000,
          max_attempts: 5,
        },
      }),
    },
  ] as const;

  for (const scenario of scenarios) {
    const started = deferred<void>();
    const pendingResponse = deferred<DesktopHttpResponse>();
    const { transport } = await createAuthenticatedTransport({
      responses: [
        () => {
          started.resolve();
          return pendingResponse.promise;
        },
        jsonResponse({ ok: true, data: { logged_out: true } }),
      ],
      cookieReads: [[{ name: "laundry_csrf", value: CSRF_A }]],
    });
    const pending = scenario.invoke(transport);
    await started.promise;
    assert.equal((await transport.auth.logout()).ok, true);
    pendingResponse.resolve(scenario.response);
    const result = await pending;

    assertFailure(
      result,
      "RESOURCE_UNAVAILABLE",
      `${scenario.name} leaked an old-session response`,
    );
  }
});

test("a malformed successful refresh clears rotated cookies and process auth state", async () => {
  const malformedAccess = {
    ...accessSession(ACCESS_B),
    expires_in: 901,
  };
  const { harness, transport } = await createAuthenticatedTransport({
    responses: [jsonResponse({ ok: true, data: malformedAccess })],
    cookieReads: [[{ name: "laundry_csrf", value: CSRF_A }]],
  });
  const refresh = await transport.auth.refresh();
  const command = await transport.command.execute(CUSTOMER_COMMAND);

  assertFailure(refresh, "RESOURCE_UNAVAILABLE");
  assert.deepEqual(harness.clearedUrls, [DESKTOP_API_BASE_URL]);
  assertFailure(command, "AUTHENTICATION_FAILED");
  assert.equal(harness.requests.length, 3);
});

test("missing rotated CSRF after valid refresh or quick-switch access clears all auth state", async () => {
  const scenarios = [
    {
      name: "refresh",
      cookieReads: [
        [{ name: "laundry_csrf", value: CSRF_A }],
        [{ name: "laundry_csrf", value: CSRF_A }],
        [],
      ],
      invoke: (transport: ReturnType<typeof createDesktopHttpTransport>) =>
        transport.auth.refresh(),
    },
    {
      name: "quick-switch",
      cookieReads: [[{ name: "laundry_csrf", value: CSRF_A }], []],
      invoke: (transport: ReturnType<typeof createDesktopHttpTransport>) =>
        transport.auth.pinVerify({
          challenge_id: CHALLENGE_ID,
          pin: "1234",
        }),
    },
  ] as const;

  for (const scenario of scenarios) {
    const { harness, transport } = await createAuthenticatedTransport({
      responses: [jsonResponse({ ok: true, data: accessSession(ACCESS_B, STAFF_ID, "Staff") })],
      cookieReads: scenario.cookieReads.slice(1),
    });
    const result = await scenario.invoke(transport);
    const command = await transport.command.execute(CUSTOMER_COMMAND);

    assertFailure(result, "RESOURCE_UNAVAILABLE", `${scenario.name} accepted missing rotated CSRF`);
    assert.deepEqual(harness.clearedUrls, [DESKTOP_API_BASE_URL]);
    assertFailure(command, "AUTHENTICATION_FAILED");
    assert.equal(harness.requests.length, 3);
  }
});

test("login rejects ambiguous local and secure CSRF cookie candidates", async () => {
  const harness = createHarness({
    responses: [jsonResponse({ ok: true, data: accessSession(ACCESS_A) })],
    cookieReads: [
      [
        { name: "laundry_csrf", value: CSRF_A },
        { name: "__Host-laundry_csrf", value: CSRF_B },
      ],
    ],
  });
  const transport = createDesktopHttpTransport(harness.dependencies);

  const result = await transport.auth.login(LOGIN_INPUT);

  assertFailure(result, "CSRF_REJECTED");
  assert.deepEqual(harness.clearedUrls, [DESKTOP_API_BASE_URL]);
  assert.equal(harness.requests.length, 1);
});

test("a malformed post-login staff response never commits the access token", async () => {
  const harness = createHarness({
    responses: [
      jsonResponse({ ok: true, data: accessSession(ACCESS_A) }),
      jsonResponse({ ok: true, data: { username: "not-a-directory" } }),
    ],
    cookieReads: [[{ name: "laundry_csrf", value: CSRF_A }]],
  });
  const transport = createDesktopHttpTransport(harness.dependencies);

  const login = await transport.auth.login(LOGIN_INPUT);
  const command = await transport.command.execute(CUSTOMER_COMMAND);

  assertFailure(login, "RESOURCE_UNAVAILABLE");
  assertFailure(command, "AUTHENTICATION_FAILED");
  assert.deepEqual(harness.clearedUrls, [DESKTOP_API_BASE_URL]);
  assert.equal(harness.requests.length, 2);
});

test("logout clears process state and session cookies even when the server is unreachable", async () => {
  const { harness, transport } = await createAuthenticatedTransport({
    responses: [new Error("connection refused")],
    cookieReads: [[{ name: "laundry_csrf", value: CSRF_A }]],
  });

  const logout = await transport.auth.logout();
  const afterLogout = await transport.command.execute(CUSTOMER_COMMAND);

  assertFailure(logout, "RESOURCE_UNAVAILABLE");
  assert.deepEqual(harness.clearedUrls, [DESKTOP_API_BASE_URL]);
  assertFailure(afterLogout, "AUTHENTICATION_FAILED");
  assert.equal(harness.requests.length, 3);
});

test("a near-expiry command refreshes before sending and uses only rotated process credentials", async () => {
  let now = 0;
  const { harness, transport } = await createAuthenticatedTransport({
    nowMs: () => now,
    responses: [
      jsonResponse({ ok: true, data: accessSession(ACCESS_B) }),
      executionResponse({ customer_id: STAFF_ID }),
    ],
    cookieReads: csrfReads(CSRF_A, CSRF_B),
  });
  now = 899_001;
  const result = await transport.command.execute(CUSTOMER_COMMAND);
  assert.equal(result.ok, true);
  assert.deepEqual(
    harness.requests.slice(2).map((request) => new URL(request.url).pathname),
    ["/api/v2/auth/refresh", "/v1/commands/customer.upsert"],
  );
  assert.equal(harness.requests[3]?.headers.Authorization, `Bearer ${ACCESS_B}`);
  assert.equal(harness.requests[3]?.headers["X-CSRF-Token"], CSRF_B);
});

test("an explicit authentication failure refreshes and retries a query exactly once", async () => {
  const { harness, transport } = await createAuthenticatedTransport({
    responses: [
      failureResponse("AUTHENTICATION_FAILED", "Authentication failed", 401),
      jsonResponse({ ok: true, data: accessSession(ACCESS_B) }),
      executionResponse({ customers: [] }),
    ],
    cookieReads: csrfReads(CSRF_A, CSRF_B),
  });
  const result = await transport.query.execute(CUSTOMER_QUERY);
  assert.equal(result.ok, true);
  assert.deepEqual(
    harness.requests.slice(2).map((request) => new URL(request.url).pathname),
    ["/v1/queries/customer.search", "/api/v2/auth/refresh", "/v1/queries/customer.search"],
  );
  assert.equal(harness.requests[4]?.headers.Authorization, `Bearer ${ACCESS_B}`);
});

test("protected operations fail closed without unsafe business retries", async () => {
  for (const scenario of [
    {
      expires: true,
      response: failureResponse("AUTHENTICATION_FAILED", "Authentication failed", 401),
      path: "/api/v2/auth/refresh",
    },
    {
      expires: false,
      response: failureResponse("TRANSACTION_FAILED", "Command transaction failed", 500),
      path: "/v1/commands/customer.upsert",
    },
  ]) {
    let now = 0;
    const { harness, transport } = await createAuthenticatedTransport({
      nowMs: () => now,
      responses: [scenario.response],
      cookieReads: csrfReads(CSRF_A),
    });
    if (scenario.expires) now = 899_001;
    assert.equal((await transport.command.execute(CUSTOMER_COMMAND)).ok, false);
    assert.deepEqual(
      harness.requests.slice(2).map((request) => new URL(request.url).pathname),
      [scenario.path],
    );
  }
});

test("concurrent near-expiry operations share one serialized refresh", async () => {
  let now = 0;
  const started = deferred<void>();
  const refresh = deferred<DesktopHttpResponse>();
  const respond = (request: DesktopHttpRequest) =>
    request.url.includes("/commands/")
      ? executionResponse({ customer_id: STAFF_ID })
      : executionResponse({ customers: [] });
  const { harness, transport } = await createAuthenticatedTransport({
    nowMs: () => now,
    responses: [
      () => {
        started.resolve();
        return refresh.promise;
      },
      respond,
      respond,
    ],
    cookieReads: csrfReads(CSRF_A, CSRF_B),
  });
  now = 899_001;
  const command = transport.command.execute(CUSTOMER_COMMAND);
  await started.promise;
  const query = transport.query.execute(CUSTOMER_QUERY);
  await Promise.resolve();
  assert.equal(harness.requests.length, 3);
  refresh.resolve(jsonResponse({ ok: true, data: accessSession(ACCESS_B) }));
  assert.deepEqual(
    (await Promise.all([command, query])).map((result) => result.ok),
    [true, true],
  );
  assert.equal(
    harness.requests.filter((request) => request.url.endsWith("/auth/refresh")).length,
    1,
  );
});
