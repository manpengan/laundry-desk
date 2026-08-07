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
  StepUpProofResult,
  SwitchableStaff,
} from "./types.js";
import type { AuthPort } from "./AuthClient.js";
import { requestHttpLogout } from "./http-logout.js";

/** Matches packages/contracts CSRF_HEADER_NAME (avoid web→contracts dep for host). */
const CSRF_HEADER_NAME = "x-csrf-token";
const SUPERSEDED_LOGIN_MESSAGE = "登录请求已被新的登录操作取代";
const ACCESS_TOKEN_TTL_SECONDS = 900;
const COMPACT_ACCESS_TOKEN = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){2}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

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

type ParsedAccessSession = Readonly<{
  accessToken: string;
  view: SessionView;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ACCESS_SESSION_KEYS = Object.freeze([
  "access_token",
  "token_type",
  "expires_in",
  "storage",
  "session",
  "role",
  "features",
  "display",
] as const);
const BROWSER_SESSION_KEYS = Object.freeze([
  "session_id",
  "session_version",
  "org_id",
  "store_id",
  "staff_id",
  "device_id",
  "permission_version",
] as const);
const DISPLAY_KEYS = Object.freeze(["store_name", "staff_name", "org_code", "store_code"] as const);

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value > 0;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function readBrowserSession(data: unknown): SessionView["session"] | null {
  if (!isRecord(data) || !hasExactKeys(data, BROWSER_SESSION_KEYS)) return null;
  if (
    !isUuid(data.session_id) ||
    !isPositiveSafeInteger(data.session_version) ||
    !isUuid(data.org_id) ||
    !isUuid(data.store_id) ||
    !isUuid(data.staff_id) ||
    !isUuid(data.device_id) ||
    !isPositiveSafeInteger(data.permission_version)
  ) {
    return null;
  }
  return Object.freeze({
    session_id: data.session_id,
    session_version: data.session_version,
    org_id: data.org_id,
    store_id: data.store_id,
    staff_id: data.staff_id,
    device_id: data.device_id,
    permission_version: data.permission_version,
  });
}

function readFeatures(data: unknown): SessionView["features"] | null {
  if (!isRecord(data)) return null;
  const entries = Object.entries(data);
  if (!entries.every((entry): entry is [string, boolean] => typeof entry[1] === "boolean")) {
    return null;
  }
  return Object.freeze(Object.fromEntries(entries));
}

function readDisplay(data: unknown): SessionView["display"] | null {
  if (!isRecord(data) || !hasExactKeys(data, DISPLAY_KEYS)) return null;
  if (
    typeof data.store_name !== "string" ||
    typeof data.staff_name !== "string" ||
    typeof data.org_code !== "string" ||
    typeof data.store_code !== "string"
  ) {
    return null;
  }
  return Object.freeze({
    store_name: data.store_name,
    staff_name: data.staff_name,
    org_code: data.org_code,
    store_code: data.store_code,
  });
}

/** Strictly consume the complete server-owned access-session projection. */
function readAccessSession(data: unknown): ParsedAccessSession | null {
  if (!isRecord(data) || !hasExactKeys(data, ACCESS_SESSION_KEYS)) return null;
  if (
    typeof data.access_token !== "string" ||
    !COMPACT_ACCESS_TOKEN.test(data.access_token) ||
    data.token_type !== "Bearer" ||
    data.expires_in !== ACCESS_TOKEN_TTL_SECONDS ||
    data.storage !== "memory_only" ||
    (data.role !== "admin" && data.role !== "staff")
  ) {
    return null;
  }
  const session = readBrowserSession(data.session);
  const features = readFeatures(data.features);
  const display = readDisplay(data.display);
  if (session === null || features === null || display === null) return null;
  return Object.freeze({
    accessToken: data.access_token,
    view: Object.freeze({
      session,
      role: data.role,
      features,
      display,
    }),
  });
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

  const loadStaff = async (accessToken: string): Promise<readonly SwitchableStaff[] | null> => {
    try {
      const res = await fetchImpl(`${base}/api/v2/local/staff`, {
        credentials: "include",
        headers: { authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) return null;
      const body: unknown = await res.json();
      if (!isRecord(body) || body.ok !== true || !Array.isArray(body.data)) return null;
      const next: SwitchableStaff[] = [];
      for (const row of body.data) {
        if (
          !isRecord(row) ||
          typeof row.staff_id !== "string" ||
          typeof row.display_name !== "string" ||
          (row.role !== "admin" && row.role !== "staff")
        ) {
          return null;
        }
        next.push(
          Object.freeze({
            staff_id: row.staff_id,
            display_name: row.display_name,
            role: row.role,
          }),
        );
      }
      return Object.freeze(next);
    } catch {
      return null;
    }
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
        const currentDirectory = await loadStaff(parsed.accessToken);
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

  const listSwitchableStaff = (): readonly SwitchableStaff[] =>
    Object.freeze(authState.staffDirectory.map((s) => Object.freeze({ ...s })));

  const logout = (): Promise<void> => {
    latestLoginAttempt += 1;
    clearLocalAuth();
    return enqueueCookieMutation(failClosedCookieMutation);
  };

  return Object.freeze({
    login,
    logout,
    createPinChallenge,
    verifyPin,
    verifyStepUpPin,
    listSwitchableStaff,
  });
}
