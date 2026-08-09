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
  DesktopPhotoDeleteInputSchema,
  DesktopPhotoDeleteResultSchema,
  DesktopPhotoReadInputSchema,
  DesktopPhotoReadResultSchema,
  DesktopPhotoUploadInputSchema,
  DesktopPhotoUploadResultSchema,
  DesktopQueryExecuteInputSchema,
  DesktopQueryExecuteResultSchema,
  DesktopRefreshInputSchema,
  DesktopRefreshResultSchema,
  DesktopSessionViewSchema,
  DesktopStaffDirectorySchema,
  EdgeReplayResponseSchema,
  LoginRequestSchema,
  type AccessSessionResponse,
  type DesktopCommandExecuteResult,
  type DesktopHealthGetResult,
  type DesktopLoginResult,
  type DesktopLogoutResult,
  type DesktopPinChallengeResult,
  type DesktopPinVerifyResult,
  type DesktopPhotoDeleteResult,
  type DesktopPhotoReadResult,
  type DesktopPhotoUploadResult,
  type DesktopQueryExecuteResult,
  type DesktopRefreshResult,
  type DesktopSessionView,
  type EdgeAuthorityResponse,
  type EdgeQueueEnvelope,
} from "@laundry/contracts";

import { createLoginIntentGate } from "./auth-intent.js";
import { createEdgeAuthorityRequester } from "./edge-authority-transport.js";
import { createSignedReplayRequest, projectReplayResponse } from "./edge-http.js";
import {
  AUTHENTICATION_FAILURE,
  CSRF_FAILURE,
  NO_SUCCESS_DATA,
  RESOURCE_FAILURE,
  VALIDATION_FAILURE,
  commandBody,
  isAuthenticationFailure,
  isRecord,
  isSameSession,
  isSuccessStatus,
  parseHttpOutput,
  parseInput,
  parseOutput,
  projectSessionView,
  projectStaffDirectory,
  readSuccessData,
  type AsyncSchema,
  type AuthState,
  type DesktopFailure,
  type JsonHttpResponse,
  type ResultEnvelope,
} from "./http-transport-support.js";
import type { DesktopCookie, DesktopHttpTransportDependencies } from "./http-transport-ports.js";
import {
  createEdgePrintHttpTransport,
  type EdgePrintHttpTransport,
} from "./print-http-transport.js";
import { createDesktopRequest, DESKTOP_API_BASE_URL } from "./request-builder.js";
import {
  createStaffCredentialCompleteOperation,
  type DesktopStaffCredentialCompleteResult,
} from "./staff-setup-operation.js";
export {
  DESKTOP_API_BASE_URL,
  DESKTOP_REQUEST_ORIGIN,
  type DesktopHttpRequest,
} from "./request-builder.js";
export type {
  DesktopCookie,
  DesktopCookieStore,
  DesktopHttpResponse,
  DesktopHttpTransportDependencies,
  DesktopPhotoHttpResponse,
} from "./http-transport-ports.js";

const LOCAL_CSRF_COOKIE_NAME = "laundry_csrf";
const CSRF_COOKIE_CANDIDATES = Object.freeze([LOCAL_CSRF_COOKIE_NAME, CSRF_COOKIE_NAME]);
const RESPONSE_ENCODER = new TextEncoder();
const ACCESS_REFRESH_SKEW_MS = 30_000;

export type DesktopHttpTransport = Readonly<{
  auth: Readonly<{
    login: (input: unknown) => Promise<DesktopLoginResult>;
    refresh: () => Promise<DesktopRefreshResult>;
    pinChallenge: (input: unknown) => Promise<DesktopPinChallengeResult>;
    pinVerify: (input: unknown) => Promise<DesktopPinVerifyResult>;
    credentialComplete: (input: unknown) => Promise<DesktopStaffCredentialCompleteResult>;
    logout: () => Promise<DesktopLogoutResult>;
  }>;
  command: Readonly<{
    execute: (input: unknown) => Promise<DesktopCommandExecuteResult>;
  }>;
  query: Readonly<{
    execute: (input: unknown) => Promise<DesktopQueryExecuteResult>;
  }>;
  photo: Readonly<{
    upload: (input: unknown) => Promise<DesktopPhotoUploadResult>;
    read: (input: unknown) => Promise<DesktopPhotoReadResult>;
    delete: (input: unknown) => Promise<DesktopPhotoDeleteResult>;
  }>;
  health: Readonly<{
    get: () => Promise<DesktopHealthGetResult>;
  }>;
  /** Main-process-only authority/replay surface. Never project this through preload. */
  edge: Readonly<{
    authority: (requestNonce: string, requestPrimary: boolean) => Promise<EdgeAuthorityResponse>;
    replay: (envelope: EdgeQueueEnvelope) => Promise<DesktopCommandExecuteResult>;
    print: EdgePrintHttpTransport;
    currentSession: () => DesktopSessionView | null;
  }>;
}>;

type AccessOutcome<T extends ResultEnvelope> =
  | Readonly<{ kind: "access"; access: AccessSessionResponse }>
  | Readonly<{
      kind: "result";
      result: T | DesktopFailure;
      credentialsMayHaveMutated: boolean;
    }>;

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

  const requestJson = async (
    method: "GET" | "POST",
    path: string,
    options?: Readonly<{
      body?: Readonly<Record<string, unknown>> | Uint8Array;
      contentType?: string;
      accessToken?: string;
      csrfToken?: string;
    }>,
  ): Promise<JsonHttpResponse | null> => {
    try {
      const response = await dependencies.request(createDesktopRequest(method, path, options));
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
    body: Readonly<Record<string, unknown>> | Uint8Array,
    contentType?: string,
    retryAuthentication = true,
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
        ...(contentType === undefined ? {} : { contentType }),
        accessToken: credentials.accessToken,
        csrfToken: credentials.csrfToken,
      });
    let result = await parseHttpOutput(schema, await send(state));
    const current = authState;
    if (current === null || !isSameSession(state, current)) {
      return parseOutput(schema, RESOURCE_FAILURE);
    }
    if (!isAuthenticationFailure(result) || !retryAuthentication) return result;
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

  const uploadPhoto = async (input: unknown): Promise<DesktopPhotoUploadResult> => {
    const parsedInput = await parseInput(DesktopPhotoUploadInputSchema, input);
    if (!parsedInput.valid) return parseOutput(DesktopPhotoUploadResultSchema, VALIDATION_FAILURE);
    const query = new URLSearchParams({
      upload_id: parsedInput.data.upload_id,
      order_id: parsedInput.data.order_id,
      garment_id: parsedInput.data.garment_id,
      kind: parsedInput.data.kind,
      ...(parsedInput.data.taken_at === undefined
        ? {}
        : { taken_at: String(parsedInput.data.taken_at) }),
    });
    return executeProtected(
      DesktopPhotoUploadResultSchema,
      `/api/v2/photos?${query.toString()}`,
      parsedInput.data.bytes,
      parsedInput.data.content_type,
    );
  };

  const deletePhoto = async (input: unknown): Promise<DesktopPhotoDeleteResult> => {
    const parsedInput = await parseInput(DesktopPhotoDeleteInputSchema, input);
    if (!parsedInput.valid) return parseOutput(DesktopPhotoDeleteResultSchema, VALIDATION_FAILURE);
    const photoId = encodeURIComponent(parsedInput.data.photo_id);
    return executeProtected(
      DesktopPhotoDeleteResultSchema,
      `/api/v2/photos/${photoId}/delete`,
      Object.freeze({ delete_id: parsedInput.data.delete_id }),
    );
  };

  const readPhoto = async (input: unknown): Promise<DesktopPhotoReadResult> => {
    const parsedInput = await parseInput(DesktopPhotoReadInputSchema, input);
    if (!parsedInput.valid) return parseOutput(DesktopPhotoReadResultSchema, VALIDATION_FAILURE);
    let state = authState;
    if (state === null) return parseOutput(DesktopPhotoReadResultSchema, AUTHENTICATION_FAILURE);
    if (needsRefresh(state)) {
      const refreshed = await refreshForState(state);
      if ("failure" in refreshed) {
        return parseOutput(DesktopPhotoReadResultSchema, refreshed.failure);
      }
      state = refreshed.state;
    }
    const requestPhoto = dependencies.photoRequest;
    if (requestPhoto === undefined) {
      return parseOutput(DesktopPhotoReadResultSchema, RESOURCE_FAILURE);
    }
    const suffix = parsedInput.data.variant === "thumbnail" ? "/thumbnail" : "";
    const path = `/api/v2/photos/${encodeURIComponent(parsedInput.data.photo_id)}${suffix}`;
    const send = async (credentials: AuthState): Promise<DesktopPhotoReadResult> => {
      try {
        const response = await requestPhoto(
          createDesktopRequest("GET", path, { accessToken: credentials.accessToken }),
        );
        if (
          response.statusCode < 200 ||
          response.statusCode >= 300 ||
          (response.contentType !== "image/jpeg" &&
            response.contentType !== "image/png" &&
            response.contentType !== "image/webp")
        ) {
          return parseOutput(
            DesktopPhotoReadResultSchema,
            response.statusCode === 401 ? AUTHENTICATION_FAILURE : RESOURCE_FAILURE,
          );
        }
        return parseOutput(DesktopPhotoReadResultSchema, {
          ok: true,
          data: {
            content_type: response.contentType,
            bytes: Uint8Array.from(response.bodyBytes),
          },
        });
      } catch {
        return parseOutput(DesktopPhotoReadResultSchema, RESOURCE_FAILURE);
      }
    };
    let result = await send(state);
    const current = authState;
    if (current === null || !isSameSession(state, current)) {
      return parseOutput(DesktopPhotoReadResultSchema, RESOURCE_FAILURE);
    }
    if (!isAuthenticationFailure(result)) return result;
    const refreshed = await refreshForState(state);
    if ("failure" in refreshed) return parseOutput(DesktopPhotoReadResultSchema, refreshed.failure);
    state = refreshed.state;
    result = await send(state);
    const finalState = authState;
    return finalState !== null && isSameSession(state, finalState)
      ? result
      : parseOutput(DesktopPhotoReadResultSchema, RESOURCE_FAILURE);
  };

  const getHealth = async (): Promise<DesktopHealthGetResult> => {
    const parsedInput = await parseInput(DesktopHealthGetInputSchema, {});
    if (!parsedInput.valid) return parseOutput(DesktopHealthGetResultSchema, VALIDATION_FAILURE);
    return parseHttpOutput(DesktopHealthGetResultSchema, await requestJson("GET", "/health"));
  };

  const requestEdgeAuthority = createEdgeAuthorityRequester({
    deviceId,
    signer: dependencies.deviceSigner,
    executeProtected,
    refreshAuthentication: async () => {
      const state = authState;
      return state !== null && !("failure" in (await refreshForState(state)));
    },
  });

  const replayEdgeEnvelope = async (
    envelope: EdgeQueueEnvelope,
  ): Promise<DesktopCommandExecuteResult> => {
    const signer = dependencies.deviceSigner;
    if (signer === undefined) {
      return parseOutput(DesktopCommandExecuteResultSchema, RESOURCE_FAILURE);
    }
    const request = createSignedReplayRequest(deviceId, envelope, signer);
    const response = await executeProtected(
      EdgeReplayResponseSchema,
      "/api/v2/edge/replay",
      request,
    );
    return projectReplayResponse(response);
  };

  const print = createEdgePrintHttpTransport({
    executeProtected,
    currentSession: () => authState?.sessionView ?? null,
    wallNowMs: nowMs,
    ...(dependencies.monotonicNowMs === undefined
      ? {}
      : { monotonicNowMs: dependencies.monotonicNowMs }),
  });
  const currentSession = (): DesktopSessionView | null => authState?.sessionView ?? null;
  const credentialComplete = createStaffCredentialCompleteOperation(executeProtected);

  return Object.freeze({
    auth: Object.freeze({ login, refresh, pinChallenge, pinVerify, credentialComplete, logout }),
    command: Object.freeze({ execute: executeCommand }),
    query: Object.freeze({ execute: executeQuery }),
    photo: Object.freeze({ upload: uploadPhoto, read: readPhoto, delete: deletePhoto }),
    health: Object.freeze({ get: getHealth }),
    edge: Object.freeze({
      authority: requestEdgeAuthority,
      replay: replayEdgeEnvelope,
      print,
      currentSession,
    }),
  });
}
