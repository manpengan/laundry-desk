import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ADR36_PUBLIC_ORIGIN,
  applySetCookieHeaders,
  createAcceptanceClient,
  isDirectEntrypoint,
  loadAcceptanceCredentials,
  readProtectedSecretFile,
  runAcceptance,
} from "./adr36-web-acceptance.mjs";
import {
  ADMIN_ID,
  TEST_EXTENSIONS,
  acceptanceEnvironment,
  authCookies,
  createFakeCloud,
  jsonResponse,
  sequentialUuid,
} from "./adr36-web-acceptance.test-support.mjs";

test("protected credential files require absolute regular 0600 single-line sources", async () => {
  const root = await mkdtemp(join(tmpdir(), "adr36-secrets-"));
  try {
    const good = join(root, "good");
    const loose = join(root, "loose");
    const multiline = join(root, "multiline");
    const link = join(root, "link");
    await writeFile(good, "secret", { mode: 0o600 });
    await writeFile(loose, "secret", { mode: 0o600 });
    await chmod(loose, 0o640);
    await writeFile(multiline, "secret\n", { mode: 0o600 });
    await symlink(good, link);
    assert.equal(readProtectedSecretFile(good), "secret");
    assert.throws(() => readProtectedSecretFile("relative"), { code: "SECRET_FILE_PATH_INVALID" });
    assert.throws(() => readProtectedSecretFile(loose), { code: "SECRET_FILE_MODE_INVALID" });
    assert.throws(() => readProtectedSecretFile(multiline), { code: "SECRET_VALUE_INVALID" });
    assert.throws(() => readProtectedSecretFile(link), { code: "SECRET_FILE_INVALID" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("entrypoint detection supports a direct temp file and Node ESM stdin", () => {
  assert.equal(isDirectEntrypoint("/tmp/adr36.mjs", "file:///tmp/adr36.mjs"), true);
  assert.equal(isDirectEntrypoint("-", "file:///srv/laundry/[eval1]"), true);
  assert.equal(isDirectEntrypoint("-", "file:///srv/laundry/imported.mjs"), false);
});

test("public __Host cookies reject a Domain attribute", () => {
  const headers = new Headers();
  headers.append(
    "set-cookie",
    "__Host-laundry_refresh=secret; Domain=desk.manpengan.xyz; Path=/; HttpOnly; Secure; SameSite=Strict",
  );
  assert.throws(() => applySetCookieHeaders({}, headers), { code: "COOKIE_SECURITY_INVALID" });
});

test("chunked responses are cancelled before exceeding the byte limit", async () => {
  const env = acceptanceEnvironment();
  let cancelled = false;
  let pulls = 0;
  const body = new ReadableStream({
    pull(controller) {
      pulls += 1;
      controller.enqueue(new Uint8Array(600 * 1024));
    },
    cancel() {
      cancelled = true;
    },
  });
  const headers = new Headers({ "content-type": "application/json" });
  for (const cookie of authCookies(1)) headers.append("set-cookie", cookie);
  const api = createAcceptanceClient({
    fetchImpl: async () => new Response(body, { status: 200, headers }),
    randomUUID: sequentialUuid(),
  });
  await assert.rejects(() => api.login(loadAcceptanceCredentials(env).admin), {
    code: "RESPONSE_TOO_LARGE",
  });
  assert.equal(cancelled, true);
  assert.ok(pulls >= 2 && pulls <= 3);
});

test("refresh accepts an unchanged access token when both cookies rotate", async () => {
  const env = acceptanceEnvironment();
  const cloud = createFakeCloud(env, { sameAccessTokenOnRefresh: true });
  const api = createAcceptanceClient({
    fetchImpl: cloud.fetchImpl,
    randomUUID: sequentialUuid(),
  });
  const principal = loadAcceptanceCredentials(env).admin;
  const login = await api.login(principal);
  const refreshed = await api.refresh(login);
  assert.equal(refreshed.accessToken === login.accessToken, true);
  assert.equal(refreshed.sessionVersion, login.sessionVersion);
  assert.equal(refreshed.permissionVersion, login.permissionVersion);
  assert.equal(refreshed.sessionId, login.sessionId);
  assert.equal(
    refreshed.cookies["__Host-laundry_refresh"] !== login.cookies["__Host-laundry_refresh"],
    true,
  );
  assert.equal(
    refreshed.cookies["__Host-laundry_csrf"] !== login.cookies["__Host-laundry_csrf"],
    true,
  );
  const directory = await api.staff(refreshed);
  assert.equal(Array.isArray(directory), true);
});

test("refresh rejects session version drift even when both cookies rotate", async () => {
  const env = acceptanceEnvironment();
  const cloud = createFakeCloud(env, { refreshSessionVersionDrift: true });
  const api = createAcceptanceClient({
    fetchImpl: cloud.fetchImpl,
    randomUUID: sequentialUuid(),
  });
  const login = await api.login(loadAcceptanceCredentials(env).admin);
  await assert.rejects(() => api.refresh(login), { code: "REFRESH_SESSION_INVALID" });
});

test("login rejects a CSRF cookie that aliases the HttpOnly refresh secret", async () => {
  const env = acceptanceEnvironment();
  const cloud = createFakeCloud(env, { sameAuthCookieValue: true });
  const api = createAcceptanceClient({
    fetchImpl: cloud.fetchImpl,
    randomUUID: sequentialUuid(),
  });
  await assert.rejects(() => api.login(loadAcceptanceCredentials(env).admin), {
    code: "AUTH_COOKIES_INVALID",
  });
});

test("login strictly rejects extra access-session fields", async () => {
  const env = acceptanceEnvironment();
  const cloud = createFakeCloud(env, { extraAuthField: true });
  const api = createAcceptanceClient({
    fetchImpl: cloud.fetchImpl,
    randomUUID: sequentialUuid(),
  });
  await assert.rejects(() => api.login(loadAcceptanceCredentials(env).admin), {
    code: "ACCESS_SESSION_INVALID",
  });
});

test("rejected stale refresh must clear both browser cookies", async () => {
  const api = createAcceptanceClient({
    fetchImpl: async () =>
      jsonResponse(
        {
          ok: false,
          error: { code: "AUTHENTICATION_FAILED", message: "private stale session detail" },
        },
        401,
        authCookies(0, true),
      ),
    randomUUID: sequentialUuid(),
  });
  await api.expectRefreshFailure({
    accessToken: "stale-access-token",
    staffId: ADMIN_ID,
    role: "staff",
    cookies: Object.freeze({
      "__Host-laundry_refresh": "stale-refresh",
      "__Host-laundry_csrf": "stale-csrf",
    }),
  });
});

test("logout requires both the old bearer and old refresh family to be revoked", async () => {
  const env = acceptanceEnvironment();
  const cloud = createFakeCloud(env, { ignoreLogoutRevocation: true });
  const api = createAcceptanceClient({
    fetchImpl: cloud.fetchImpl,
    randomUUID: sequentialUuid(),
  });
  const session = await api.login(loadAcceptanceCredentials(env).admin);
  await assert.rejects(() => api.logout(session), { code: "EXPECTED_STAFF_FAILURE_MISSING" });
});

test("admin and approver support exclusive direct or protected _FILE sources", async () => {
  const root = await mkdtemp(join(tmpdir(), "adr36-principals-"));
  try {
    const values = acceptanceEnvironment();
    const fileEnv = {};
    for (const [name, value] of Object.entries(values)) {
      const path = join(root, name.toLowerCase());
      await writeFile(path, value, { mode: 0o600 });
      fileEnv[`${name}_FILE`] = path;
    }
    const loaded = loadAcceptanceCredentials(fileEnv);
    assert.equal(loaded.admin.username, values.LAUNDRY_BOOTSTRAP_ADMIN_USERNAME);
    assert.equal(loaded.approver.pin, values.LAUNDRY_BOOTSTRAP_APPROVER_PIN);
    assert.throws(
      () =>
        loadAcceptanceCredentials({
          ...fileEnv,
          LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD: values.LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD,
        }),
      { code: "SECRET_SOURCE_AMBIGUOUS" },
    );
    assert.throws(
      () =>
        loadAcceptanceCredentials({
          ...values,
          LAUNDRY_BOOTSTRAP_APPROVER_PIN: values.LAUNDRY_BOOTSTRAP_ADMIN_PIN,
        }),
      { code: "ADMIN_CREDENTIALS_NOT_DISTINCT" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("full ADR-36 API journey is canonical, synthetic, blocked where unsafe, and output-redacted", async () => {
  const env = acceptanceEnvironment();
  const cloud = createFakeCloud(env);
  const lines = [];
  const report = await runAcceptance({
    ...TEST_EXTENSIONS,
    env,
    fetchImpl: cloud.fetchImpl,
    randomUUID: sequentialUuid(),
    now: () => new Date("2026-08-09T12:34:56.000Z"),
    writeLine: (line) => lines.push(line),
  });
  assert.equal(report.exitCode, 2);
  const output = lines.join("\n");
  assert.match(output, /^ADR36 run-id ADR36-20260809T123456Z-/mu);
  assert.match(output, /catalog_price PASS/u);
  assert.match(output, /staff_credentials PASS/u);
  assert.match(output, /order_finance PASS/u);
  assert.match(output, /reporting_exports_shift PASS/u);
  assert.match(output, /safe_cleanup PASS/u);
  assert.match(output, /reminder_history BLOCKED AUDITED_TIME_FIXTURE_REQUIRED/u);
  assert.match(output, /overall BLOCKED PARTIAL_ACCEPTANCE_ONLY/u);
  for (const secret of Object.values(env)) assert.doesNotMatch(output, new RegExp(secret, "u"));
  assert.doesNotMatch(output, /secret-cookie|private\.|13800000/u);
  assert.ok(cloud.requests.every((request) => request.options.redirect === "error"));
  assert.ok(
    cloud.requests.every((request) => request.options.headers.origin === ADR36_PUBLIC_ORIGIN),
  );
  assert.equal(
    cloud.requests.filter((request) => request.url.pathname === "/api/v2/auth/logout").length,
    2,
  );
  assert.equal(
    cloud.requests.some((request) => request.options.method === "DELETE"),
    false,
  );
  assert.equal(
    cloud.requests.some((request) => /reminder|shift/u.test(request.url.pathname)),
    false,
  );
  const commandRequests = cloud.requests.filter((request) =>
    request.url.pathname.startsWith("/v1/commands/"),
  );
  assert.ok(
    commandRequests.every(
      (request) => request.body.mode === "direct" || request.body.mode === "confirm",
    ),
  );
  const customerRequest = commandRequests.find(
    (request) => request.body.command === "customer.upsert",
  );
  assert.match(customerRequest.body.args.phone, /^13800000\d{3}$/u);
  assert.match(customerRequest.body.args.name, /^ADR36 UAT /u);
  const memberBalancePays = commandRequests.filter(
    (request) => request.body.command === "member.balance.pay" && request.body.mode === "direct",
  );
  assert.equal(memberBalancePays.length, 2);
  assert.deepEqual(memberBalancePays[0].body.args, memberBalancePays[1].body.args);
});

test("remote failure bodies and credentials never enter failure output", async () => {
  const env = acceptanceEnvironment();
  const lines = [];
  const report = await runAcceptance({
    ...TEST_EXTENSIONS,
    env,
    randomUUID: sequentialUuid(),
    now: () => new Date("2026-08-09T12:34:56.000Z"),
    writeLine: (line) => lines.push(line),
    fetchImpl: async () =>
      jsonResponse(
        {
          ok: false,
          error: {
            code: "AUTHENTICATION_FAILED",
            message: `${env.LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD} server-private-detail`,
          },
        },
        401,
      ),
  });
  const output = lines.join("\n");
  assert.equal(report.exitCode, 1);
  assert.match(output, /dual_admin_auth FAIL REMOTE_AUTHENTICATION_FAILED/u);
  assert.doesNotMatch(output, /Admin-Secret|server-private-detail/u);
});

test("unknown remote error codes collapse before acceptance output", async () => {
  const env = acceptanceEnvironment();
  const lines = [];
  const report = await runAcceptance({
    ...TEST_EXTENSIONS,
    env,
    randomUUID: sequentialUuid(),
    now: () => new Date("2026-08-09T12:34:56.000Z"),
    writeLine: (line) => lines.push(line),
    fetchImpl: async () =>
      jsonResponse(
        {
          ok: false,
          error: { code: "ADMIN_SECRET_DO_NOT_PRINT", message: "private detail" },
        },
        500,
      ),
  });
  const output = lines.join("\n");
  assert.equal(report.exitCode, 1);
  assert.match(output, /dual_admin_auth FAIL REMOTE_REQUEST_FAILED/u);
  assert.doesNotMatch(output, /ADMIN_SECRET_DO_NOT_PRINT|private detail/u);
});

test("step-up proof must be a UUID before confirmation", async () => {
  const env = acceptanceEnvironment();
  const cloud = createFakeCloud(env, { invalidStepUpProof: true });
  const lines = [];
  const report = await runAcceptance({
    ...TEST_EXTENSIONS,
    env,
    fetchImpl: cloud.fetchImpl,
    randomUUID: sequentialUuid(),
    now: () => new Date("2026-08-09T12:34:56.000Z"),
    writeLine: (line) => lines.push(line),
  });
  const output = lines.join("\n");
  assert.equal(report.exitCode, 1);
  assert.match(output, /member_lifecycle FAIL PIN_PROOF_INVALID/u);
  assert.doesNotMatch(output, /proof-not-a-uuid/u);
});

test("catalog post-commit bad JSON preserves cleanup intent without leaking the body", async () => {
  const env = acceptanceEnvironment();
  const privateBody = `${env.LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD} catalog-private-response`;
  const cloud = createFakeCloud(env, {
    postCommitFailures: [{ command: "catalog.item.upsert", kind: "bad-json", privateBody }],
  });
  const lines = [];
  const report = await runAcceptance({
    ...TEST_EXTENSIONS,
    env,
    fetchImpl: cloud.fetchImpl,
    randomUUID: sequentialUuid(),
    now: () => new Date("2026-08-09T12:34:56.000Z"),
    writeLine: (line) => lines.push(line),
  });
  const output = lines.join("\n");
  assert.equal(report.exitCode, 1);
  assert.match(output, /catalog_price FAIL RESPONSE_JSON_INVALID/u);
  assert.match(output, /safe_cleanup FAIL CLEANUP_INCOMPLETE/u);
  assert.match(output, /overall FAIL RESPONSE_JSON_INVALID/u);
  assert.doesNotMatch(output, /catalog-private-response/u);
  for (const credential of Object.values(env)) {
    assert.doesNotMatch(output, new RegExp(credential, "u"));
  }
  const catalogWrites = cloud.requests.filter(
    (request) =>
      request.url.pathname === "/v1/commands/catalog.item.upsert" && request.body.mode === "direct",
  );
  assert.equal(catalogWrites.filter((request) => request.body.args.is_active === true).length, 1);
  assert.equal(catalogWrites.filter((request) => request.body.args.is_active === false).length, 1);
});

test("order receive post-commit network failure remains an unsafe cleanup failure", async () => {
  const env = acceptanceEnvironment();
  const privateBody = `${env.LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD} order-private-network-detail`;
  const cloud = createFakeCloud(env, {
    postCommitFailures: [{ command: "order.receive", kind: "network", privateBody }],
  });
  const lines = [];
  const report = await runAcceptance({
    ...TEST_EXTENSIONS,
    env,
    fetchImpl: cloud.fetchImpl,
    randomUUID: sequentialUuid(),
    now: () => new Date("2026-08-09T12:34:56.000Z"),
    writeLine: (line) => lines.push(line),
  });
  const output = lines.join("\n");
  assert.equal(report.exitCode, 1);
  assert.match(output, /cash_order_fulfillment FAIL NETWORK_REQUEST_FAILED/u);
  assert.match(output, /safe_cleanup FAIL CLEANUP_INCOMPLETE/u);
  assert.match(output, /overall FAIL NETWORK_REQUEST_FAILED/u);
  assert.doesNotMatch(output, /order-private-network-detail|secret-cookie|private\./u);
  for (const credential of Object.values(env)) {
    assert.doesNotMatch(output, new RegExp(credential, "u"));
  }
  assert.equal(
    cloud.requests.filter((request) => request.url.pathname === "/v1/commands/order.receive")
      .length,
    1,
  );
});

test("a post-commit login response failure cannot report safe cleanup", async () => {
  const env = acceptanceEnvironment();
  const cloud = createFakeCloud(env, { loginBadJsonAfterCommit: true });
  const lines = [];
  const report = await runAcceptance({
    ...TEST_EXTENSIONS,
    env,
    fetchImpl: cloud.fetchImpl,
    randomUUID: sequentialUuid(),
    now: () => new Date("2026-08-09T12:34:56.000Z"),
    writeLine: (line) => lines.push(line),
  });
  const output = lines.join("\n");
  assert.equal(report.exitCode, 1);
  assert.match(output, /dual_admin_auth FAIL RESPONSE_JSON_INVALID/u);
  assert.match(output, /safe_cleanup FAIL CLEANUP_INCOMPLETE/u);
  assert.doesNotMatch(output, /private committed login response/u);
});
