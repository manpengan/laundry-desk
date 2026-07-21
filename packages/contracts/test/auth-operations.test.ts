import { describe, expect, it } from "vitest";

import * as PublicContracts from "../src/index.js";
import { issueIdentityLifecycleEnvelope } from "../src/auth/browser-ingress.js";
import {
  AUTH_OPERATION_MATRIX,
  AccessSessionResponseSchema,
  EmptyBodySchema,
  LoginRequestSchema,
  LogoutResponseSchema,
  PinChallengeRequestSchema,
  PinChallengeResponseSchema,
  PinVerifyRequestSchema,
  PinVerifyResponseSchema,
  isIdentityLifecycleEnvelope,
} from "../src/auth/operations.js";

const ids = {
  request: "10000000-0000-4000-8000-000000000001",
  session: "10000000-0000-4000-8000-000000000002",
  org: "10000000-0000-4000-8000-000000000003",
  store: "10000000-0000-4000-8000-000000000004",
  staff: "10000000-0000-4000-8000-000000000005",
  device: "10000000-0000-4000-8000-000000000006",
  target: "10000000-0000-4000-8000-000000000007",
  approver: "10000000-0000-4000-8000-000000000008",
  challenge: "10000000-0000-4000-8000-000000000009",
  proof: "10000000-0000-4000-8000-00000000000a",
} as const;

const loginBody = {
  org_code: "org-001",
  store_code: "store-001",
  username: "cashier-001",
  password: "correct horse battery staple",
  device_id: ids.device,
} as const;

const lifecycleInput = (operation: "identity.login" | "identity.refresh" | "identity.logout") => ({
  operation,
  request_id: ids.request,
  body: operation === "identity.login" ? loginBody : {},
  ingress: {
    kind: "lifecycle_http",
    origin_verified: true,
    fetch_metadata_verified: true,
    refresh_session_verified: operation !== "identity.login",
    csrf_verified: operation !== "identity.login",
  },
});

const accessSessionResponse = {
  access_token: "header.payload.signature",
  token_type: "Bearer",
  expires_in: 900,
  storage: "memory_only",
  session: {
    session_id: ids.session,
    session_version: 1,
    org_id: ids.org,
    store_id: ids.store,
    staff_id: ids.staff,
    device_id: ids.device,
    permission_version: 1,
  },
} as const;

const expectedAuthErrors = [
  {
    code: "AUTHENTICATION_FAILED",
    message: "Authentication failed",
    http_status: 401,
  },
  {
    code: "CSRF_REJECTED",
    message: "Request origin verification failed",
    http_status: 403,
  },
  {
    code: "RATE_LIMITED",
    message: "Too many requests",
    http_status: 429,
  },
] as const;

const expectedLifecycleErrors = [
  "VALIDATION_FAILED",
  "AUTHENTICATION_FAILED",
  "CSRF_REJECTED",
  "RATE_LIMITED",
  "TRANSACTION_FAILED",
  "EVENT_DISPATCH_FAILED",
] as const;

const expectedPinErrors = [
  "VALIDATION_FAILED",
  "AUTHENTICATION_FAILED",
  "PERMISSION_DENIED",
  "RESOURCE_UNAVAILABLE",
  "CSRF_REJECTED",
  "RATE_LIMITED",
  "INVARIANT_FAILED",
  "TRANSACTION_FAILED",
  "EVENT_DISPATCH_FAILED",
] as const;

const expectedOperationMatrix = [
  {
    operation: "login",
    command: "identity.login",
    method: "POST",
    path: "/api/v2/auth/login",
    ingress: "lifecycle_http",
    requirements: {
      origin: "required",
      fetch_metadata: "required",
      access: "forbidden",
      refresh_cookie: "forbidden",
      csrf: "not_required",
      allowed_surfaces: ["browser_http"],
      offline: false,
    },
    cookie_effects: { refresh: "set", csrf: "set" },
    request_schema_id: "auth.login.request",
    response_schema_id: "auth.access_session.response",
    allowed_public_errors: expectedLifecycleErrors,
    auth_error_descriptors: expectedAuthErrors,
    request_schema: "zod",
    response_schema: "zod",
  },
  {
    operation: "refresh",
    command: "identity.refresh",
    method: "POST",
    path: "/api/v2/auth/refresh",
    ingress: "lifecycle_http",
    requirements: {
      origin: "required",
      fetch_metadata: "required",
      access: "not_required",
      refresh_cookie: "required",
      csrf: "required",
      allowed_surfaces: ["browser_http"],
      offline: false,
    },
    cookie_effects: { refresh: "rotate", csrf: "rotate" },
    request_schema_id: "auth.empty.request",
    response_schema_id: "auth.access_session.response",
    allowed_public_errors: expectedLifecycleErrors,
    auth_error_descriptors: expectedAuthErrors,
    request_schema: "zod",
    response_schema: "zod",
  },
  {
    operation: "logout",
    command: "identity.logout",
    method: "POST",
    path: "/api/v2/auth/logout",
    ingress: "lifecycle_http",
    requirements: {
      origin: "required",
      fetch_metadata: "required",
      access: "not_required",
      refresh_cookie: "required",
      csrf: "required",
      allowed_surfaces: ["browser_http"],
      offline: false,
    },
    cookie_effects: { refresh: "clear", csrf: "clear" },
    request_schema_id: "auth.empty.request",
    response_schema_id: "auth.logout.response",
    allowed_public_errors: expectedLifecycleErrors,
    auth_error_descriptors: expectedAuthErrors,
    request_schema: "zod",
    response_schema: "zod",
  },
  {
    operation: "pin_challenge",
    method: "POST",
    path: "/api/v2/auth/pin/challenges",
    ingress: "browser_session",
    requirements: {
      origin: "required",
      fetch_metadata: "required",
      access: "active_required",
      refresh_cookie: "not_required",
      csrf: "required",
      allowed_surfaces: ["ui"],
      offline: false,
    },
    cookie_effects: { refresh: "none", csrf: "none" },
    request_schema_id: "auth.pin_challenge.request",
    response_schema_id: "auth.pin_challenge.response",
    allowed_public_errors: expectedPinErrors,
    auth_error_descriptors: expectedAuthErrors,
    request_schema: "zod",
    response_schema: "zod",
  },
  {
    operation: "pin_verify",
    method: "POST",
    path: "/api/v2/auth/pin/challenges/{challenge_id}/verify",
    ingress: "browser_session",
    requirements: {
      origin: "required",
      fetch_metadata: "required",
      access: "active_required",
      refresh_cookie: "not_required",
      csrf: "required",
      allowed_surfaces: ["ui"],
      offline: false,
    },
    cookie_effects: {
      quick_switch: { refresh: "replace", csrf: "replace" },
      step_up: { refresh: "none", csrf: "none" },
    },
    request_schema_id: "auth.pin_verify.request",
    response_schema_id: "auth.pin_verify.response",
    allowed_public_errors: expectedPinErrors,
    auth_error_descriptors: expectedAuthErrors,
    request_schema: "zod",
    response_schema: "zod",
  },
] as const;

describe("A5 auth operation matrix", () => {
  it("freezes the exact five browser operations and transport requirements", () => {
    expect(
      AUTH_OPERATION_MATRIX.map(({ request_schema, response_schema, ...row }) => ({
        ...row,
        request_schema: request_schema === undefined ? undefined : "zod",
        response_schema: response_schema === undefined ? undefined : "zod",
      })),
    ).toEqual(expectedOperationMatrix);

    expect(Object.isFrozen(AUTH_OPERATION_MATRIX)).toBe(true);
    AUTH_OPERATION_MATRIX.forEach((row) => {
      expect(Object.isFrozen(row)).toBe(true);
      expect(Object.isFrozen(row.requirements)).toBe(true);
      expect(Object.isFrozen(row.requirements.allowed_surfaces)).toBe(true);
      expect(Object.isFrozen(row.cookie_effects)).toBe(true);
      expect(Object.isFrozen(row.allowed_public_errors)).toBe(true);
      expect(Object.isFrozen(row.auth_error_descriptors)).toBe(true);
      expect("examples" in row).toBe(false);
    });
  });

  it("binds every row to its exact browser request and response schema", () => {
    const exactFiveRows: 5 = AUTH_OPERATION_MATRIX.length;
    const exactLifecycleErrors: 6 = AUTH_OPERATION_MATRIX[0].allowed_public_errors.length;
    const exactAuthErrorDescriptors: 3 = AUTH_OPERATION_MATRIX[0].auth_error_descriptors.length;
    expect([exactFiveRows, exactLifecycleErrors, exactAuthErrorDescriptors]).toEqual([5, 6, 3]);
    expect(AUTH_OPERATION_MATRIX.map((row) => row.request_schema)).toEqual([
      LoginRequestSchema,
      EmptyBodySchema,
      EmptyBodySchema,
      PinChallengeRequestSchema,
      PinVerifyRequestSchema,
    ]);
    expect(AUTH_OPERATION_MATRIX.map((row) => row.response_schema)).toEqual([
      AccessSessionResponseSchema,
      AccessSessionResponseSchema,
      LogoutResponseSchema,
      PinChallengeResponseSchema,
      PinVerifyResponseSchema,
    ]);
  });
});

describe("A5 browser auth schemas", () => {
  it("accepts only the exact login and empty-body requests", () => {
    expect(LoginRequestSchema.parse(loginBody)).toEqual(loginBody);
    expect(EmptyBodySchema.parse({})).toEqual({});
    expect(() => LoginRequestSchema.parse({ ...loginBody, actor: ids.staff })).toThrow();
    expect(() => EmptyBodySchema.parse({ refresh_token: "secret" })).toThrow();
  });

  it("uses a strict discriminated PIN challenge request and a secret-only verify request", () => {
    expect(
      PinChallengeRequestSchema.parse({ purpose: "quick_switch", target_staff_id: ids.target }),
    ).toEqual({ purpose: "quick_switch", target_staff_id: ids.target });
    expect(
      PinChallengeRequestSchema.parse({
        purpose: "step_up",
        pending_action_ref: "pending:order.refund:1",
        approver_staff_id: ids.approver,
      }),
    ).toEqual({
      purpose: "step_up",
      pending_action_ref: "pending:order.refund:1",
      approver_staff_id: ids.approver,
    });
    expect(PinVerifyRequestSchema.parse({ challenge_id: ids.challenge, pin: "1234" })).toEqual({
      challenge_id: ids.challenge,
      pin: "1234",
    });
    expect(() =>
      PinChallengeRequestSchema.parse({
        purpose: "quick_switch",
        target_staff_id: ids.target,
        approver_staff_id: ids.approver,
      }),
    ).toThrow();
    expect(() =>
      PinVerifyRequestSchema.parse({ challenge_id: ids.challenge, pin: "１２３４" }),
    ).toThrow();
  });

  it("returns only memory-only access/session and browser-safe auth results", () => {
    expect(AccessSessionResponseSchema.parse(accessSessionResponse)).toEqual(accessSessionResponse);
    expect(LogoutResponseSchema.parse({ logged_out: true })).toEqual({ logged_out: true });
    expect(
      PinChallengeResponseSchema.parse({
        challenge_id: ids.challenge,
        purpose: "quick_switch",
        expires_at: 2_000,
        max_attempts: 5,
      }),
    ).toEqual({
      challenge_id: ids.challenge,
      purpose: "quick_switch",
      expires_at: 2_000,
      max_attempts: 5,
    });
    expect(PinVerifyResponseSchema.parse(accessSessionResponse)).toEqual(accessSessionResponse);
    expect(
      PinVerifyResponseSchema.parse({ step_up_proof_id: ids.proof, expires_at: 2_000 }),
    ).toEqual({ step_up_proof_id: ids.proof, expires_at: 2_000 });
  });

  it("does not expose request secrets or server bindings in examples or responses", () => {
    expect(LoginRequestSchema.meta()?.examples).toBeUndefined();
    expect(PinVerifyRequestSchema.meta()?.examples).toBeUndefined();

    const forbidden = {
      password: "password-secret",
      pin: "1234",
      refresh_token: "refresh-secret",
      csrf_token: "csrf-secret",
      token_hash: "hash-secret",
      challenge_binding: { session_id: ids.session },
    };
    [
      AccessSessionResponseSchema,
      LogoutResponseSchema,
      PinChallengeResponseSchema,
      PinVerifyResponseSchema,
    ].forEach((schema) =>
      expect(schema.safeParse({ ...accessSessionResponse, ...forbidden }).success).toBe(false),
    );
    expect(JSON.stringify(AUTH_OPERATION_MATRIX)).not.toMatch(
      /password-secret|1234|refresh-secret|csrf-secret|hash-secret/u,
    );
  });

  it("does not echo password or PIN values in validation failures", () => {
    const password = "password-value-that-must-not-leak";
    const malformedPin = "12 34-pin-value-that-must-not-leak";
    const failures = [
      () => LoginRequestSchema.parse({ ...loginBody, password, extra: true }),
      () => PinVerifyRequestSchema.parse({ challenge_id: ids.challenge, pin: malformedPin }),
    ];

    failures.forEach((action, index) => {
      let failure: unknown;
      try {
        action();
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).not.toContain(index === 0 ? password : malformedPin);
    });
  });
});

describe("A5 identity lifecycle ingress provenance", () => {
  it.each(["identity.login", "identity.refresh", "identity.logout"] as const)(
    "issues a deep-frozen, provenance-checked %s envelope",
    (operation) => {
      const input = lifecycleInput(operation);
      const envelope = issueIdentityLifecycleEnvelope(input);

      expect(envelope).toEqual(lifecycleInput(operation));
      expect(isIdentityLifecycleEnvelope(envelope)).toBe(true);
      expect(Object.isFrozen(envelope)).toBe(true);
      expect(Object.isFrozen(envelope.body)).toBe(true);
      expect(Object.isFrozen(envelope.ingress)).toBe(true);
      ["actor", "tenant", "dry_run", "confirm_ref", "idempotency_key", "via"].forEach((key) =>
        expect(envelope).not.toHaveProperty(key),
      );
      expect(isIdentityLifecycleEnvelope({ ...envelope })).toBe(false);
      expect(isIdentityLifecycleEnvelope(JSON.parse(JSON.stringify(envelope)))).toBe(false);
      expect(input).toEqual(lifecycleInput(operation));
      expect(Object.isFrozen(input)).toBe(false);
      expect(Object.isFrozen(input.body)).toBe(false);
      expect(Object.isFrozen(input.ingress)).toBe(false);
    },
  );

  it("enforces operation/body pairing and the exact login versus refresh/logout gate facts", () => {
    expect(() =>
      issueIdentityLifecycleEnvelope({ ...lifecycleInput("identity.login"), body: {} }),
    ).toThrow();
    expect(() =>
      issueIdentityLifecycleEnvelope({
        ...lifecycleInput("identity.refresh"),
        body: loginBody,
      }),
    ).toThrow();

    const login = lifecycleInput("identity.login");
    const refresh = lifecycleInput("identity.refresh");
    [
      { ...login, ingress: { ...login.ingress, csrf_verified: true } },
      { ...login, ingress: { ...login.ingress, refresh_session_verified: true } },
      { ...refresh, ingress: { ...refresh.ingress, csrf_verified: false } },
      { ...refresh, ingress: { ...refresh.ingress, refresh_session_verified: false } },
      { ...refresh, ingress: { ...refresh.ingress, origin_verified: false } },
      { ...refresh, ingress: { ...refresh.ingress, fetch_metadata_verified: false } },
    ].forEach((input) => expect(() => issueIdentityLifecycleEnvelope(input)).toThrow());
  });

  it("rejects caller-controlled identity, execution modes and unsupported lifecycle operations", () => {
    const login = lifecycleInput("identity.login");
    [
      { ...login, actor: { staff_id: ids.staff } },
      { ...login, tenant: { org_id: ids.org, store_id: ids.store } },
      { ...login, dry_run: false },
      { ...login, confirm_ref: ids.request },
      { ...login, via: "ui" },
      { ...login, operation: "identity.pin_verify" },
    ].forEach((input) => expect(() => issueIdentityLifecycleEnvelope(input)).toThrow());
  });

  it("snapshots unknown input without executing accessors and rejects non-plain or unstable data", () => {
    let getterReads = 0;
    const accessor = lifecycleInput("identity.login") as Record<string, unknown>;
    Object.defineProperty(accessor, "body", {
      enumerable: true,
      get: () => {
        getterReads += 1;
        return loginBody;
      },
    });
    expect(() => issueIdentityLifecycleEnvelope(accessor)).toThrow(/data property/u);
    expect(getterReads).toBe(0);

    class LifecycleInput {
      operation = "identity.login";
      request_id = ids.request;
      body = loginBody;
      ingress = lifecycleInput("identity.login").ingress;
    }
    expect(() => issueIdentityLifecycleEnvelope(new LifecycleInput())).toThrow(/plain/u);
    expect(() => issueIdentityLifecycleEnvelope(new String("identity.login"))).toThrow(/plain/u);
    expect(() =>
      issueIdentityLifecycleEnvelope({
        ...lifecycleInput("identity.login"),
        body: { ...loginBody, password: new String(loginBody.password) },
      }),
    ).toThrow(/plain/u);
    expect(() =>
      issueIdentityLifecycleEnvelope({ ...lifecycleInput("identity.login"), extra: true }),
    ).toThrow();
    expect(() => issueIdentityLifecycleEnvelope(null)).toThrow();

    let descriptorReads = 0;
    const unstable = new Proxy(lifecycleInput("identity.login"), {
      ownKeys: (target) => {
        descriptorReads += 1;
        return descriptorReads === 1 ? Reflect.ownKeys(target) : ["operation"];
      },
    });
    expect(() => issueIdentityLifecycleEnvelope(unstable)).toThrow(/stable own data properties/u);
  });

  it("keeps the lifecycle authority factory off the root entry point", () => {
    expect("issueIdentityLifecycleEnvelope" in PublicContracts).toBe(false);
  });
});
