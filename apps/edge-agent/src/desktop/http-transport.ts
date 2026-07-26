import {
  AccessSessionResponseSchema,
  CSRF_COOKIE_NAME,
  CsrfProofSchema,
  DESKTOP_MAX_JSON_BYTES,
  DesktopCommandExecuteInputSchema,
  DesktopCommandExecuteResultSchema,
  DesktopHealthGetInputSchema,
  DesktopHealthGetResultSchema,
  DesktopLoginInputSchema,
  DesktopLoginResultSchema,
  DesktopLogoutInputSchema,
  DesktopLogoutResultSchema,
  DesktopPinChallengeInputSchema,
  DesktopPinChallengeResultSchema,
  DesktopPinVerifyInputSchema,
  DesktopPinVerifyResultSchema,
  DesktopQueryExecuteInputSchema,
  DesktopQueryExecuteResultSchema,
  DesktopRefreshInputSchema,
  DesktopRefreshResultSchema,
  DesktopSessionViewSchema,
  DesktopStaffDirectorySchema,
  LoginRequestSchema,
  createCommandError,
  type AccessSessionResponse,
  type CommandError,
  type DesktopCommandExecuteResult,
  type DesktopHealthGetResult,
  type DesktopLoginInput,
  type DesktopLoginResult,
  type DesktopLogoutResult,
  type DesktopPinChallengeResult,
  type DesktopPinVerifyResult,
  type DesktopQueryExecuteResult,
  type DesktopRefreshResult,
  type DesktopSessionView,
} from "@laundry/contracts";

import { createLoginIntentGate } from "./auth-intent.js";

export const DESKTOP_API_BASE_URL = "http://127.0.0.1:8787" as const;
export const DESKTOP_REQUEST_ORIGIN = DESKTOP_API_BASE_URL;

const LOCAL_CSRF_COOKIE_NAME = "laundry_csrf";
const CSRF_COOKIE_CANDIDATES = Object.freeze([LOCAL_CSRF_COOKIE_NAME, CSRF_COOKIE_NAME]);
const RESPONSE_ENCODER = new TextEncoder();
const NO_SUCCESS_DATA = Symbol("NO_SUCCESS_DATA");
const ACCESS_REFRESH_SKEW_MS = 30_000;

export type DesktopHttpRequest = Readonly<{
  method: "GET" | "POST";
  url: string;
  headers: Readonly<Record<string, string>>;
  credentials: "include";
  redirect: "error";
  origin: typeof DESKTOP_REQUEST_ORIGIN;
  body?: string;
}>;
export type DesktopHttpResponse = Readonly<{
  statusCode: number;
  bodyText: string;
}>;
export type DesktopCookie = Readonly<{
  name: string;
  value: string;
}>;
export type DesktopCookieStore = Readonly<{
  get: (url: string) => Promise<readonly DesktopCookie[]>;
  clear: (url: string) => Promise<void>;
}>;
export type DesktopHttpTransportDependencies = Readonly<{
  request: (request: DesktopHttpRequest) => Promise<DesktopHttpResponse>;
  cookies: DesktopCookieStore;
  deviceId: string;
  nowMs?: () => number;
  loginInputSchema?: AsyncSchema<DesktopLoginInput>;
}>;
export type DesktopHttpTransport = Readonly<{
  auth: Readonly<{
    login: (input: unknown) => Promise<DesktopLoginResult>;
    refresh: () => Promise<DesktopRefreshResult>;
    pinChallenge: (input: unknown) => Promise<DesktopPinChallengeResult>;
    pinVerify: (input: unknown) => Promise<DesktopPinVerifyResult>;
    logout: () => Promise<DesktopLogoutResult>;
  }>;
  command: Readonly<{
    execute: (input: unknown) => Promise<DesktopCommandExecuteResult>;
  }>;
  query: Readonly<{
    execute: (input: unknown) => Promise<DesktopQueryExecuteResult>;
  }>;
  health: Readonly<{
    get: () => Promise<DesktopHealthGetResult>;
  }>;
}>;

type DesktopFailure = Readonly<{
  ok: false;
  error: CommandError;
}>;

type ResultEnvelope = Readonly<{ ok: boolean }>;

type AsyncSchema<T> = Readonly<{
  safeParseAsync: (
    input: unknown,
  ) => Promise<Readonly<{ success: true; data: T }> | Readonly<{ success: false }>>;
}>;

type ParsedInput<T> = Readonly<{ valid: true; data: T }> | Readonly<{ valid: false }>;

type JsonHttpResponse = Readonly<{
  statusCode: number;
  payload: unknown;
}>;

type AuthState = Readonly<{
  accessToken: string;
  csrfToken: string;
  sessionView: DesktopSessionView;
  expiresAtMs: number;
}>;

type AccessOutcome<T extends ResultEnvelope> =
  | Readonly<{ kind: "access"; access: AccessSessionResponse }>
  | Readonly<{
      kind: "result";
      result: T | DesktopFailure;
      credentialsMayHaveMutated: boolean;
    }>;

const VALIDATION_FAILURE: DesktopFailure = Object.freeze({
  ok: false,
  error: createCommandError("VALIDATION_FAILED"),
});
const AUTHENTICATION_FAILURE: DesktopFailure = Object.freeze({
  ok: false,
  error: createCommandError("AUTHENTICATION_FAILED"),
});
const CSRF_FAILURE: DesktopFailure = Object.freeze({
  ok: false,
  error: createCommandError("CSRF_REJECTED"),
});
const RESOURCE_FAILURE: DesktopFailure = Object.freeze({
  ok: false,
  error: createCommandError(
    "RESOURCE_UNAVAILABLE",
    Object.freeze({ kind: "reason", reason: "retry_later" }),
  ),
});

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readSuccessData(value: unknown): unknown | typeof NO_SUCCESS_DATA {
  if (!isRecord(value) || value.ok !== true) return NO_SUCCESS_DATA;
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== 2 ||
    !Object.prototype.hasOwnProperty.call(value, "ok") ||
    !Object.prototype.hasOwnProperty.call(value, "data")
  ) {
    return NO_SUCCESS_DATA;
  }
  return value.data;
}

function isSuccessStatus(statusCode: number): boolean {
  return statusCode >= 200 && statusCode < 300;
}

async function parseInput<T>(schema: AsyncSchema<T>, input: unknown): Promise<ParsedInput<T>> {
  const parsed = await schema.safeParseAsync(input);
  return parsed.success
    ? Object.freeze({ valid: true as const, data: parsed.data })
    : Object.freeze({ valid: false as const });
}

async function parseOutput<T extends ResultEnvelope>(
  schema: AsyncSchema<T>,
  candidate: unknown,
): Promise<T | DesktopFailure> {
  const parsed = await schema.safeParseAsync(candidate);
  if (parsed.success) return parsed.data;
  const fallback = await schema.safeParseAsync(RESOURCE_FAILURE);
  return fallback.success ? fallback.data : RESOURCE_FAILURE;
}

async function parseHttpOutput<T extends ResultEnvelope>(
  schema: AsyncSchema<T>,
  response: JsonHttpResponse | null,
): Promise<T | DesktopFailure> {
  if (response === null) return parseOutput(schema, RESOURCE_FAILURE);
  const parsed = await parseOutput(schema, response.payload);
  if (parsed.ok && !isSuccessStatus(response.statusCode)) {
    return parseOutput(schema, RESOURCE_FAILURE);
  }
  return parsed;
}

function projectSessionView(access: AccessSessionResponse): Readonly<Record<string, unknown>> {
  return Object.freeze({
    session: Object.freeze({ ...access.session }),
    role: access.role,
    features: Object.freeze({ ...access.features }),
    display: Object.freeze({ ...access.display }),
  });
}

function projectStaffDirectory(data: unknown): readonly Readonly<Record<string, unknown>>[] | null {
  if (!Array.isArray(data) || !data.every(isRecord)) return null;
  return Object.freeze(
    data.map((entry) =>
      Object.freeze({
        staff_id: entry.staff_id,
        display_name: entry.display_name,
        role: entry.role,
      }),
    ),
  );
}

function commandBody(
  input: Readonly<{ body: Readonly<Record<string, unknown>> }> | Readonly<{ confirm_ref: string }>,
): Readonly<Record<string, unknown>> {
  return "confirm_ref" in input
    ? Object.freeze({ confirm_ref: input.confirm_ref })
    : Object.freeze({ ...input.body });
}

function isAuthenticationFailure(result: ResultEnvelope): boolean {
  const candidate: unknown = result;
  const error = isRecord(candidate) ? candidate.error : null;
  return !result.ok && isRecord(error) && error.code === "AUTHENTICATION_FAILED";
}

function isSameSession(left: AuthState, right: AuthState): boolean {
  const a = left.sessionView.session;
  const b = right.sessionView.session;
  return (
    a.session_id === b.session_id &&
    a.org_id === b.org_id &&
    a.store_id === b.store_id &&
    a.staff_id === b.staff_id &&
    a.device_id === b.device_id
  );
}

// This narrow main-process port cannot accept renderer-controlled transport options.
export function createDesktopHttpTransport(
  dependencies: DesktopHttpTransportDependencies,
): DesktopHttpTransport {
  const deviceId = dependencies.deviceId;
  const nowMs = dependencies.nowMs ?? Date.now;
  const loginIntents = createLoginIntentGate();
  let authState: AuthState | null = null;
  let refreshInFlight: Promise<DesktopRefreshResult> | null = null;
  let latestAuthIntent = 0;
  let authMutationTail: Promise<void> = Promise.resolve();

  const createRequest = (
    method: "GET" | "POST",
    path: string,
    options: Readonly<{
      body?: unknown;
      accessToken?: string;
      csrfToken?: string;
    }> = {},
  ): DesktopHttpRequest => {
    const target = new URL(path, `${DESKTOP_API_BASE_URL}/`);
    if (target.origin !== DESKTOP_API_BASE_URL || !path.startsWith("/")) {
      throw new TypeError("Desktop HTTP route escaped the fixed loopback origin");
    }
    const headers = Object.freeze({
      Origin: DESKTOP_REQUEST_ORIGIN,
      "Sec-Fetch-Site": "same-origin",
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(options.accessToken === undefined
        ? {}
        : { Authorization: `Bearer ${options.accessToken}` }),
      ...(options.csrfToken === undefined ? {} : { "X-CSRF-Token": options.csrfToken }),
    });
    if (Object.keys(headers).some((name) => /^x-forwarded-/iu.test(name))) {
      throw new TypeError("Forwarded headers are forbidden on the desktop transport");
    }
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    return Object.freeze({
      method,
      url: target.href,
      headers,
      credentials: "include" as const,
      redirect: "error" as const,
      origin: DESKTOP_REQUEST_ORIGIN,
      ...(body === undefined ? {} : { body }),
    });
  };

  const requestJson = async (
    method: "GET" | "POST",
    path: string,
    options?: Readonly<{
      body?: unknown;
      accessToken?: string;
      csrfToken?: string;
    }>,
  ): Promise<JsonHttpResponse | null> => {
    try {
      const response = await dependencies.request(createRequest(method, path, options));
      if (
        !Number.isInteger(response.statusCode) ||
        response.statusCode < 100 ||
        response.statusCode > 599 ||
        RESPONSE_ENCODER.encode(response.bodyText).byteLength > DESKTOP_MAX_JSON_BYTES
      ) {
        return null;
      }
      return Object.freeze({
        statusCode: response.statusCode,
        payload: JSON.parse(response.bodyText) as unknown,
      });
    } catch {
      return null;
    }
  };

  const readCsrfCookie = async (): Promise<string | null> => {
    let cookies: readonly DesktopCookie[];
    try {
      cookies = await dependencies.cookies.get(DESKTOP_API_BASE_URL);
    } catch {
      return null;
    }
    let validCandidates: readonly string[] = Object.freeze([]);
    for (const name of CSRF_COOKIE_CANDIDATES) {
      const candidates = cookies.filter((cookie) => cookie.name === name);
      for (const candidate of candidates) {
        const parsed = await CsrfProofSchema.safeParseAsync(candidate.value);
        if (parsed.success) {
          validCandidates = Object.freeze([...validCandidates, parsed.data]);
        }
      }
    }
    return validCandidates.length === 1 ? validCandidates[0]! : null;
  };

  const clearCookies = async (): Promise<boolean> => {
    try {
      await dependencies.cookies.clear(DESKTOP_API_BASE_URL);
      return true;
    } catch {
      return false;
    }
  };

  const nextAuthIntent = <T>(
    operation: (intent: number) => Promise<T>,
    invalidateImmediately = false,
  ): Promise<T> => {
    const intent = invalidateImmediately ? latestAuthIntent + 1 : latestAuthIntent;
    if (invalidateImmediately) {
      latestAuthIntent = intent;
      authState = null;
    }
    const run = authMutationTail.then(
      () => operation(intent),
      () => operation(intent),
    );
    authMutationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const isCurrentIntent = (intent: number): boolean => intent === latestAuthIntent;

  const parseAccessOutcome = async <T extends ResultEnvelope>(
    schema: AsyncSchema<T>,
    response: JsonHttpResponse | null,
    allowNonAccessSuccess = false,
  ): Promise<AccessOutcome<T>> => {
    if (response === null) {
      return Object.freeze({
        kind: "result",
        result: await parseOutput(schema, RESOURCE_FAILURE),
        credentialsMayHaveMutated: false,
      });
    }
    const claimedSuccess = isRecord(response.payload) && response.payload.ok === true;
    const data = readSuccessData(response.payload);
    if (data === NO_SUCCESS_DATA) {
      return Object.freeze({
        kind: "result",
        result: await parseHttpOutput(schema, response),
        credentialsMayHaveMutated: claimedSuccess,
      });
    }
    if (!isSuccessStatus(response.statusCode)) {
      return Object.freeze({
        kind: "result",
        result: await parseOutput(schema, RESOURCE_FAILURE),
        credentialsMayHaveMutated: true,
      });
    }
    const parsed = await AccessSessionResponseSchema.safeParseAsync(data);
    if (parsed.success) {
      return Object.freeze({ kind: "access" as const, access: parsed.data });
    }
    const directResult = await parseHttpOutput(schema, response);
    if (allowNonAccessSuccess && directResult.ok) {
      return Object.freeze({
        kind: "result" as const,
        result: directResult,
        credentialsMayHaveMutated: false,
      });
    }
    return Object.freeze({
      kind: "result" as const,
      result: directResult.ok ? await parseOutput(schema, RESOURCE_FAILURE) : directResult,
      credentialsMayHaveMutated: true,
    });
  };

  const parseSessionView = async (
    access: AccessSessionResponse,
  ): Promise<DesktopSessionView | null> => {
    const parsed = await DesktopSessionViewSchema.safeParseAsync(projectSessionView(access));
    return parsed.success ? parsed.data : null;
  };

  const createAuthState = (
    access: AccessSessionResponse,
    csrfToken: string,
    sessionView: DesktopSessionView,
  ): AuthState | null => {
    try {
      const currentMs = nowMs();
      const expiresAtMs = currentMs + access.expires_in * 1_000;
      return Number.isSafeInteger(currentMs) && Number.isSafeInteger(expiresAtMs)
        ? Object.freeze({
            accessToken: access.access_token,
            csrfToken,
            sessionView,
            expiresAtMs,
          })
        : null;
    } catch {
      return null;
    }
  };

  const needsRefresh = (state: AuthState): boolean => {
    try {
      const currentMs = nowMs();
      return (
        !Number.isSafeInteger(currentMs) || currentMs >= state.expiresAtMs - ACCESS_REFRESH_SKEW_MS
      );
    } catch {
      return true;
    }
  };

  const login = async (input: unknown): Promise<DesktopLoginResult> => {
    const loginInvocation = loginIntents.beginLogin();
    const parsedInput = await parseInput(
      dependencies.loginInputSchema ?? DesktopLoginInputSchema,
      input,
    );
    if (!parsedInput.valid) return parseOutput(DesktopLoginResultSchema, VALIDATION_FAILURE);
    const loginRequest = await LoginRequestSchema.safeParseAsync({
      ...parsedInput.data,
      device_id: deviceId,
    });
    if (!loginRequest.success) {
      return parseOutput(DesktopLoginResultSchema, VALIDATION_FAILURE);
    }
    if (!loginIntents.registerValidLogin(loginInvocation)) {
      return parseOutput(DesktopLoginResultSchema, RESOURCE_FAILURE);
    }
    return nextAuthIntent(async (intent) => {
      const response = await requestJson("POST", "/api/v2/auth/login", {
        body: loginRequest.data,
      });
      const outcome = await parseAccessOutcome(DesktopLoginResultSchema, response);
      if (outcome.kind === "result") {
        if (isCurrentIntent(intent)) await clearCookies();
        return outcome.result;
      }
      if (!isCurrentIntent(intent)) {
        return parseOutput(DesktopLoginResultSchema, RESOURCE_FAILURE);
      }
      const csrfToken = await readCsrfCookie();
      if (csrfToken === null) {
        if (isCurrentIntent(intent)) await clearCookies();
        return parseOutput(DesktopLoginResultSchema, CSRF_FAILURE);
      }
      const staffResponse = await requestJson("GET", "/api/v2/local/staff", {
        accessToken: outcome.access.access_token,
      });
      const staffData =
        staffResponse === null ? NO_SUCCESS_DATA : readSuccessData(staffResponse.payload);
      const staffProjection =
        staffData === NO_SUCCESS_DATA ? null : projectStaffDirectory(staffData);
      const staff = await DesktopStaffDirectorySchema.safeParseAsync(staffProjection);
      const sessionView = await parseSessionView(outcome.access);
      if (
        staffResponse === null ||
        !isSuccessStatus(staffResponse.statusCode) ||
        !staff.success ||
        sessionView === null
      ) {
        if (isCurrentIntent(intent)) await clearCookies();
        return parseOutput(DesktopLoginResultSchema, RESOURCE_FAILURE);
      }
      const result = await parseOutput(DesktopLoginResultSchema, {
        ok: true,
        data: {
          session_view: sessionView,
          staff_directory: staff.data,
        },
      });
      const nextState = result.ok ? createAuthState(outcome.access, csrfToken, sessionView) : null;
      if (!result.ok || nextState === null || !isCurrentIntent(intent)) {
        if ((!result.ok || nextState === null) && isCurrentIntent(intent)) {
          authState = null;
          await clearCookies();
        }
        return isCurrentIntent(intent) && !result.ok
          ? result
          : parseOutput(DesktopLoginResultSchema, RESOURCE_FAILURE);
      }
      authState = nextState;
      return result;
    }, true);
  };

  const performRefresh = (): Promise<DesktopRefreshResult> =>
    nextAuthIntent(async (intent) => {
      const parsedInput = await parseInput(DesktopRefreshInputSchema, {});
      if (!parsedInput.valid) return parseOutput(DesktopRefreshResultSchema, VALIDATION_FAILURE);
      const csrfToken = await readCsrfCookie();
      if (csrfToken === null) return parseOutput(DesktopRefreshResultSchema, CSRF_FAILURE);
      const response = await requestJson("POST", "/api/v2/auth/refresh", {
        body: parsedInput.data,
        csrfToken,
      });
      const outcome = await parseAccessOutcome(DesktopRefreshResultSchema, response);
      if (outcome.kind === "result") {
        if (
          (outcome.credentialsMayHaveMutated ||
            (outcome.result.ok === false &&
              outcome.result.error.code === "AUTHENTICATION_FAILED")) &&
          isCurrentIntent(intent)
        ) {
          authState = null;
          await clearCookies();
        }
        return outcome.result;
      }
      if (!isCurrentIntent(intent)) {
        return parseOutput(DesktopRefreshResultSchema, RESOURCE_FAILURE);
      }
      const rotatedCsrf = await readCsrfCookie();
      const sessionView = await parseSessionView(outcome.access);
      if (!isCurrentIntent(intent)) {
        return parseOutput(DesktopRefreshResultSchema, RESOURCE_FAILURE);
      }
      if (rotatedCsrf === null || sessionView === null) {
        authState = null;
        await clearCookies();
        return parseOutput(DesktopRefreshResultSchema, RESOURCE_FAILURE);
      }
      const result = await parseOutput(DesktopRefreshResultSchema, {
        ok: true,
        data: sessionView,
      });
      if (!isCurrentIntent(intent)) {
        return parseOutput(DesktopRefreshResultSchema, RESOURCE_FAILURE);
      }
      if (!result.ok) {
        authState = null;
        await clearCookies();
        return result;
      }
      const nextState = createAuthState(outcome.access, rotatedCsrf, sessionView);
      if (nextState === null) {
        authState = null;
        await clearCookies();
        return parseOutput(DesktopRefreshResultSchema, RESOURCE_FAILURE);
      }
      authState = nextState;
      return result;
    });

  const refresh = (): Promise<DesktopRefreshResult> => {
    if (refreshInFlight !== null) return refreshInFlight;
    const run = performRefresh();
    refreshInFlight = run;
    const clearRefresh = () => {
      if (refreshInFlight === run) refreshInFlight = null;
    };
    void run.then(clearRefresh, clearRefresh);
    return run;
  };

  const pinChallenge = async (input: unknown): Promise<DesktopPinChallengeResult> => {
    const parsedInput = await parseInput(DesktopPinChallengeInputSchema, input);
    if (!parsedInput.valid) return parseOutput(DesktopPinChallengeResultSchema, VALIDATION_FAILURE);
    const state = authState;
    if (state === null) return parseOutput(DesktopPinChallengeResultSchema, AUTHENTICATION_FAILURE);
    const response = await requestJson("POST", "/api/v2/auth/pin/challenges", {
      body: parsedInput.data,
      accessToken: state.accessToken,
      csrfToken: state.csrfToken,
    });
    const result = await parseHttpOutput(DesktopPinChallengeResultSchema, response);
    return authState === state
      ? result
      : parseOutput(DesktopPinChallengeResultSchema, RESOURCE_FAILURE);
  };

  const pinVerify = async (input: unknown): Promise<DesktopPinVerifyResult> => {
    const parsedInput = await parseInput(DesktopPinVerifyInputSchema, input);
    if (!parsedInput.valid) return parseOutput(DesktopPinVerifyResultSchema, VALIDATION_FAILURE);
    return nextAuthIntent(async (intent) => {
      const state = authState;
      if (state === null) return parseOutput(DesktopPinVerifyResultSchema, AUTHENTICATION_FAILURE);
      const challengeId = encodeURIComponent(parsedInput.data.challenge_id);
      const response = await requestJson(
        "POST",
        `/api/v2/auth/pin/challenges/${challengeId}/verify`,
        {
          body: parsedInput.data,
          accessToken: state.accessToken,
          csrfToken: state.csrfToken,
        },
      );
      const outcome = await parseAccessOutcome(DesktopPinVerifyResultSchema, response, true);
      if (outcome.kind === "result") {
        if (outcome.credentialsMayHaveMutated && isCurrentIntent(intent)) {
          authState = null;
          await clearCookies();
        }
        return outcome.result.ok && !isCurrentIntent(intent)
          ? parseOutput(DesktopPinVerifyResultSchema, RESOURCE_FAILURE)
          : outcome.result;
      }
      if (!isCurrentIntent(intent)) {
        return parseOutput(DesktopPinVerifyResultSchema, RESOURCE_FAILURE);
      }
      const rotatedCsrf = await readCsrfCookie();
      const sessionView = await parseSessionView(outcome.access);
      if (!isCurrentIntent(intent)) {
        return parseOutput(DesktopPinVerifyResultSchema, RESOURCE_FAILURE);
      }
      if (rotatedCsrf === null || sessionView === null) {
        authState = null;
        await clearCookies();
        return parseOutput(DesktopPinVerifyResultSchema, RESOURCE_FAILURE);
      }
      const result = await parseOutput(DesktopPinVerifyResultSchema, {
        ok: true,
        data: sessionView,
      });
      if (!isCurrentIntent(intent)) {
        return parseOutput(DesktopPinVerifyResultSchema, RESOURCE_FAILURE);
      }
      if (!result.ok) {
        authState = null;
        await clearCookies();
        return result;
      }
      const nextState = createAuthState(outcome.access, rotatedCsrf, sessionView);
      if (nextState === null) {
        authState = null;
        await clearCookies();
        return parseOutput(DesktopPinVerifyResultSchema, RESOURCE_FAILURE);
      }
      authState = nextState;
      return result;
    });
  };

  const logout = (): Promise<DesktopLogoutResult> => {
    loginIntents.cancelPendingLogins();
    return nextAuthIntent(async () => {
      const parsedInput = await parseInput(DesktopLogoutInputSchema, {});
      let result: DesktopLogoutResult | DesktopFailure = VALIDATION_FAILURE;
      if (parsedInput.valid) {
        const csrfToken = await readCsrfCookie();
        result =
          csrfToken === null
            ? await parseOutput(DesktopLogoutResultSchema, CSRF_FAILURE)
            : await parseHttpOutput(
                DesktopLogoutResultSchema,
                await requestJson("POST", "/api/v2/auth/logout", {
                  body: parsedInput.data,
                  csrfToken,
                }),
              );
      }
      authState = null;
      const cleared = await clearCookies();
      return cleared ? result : parseOutput(DesktopLogoutResultSchema, RESOURCE_FAILURE);
    }, true);
  };

  const refreshForState = async (
    expected: AuthState,
  ): Promise<Readonly<{ state: AuthState }> | Readonly<{ failure: DesktopRefreshResult }>> => {
    const current = authState;
    if (current === null || !isSameSession(expected, current)) {
      return Object.freeze({
        failure: await parseOutput(DesktopRefreshResultSchema, RESOURCE_FAILURE),
      });
    }
    if (current !== expected) return Object.freeze({ state: current });
    const result = await refresh();
    if (!result.ok) return Object.freeze({ failure: result });
    const refreshed = authState;
    return refreshed !== null && isSameSession(expected, refreshed)
      ? Object.freeze({ state: refreshed })
      : Object.freeze({
          failure: await parseOutput(DesktopRefreshResultSchema, RESOURCE_FAILURE),
        });
  };

  const executeProtected = async <T extends ResultEnvelope>(
    schema: AsyncSchema<T>,
    path: string,
    body: Readonly<Record<string, unknown>>,
  ): Promise<T | DesktopFailure> => {
    let state = authState;
    if (state === null) return parseOutput(schema, AUTHENTICATION_FAILURE);
    if (needsRefresh(state)) {
      const refreshed = await refreshForState(state);
      if ("failure" in refreshed) return parseOutput(schema, refreshed.failure);
      state = refreshed.state;
    }
    const send = (credentials: AuthState) =>
      requestJson("POST", path, {
        body,
        accessToken: credentials.accessToken,
        csrfToken: credentials.csrfToken,
      });
    let result = await parseHttpOutput(schema, await send(state));
    const current = authState;
    if (current === null || !isSameSession(state, current)) {
      return parseOutput(schema, RESOURCE_FAILURE);
    }
    if (!isAuthenticationFailure(result)) return result;
    const refreshed = await refreshForState(state);
    if ("failure" in refreshed) return parseOutput(schema, refreshed.failure);
    state = refreshed.state;
    result = await parseHttpOutput(schema, await send(state));
    const finalState = authState;
    return finalState !== null && isSameSession(state, finalState)
      ? result
      : parseOutput(schema, RESOURCE_FAILURE);
  };

  const executeCommand = async (input: unknown): Promise<DesktopCommandExecuteResult> => {
    const parsedInput = await parseInput(DesktopCommandExecuteInputSchema, input);
    if (!parsedInput.valid)
      return parseOutput(DesktopCommandExecuteResultSchema, VALIDATION_FAILURE);
    const name = encodeURIComponent(parsedInput.data.name);
    return executeProtected(
      DesktopCommandExecuteResultSchema,
      `/v1/commands/${name}`,
      commandBody(parsedInput.data),
    );
  };

  const executeQuery = async (input: unknown): Promise<DesktopQueryExecuteResult> => {
    const parsedInput = await parseInput(DesktopQueryExecuteInputSchema, input);
    if (!parsedInput.valid) return parseOutput(DesktopQueryExecuteResultSchema, VALIDATION_FAILURE);
    const name = encodeURIComponent(parsedInput.data.name);
    return executeProtected(
      DesktopQueryExecuteResultSchema,
      `/v1/queries/${name}`,
      Object.freeze({ ...parsedInput.data.body }),
    );
  };

  const getHealth = async (): Promise<DesktopHealthGetResult> => {
    const parsedInput = await parseInput(DesktopHealthGetInputSchema, {});
    if (!parsedInput.valid) return parseOutput(DesktopHealthGetResultSchema, VALIDATION_FAILURE);
    return parseHttpOutput(DesktopHealthGetResultSchema, await requestJson("GET", "/health"));
  };

  return Object.freeze({
    auth: Object.freeze({ login, refresh, pinChallenge, pinVerify, logout }),
    command: Object.freeze({ execute: executeCommand }),
    query: Object.freeze({ execute: executeQuery }),
    health: Object.freeze({ get: getHealth }),
  });
}
