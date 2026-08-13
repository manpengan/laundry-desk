/**
 * HTTP AuthClient talking to local @laundry/server (memory or PG).
 * Access tokens stay in memory only — never Web Storage.
 */

import { getDeviceId } from "./device-id.js";
import type {
  AuthResult,
  LoginFormValues,
  PinChallengeRequest,
  PinChallengeResponse,
  PinVerifyRequest,
  SessionView,
  StaffCredentialsCompleteInput,
  StaffCredentialsCompleteResult,
  StepUpProofResult,
  SwitchableStaff,
} from "./types.js";
import type { AuthPort } from "./AuthClient.js";
import { requestHttpLogout } from "./http-logout.js";
import {
  loadHttpStaffDirectory,
  readAccessSession,
  readStaffCredentialsCompleteResult,
} from "./http-auth-boundary.js";

/** Matches packages/contracts CSRF_HEADER_NAME (avoid web→contracts dep for host). */
const CSRF_HEADER_NAME = "x-csrf-token";
const SUPERSEDED_LOGIN_MESSAGE = "登录请求已被新的登录操作取代";

const EMPTY_STAFF_DIRECTORY: readonly SwitchableStaff[] = Object.freeze([]);

type HttpAuthState = Readonly<{
  staffDirectory: readonly SwitchableStaff[];
}>;

const EMPTY_AUTH_STATE: HttpAuthState = Object.freeze({
  staffDirectory: EMPTY_STAFF_DIRECTORY,
});

/**
 * Private transport capability shared by browser adapters.
 * It must never be included in AppPorts or passed into React.
 */
export type HttpAuthCredentialStore = Readonly<{
  getAccessToken: () => string | null;
  replaceAccessToken: (accessToken: string | null) => void;
  readCsrf: () => string | null;
}>;

export type HttpAuthClientOptions = Readonly<{
  /** API origin, e.g. http://127.0.0.1:8787 */
  apiBaseUrl: string;
  /** Optional override for fetch (tests). */
  fetchImpl?: typeof fetch;
  /** Browser host-owned credential closure. A private fallback is used in isolated tests. */
  credentialStore?: HttpAuthCredentialStore;
}>;

function asError(message: string): AuthResult<SessionView> {
  return Object.freeze({
    ok: false as const,
    error: Object.freeze({ code: "AUTH_CLIENT", message }),
  });
}

function asPinError(message: string): AuthResult<PinChallengeResponse> {
  return Object.freeze({
    ok: false as const,
    error: Object.freeze({ code: "AUTH_CLIENT", message }),
  });
}

function asStepUpError(message: string): AuthResult<StepUpProofResult> {
  return Object.freeze({
    ok: false as const,
    error: Object.freeze({ code: "AUTH_CLIENT", message }),
  });
}

function asCredentialsError(message: string): AuthResult<StaffCredentialsCompleteResult> {
  return Object.freeze({
    ok: false as const,
    error: Object.freeze({ code: "AUTH_CLIENT", message }),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultReadCsrf(): string | null {
  if (typeof document === "undefined") return null;
  // Production: __Host-laundry_csrf; local HTTP: laundry_csrf (Host prefix requires Secure).
  const match = /(?:^|;\s*)(?:__Host-laundry_csrf|laundry_csrf)=([^;]+)/u.exec(document.cookie);
  return match?.[1] ?? null;
}

function createPrivateCredentialStore(): HttpAuthCredentialStore {
  let accessToken: string | null = null;
  return Object.freeze({
    getAccessToken: () => accessToken,
    replaceAccessToken: (next: string | null) => {
      accessToken = next;
    },
    readCsrf: defaultReadCsrf,
  });
}

/**
 * Create an AuthClient that calls the local Fastify server.
 * Cookie jar is browser-native (`credentials: "include"`).
 */
export function createHttpAuthClient(options: HttpAuthClientOptions): AuthPort {
  const base = options.apiBaseUrl.replace(/\/$/u, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const credentials = options.credentialStore ?? createPrivateCredentialStore();
  let authState = EMPTY_AUTH_STATE;
  let latestLoginAttempt = 0;
  let cookieMutationTail: Promise<void> = Promise.resolve();

  const clearLocalAuth = (): void => {
    authState = EMPTY_AUTH_STATE;
    credentials.replaceAccessToken(null);
  };

  const failClosedCookieMutation = async (): Promise<void> => {
    clearLocalAuth();
    await requestHttpLogout({ apiBaseUrl: base, fetchImpl, readCsrf: credentials.readCsrf });
  };

  /** Serialize the complete handling of every response that may replace auth cookies. */
  const enqueueCookieMutation = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = cookieMutationTail.then(operation);
    cookieMutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const login = (values: LoginFormValues): Promise<AuthResult<SessionView>> => {
    const attempt = ++latestLoginAttempt;
    clearLocalAuth();
    const superseded = (): AuthResult<SessionView> => asError(SUPERSEDED_LOGIN_MESSAGE);
    const failLatest = (message: string): AuthResult<SessionView> => {
      if (attempt !== latestLoginAttempt) return superseded();
      clearLocalAuth();
      return asError(message);
    };
    const failAfterResponse = async (
      message: string,
      cookiesMayHaveChanged: boolean,
    ): Promise<AuthResult<SessionView>> => {
      if (!cookiesMayHaveChanged) return failLatest(message);
      await failClosedCookieMutation();
      return attempt === latestLoginAttempt ? asError(message) : superseded();
    };

    return enqueueCookieMutation(async () => {
      let cookiesMayHaveChanged = false;
      try {
        const res = await fetchImpl(`${base}/api/v2/auth/login`, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            org_code: values.org_code,
            store_code: values.store_code,
            username: values.username,
            password: values.password,
            device_id: getDeviceId(),
          }),
        });
        cookiesMayHaveChanged = res.ok;
        if (attempt !== latestLoginAttempt) {
          return failAfterResponse(SUPERSEDED_LOGIN_MESSAGE, cookiesMayHaveChanged);
        }
        const body: unknown = await res.json();
        if (attempt !== latestLoginAttempt) {
          return failAfterResponse(SUPERSEDED_LOGIN_MESSAGE, cookiesMayHaveChanged);
        }
        if (!res.ok || !isRecord(body) || body.ok !== true) {
          const message =
            isRecord(body) && isRecord(body.error) && typeof body.error.message === "string"
              ? body.error.message
              : "登录失败";
          return failAfterResponse(message, cookiesMayHaveChanged);
        }
        const parsed = readAccessSession(body.data);
        if (parsed === null) {
          return failAfterResponse("登录响应格式错误", cookiesMayHaveChanged);
        }
        const currentDirectory = await loadHttpStaffDirectory(fetchImpl, base, parsed.accessToken);
        if (attempt !== latestLoginAttempt) {
          return failAfterResponse(SUPERSEDED_LOGIN_MESSAGE, cookiesMayHaveChanged);
        }
        if (currentDirectory === null) {
          return failAfterResponse("无法从本地服务器加载员工目录", cookiesMayHaveChanged);
        }
        if (attempt !== latestLoginAttempt) {
          return failAfterResponse(SUPERSEDED_LOGIN_MESSAGE, cookiesMayHaveChanged);
        }
        authState = Object.freeze({
          staffDirectory: currentDirectory,
        });
        credentials.replaceAccessToken(parsed.accessToken);
        return Object.freeze({
          ok: true as const,
          data: parsed.view,
        });
      } catch {
        return failAfterResponse("无法连接本地服务器", cookiesMayHaveChanged);
      }
    });
  };

  const createPinChallenge = async (
    request: PinChallengeRequest,
  ): Promise<AuthResult<PinChallengeResponse>> => {
    const stateAtStart = authState;
    const accessToken = credentials.getAccessToken();
    if (accessToken === null) return asPinError("未登录");
    const csrf = credentials.readCsrf();
    if (csrf === null) return asPinError("缺少 CSRF cookie");
    try {
      const res = await fetchImpl(`${base}/api/v2/auth/pin/challenges`, {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${accessToken}`,
          [CSRF_HEADER_NAME]: csrf,
        },
        body: JSON.stringify(request),
      });
      const body: unknown = await res.json();
      if (!isRecord(body) || body.ok !== true || !isRecord(body.data)) {
        return asPinError("PIN challenge 失败");
      }
      const d = body.data;
      if (
        typeof d.challenge_id !== "string" ||
        (d.purpose !== "quick_switch" && d.purpose !== "step_up") ||
        typeof d.expires_at !== "number" ||
        typeof d.max_attempts !== "number"
      ) {
        return asPinError("PIN challenge 响应格式错误");
      }
      if (authState !== stateAtStart) return asPinError("认证状态已变更，请重试");
      return Object.freeze({
        ok: true as const,
        data: Object.freeze({
          challenge_id: d.challenge_id,
          purpose: d.purpose,
          expires_at: d.expires_at,
          max_attempts: d.max_attempts,
        }),
      });
    } catch {
      return asPinError("无法连接本地服务器");
    }
  };

  const verifyPin = async (request: PinVerifyRequest): Promise<AuthResult<SessionView>> => {
    const stateAtStart = authState;
    const accessToken = credentials.getAccessToken();
    if (accessToken === null) return asError("未登录");
    return enqueueCookieMutation(async () => {
      if (authState !== stateAtStart) return asError("认证状态已变更，请重试");
      const csrf = credentials.readCsrf();
      if (csrf === null) return asError("缺少 CSRF cookie");
      let cookiesMayHaveChanged = false;
      const failAfterResponse = async (message: string): Promise<AuthResult<SessionView>> => {
        if (cookiesMayHaveChanged) await failClosedCookieMutation();
        return asError(message);
      };
      try {
        const res = await fetchImpl(
          `${base}/api/v2/auth/pin/challenges/${encodeURIComponent(request.challenge_id)}/verify`,
          {
            method: "POST",
            credentials: "include",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${accessToken}`,
              [CSRF_HEADER_NAME]: csrf,
            },
            body: JSON.stringify(request),
          },
        );
        cookiesMayHaveChanged = res.ok;
        const body: unknown = await res.json();
        if (!res.ok || !isRecord(body) || body.ok !== true) {
          return failAfterResponse("PIN 验证失败");
        }
        // step_up responses must not be parsed as session switches.
        if (isRecord(body.data) && typeof body.data.step_up_proof_id === "string") {
          return asError("当前挑战为 step-up，请使用现场复核流程");
        }
        const parsed = readAccessSession(body.data);
        if (parsed === null) return failAfterResponse("PIN 验证响应格式错误");
        if (authState !== stateAtStart) {
          return failAfterResponse("认证状态已变更，请重试");
        }
        authState = Object.freeze({
          staffDirectory: stateAtStart.staffDirectory,
        });
        credentials.replaceAccessToken(parsed.accessToken);
        return Object.freeze({
          ok: true as const,
          data: parsed.view,
        });
      } catch {
        return failAfterResponse("无法连接本地服务器");
      }
    });
  };

  const verifyStepUpPin = async (
    request: PinVerifyRequest,
  ): Promise<AuthResult<StepUpProofResult>> => {
    const accessToken = credentials.getAccessToken();
    if (accessToken === null) return asStepUpError("未登录");
    const stateAtStart = authState;
    return enqueueCookieMutation(async () => {
      if (authState !== stateAtStart) return asStepUpError("认证状态已变更，请重试");
      const csrf = credentials.readCsrf();
      if (csrf === null) return asStepUpError("缺少 CSRF cookie");
      try {
        const res = await fetchImpl(
          `${base}/api/v2/auth/pin/challenges/${encodeURIComponent(request.challenge_id)}/verify`,
          {
            method: "POST",
            credentials: "include",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${accessToken}`,
              [CSRF_HEADER_NAME]: csrf,
            },
            body: JSON.stringify(request),
          },
        );
        const body: unknown = await res.json();
        if (!isRecord(body) || body.ok !== true || !isRecord(body.data)) {
          return asStepUpError("现场复核 PIN 失败");
        }
        const proofId = body.data.step_up_proof_id;
        const expiresAt = body.data.expires_at;
        if (typeof proofId !== "string" || typeof expiresAt !== "number") {
          return asStepUpError("step-up 响应格式错误");
        }
        if (authState !== stateAtStart) return asStepUpError("认证状态已变更，请重试");
        // A5: do not rotate cookies or access token.
        return Object.freeze({
          ok: true as const,
          data: Object.freeze({
            step_up_proof_id: proofId,
            expires_at: expiresAt,
          }),
        });
      } catch {
        return asStepUpError("无法连接本地服务器");
      }
    });
  };

  const refreshSession = (): Promise<AuthResult<SessionView>> => {
    const stateAtStart = authState;
    const loginAttemptAtStart = latestLoginAttempt;
    const isCurrent = (): boolean =>
      authState === stateAtStart && latestLoginAttempt === loginAttemptAtStart;
    return enqueueCookieMutation(async () => {
      if (!isCurrent()) return asError("认证状态已变更，请重试");
      const csrf = credentials.readCsrf();
      if (csrf === null) return asError("缺少 CSRF cookie");
      let cookiesMayHaveChanged = false;
      const failAfterResponse = async (message: string): Promise<AuthResult<SessionView>> => {
        if (cookiesMayHaveChanged) await failClosedCookieMutation();
        return asError(message);
      };
      try {
        // Once sent, a lost response cannot prove that the server left cookies unchanged.
        cookiesMayHaveChanged = true;
        const response = await fetchImpl(`${base}/api/v2/auth/refresh`, {
          method: "POST",
          credentials: "include",
          headers: {
            "content-type": "application/json",
            [CSRF_HEADER_NAME]: csrf,
          },
          body: "{}",
        });
        const body: unknown = await response.json();
        if (!response.ok || !isRecord(body) || body.ok !== true) {
          return failAfterResponse("刷新登录状态失败，请重新登录");
        }
        const parsed = readAccessSession(body.data);
        if (parsed === null) return failAfterResponse("刷新登录响应格式错误");
        const staffDirectory = await loadHttpStaffDirectory(fetchImpl, base, parsed.accessToken);
        if (staffDirectory === null) return failAfterResponse("刷新员工目录失败");
        if (!isCurrent()) return failAfterResponse("认证状态已变更，请重试");
        authState = Object.freeze({ staffDirectory });
        credentials.replaceAccessToken(parsed.accessToken);
        return Object.freeze({ ok: true as const, data: parsed.view });
      } catch {
        return failAfterResponse("无法连接本地服务器");
      }
    });
  };

  const completeStaffCredentials = async (
    request: StaffCredentialsCompleteInput,
  ): Promise<AuthResult<StaffCredentialsCompleteResult>> => {
    const stateAtStart = authState;
    const accessToken = credentials.getAccessToken();
    if (accessToken === null) return asCredentialsError("未登录");
    const csrf = credentials.readCsrf();
    if (csrf === null) return asCredentialsError("缺少 CSRF cookie");
    try {
      const response = await fetchImpl(`${base}/api/v2/auth/staff/credentials/complete`, {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${accessToken}`,
          [CSRF_HEADER_NAME]: csrf,
        },
        body: JSON.stringify(request),
      });
      const body: unknown = await response.json();
      if (!response.ok || !isRecord(body) || body.ok !== true || authState !== stateAtStart) {
        return asCredentialsError("无法完成凭据设置，请重新发起操作");
      }
      const result = readStaffCredentialsCompleteResult(body.data);
      return result === null
        ? asCredentialsError("凭据设置响应格式错误")
        : Object.freeze({ ok: true as const, data: result });
    } catch {
      return asCredentialsError("无法连接本地服务器");
    }
  };

  const listSwitchableStaff = (): readonly SwitchableStaff[] =>
    Object.freeze(authState.staffDirectory.map((s) => Object.freeze({ ...s })));

  const logout = (): Promise<void> => {
    latestLoginAttempt += 1;
    clearLocalAuth();
    return enqueueCookieMutation(failClosedCookieMutation);
  };

  return Object.freeze({
    login,
    refreshSession,
    logout,
    createPinChallenge,
    verifyPin,
    verifyStepUpPin,
    completeStaffCredentials,
    listSwitchableStaff,
  });
}
