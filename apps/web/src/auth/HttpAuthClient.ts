/**
 * HTTP AuthClient talking to local @laundry/server (memory or PG).
 * Access tokens stay in memory only — never Web Storage.
 */

import { getDeviceId } from "./device-id.js";
import { FULL_STORE_FEATURES, STAFF_STORE_FEATURES, type StaffRole } from "./permissions.js";
import type {
  AccessSession,
  AuthResult,
  LoginFormValues,
  PinChallengeRequest,
  PinChallengeResponse,
  PinVerifyRequest,
  StepUpProofResult,
  SwitchableStaff,
} from "./types.js";
import type { AuthClient } from "./AuthClient.js";

/** Matches packages/contracts CSRF_HEADER_NAME (avoid web→contracts dep for host). */
const CSRF_HEADER_NAME = "x-csrf-token";
const SUPERSEDED_LOGIN_MESSAGE = "登录请求已被新的登录操作取代";

const EMPTY_STAFF_DIRECTORY: readonly SwitchableStaff[] = Object.freeze([]);
const EMPTY_DISPLAY: AccessSession["display"] = Object.freeze({
  store_name: "",
  staff_name: "",
  org_code: "",
  store_code: "",
});

type HttpAuthState = Readonly<{
  staffDirectory: readonly SwitchableStaff[];
  display: AccessSession["display"];
  accessToken: string | null;
}>;

const EMPTY_AUTH_STATE: HttpAuthState = Object.freeze({
  staffDirectory: EMPTY_STAFF_DIRECTORY,
  display: EMPTY_DISPLAY,
  accessToken: null,
});

export type HttpAuthClientOptions = Readonly<{
  /** API origin, e.g. http://127.0.0.1:8787 */
  apiBaseUrl: string;
  /** Optional override for fetch (tests). */
  fetchImpl?: typeof fetch;
}>;

function asError(message: string): AuthResult<AccessSession> {
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

function readAccessPayload(data: unknown): {
  access_token: string;
  expires_in: number;
  session: AccessSession["session"];
} | null {
  if (!isRecord(data)) return null;
  if (typeof data.access_token !== "string") return null;
  if (typeof data.expires_in !== "number") return null;
  if (!isRecord(data.session)) return null;
  const s = data.session;
  if (
    typeof s.session_id !== "string" ||
    typeof s.session_version !== "number" ||
    typeof s.org_id !== "string" ||
    typeof s.store_id !== "string" ||
    typeof s.staff_id !== "string" ||
    typeof s.device_id !== "string" ||
    typeof s.permission_version !== "number"
  ) {
    return null;
  }
  return {
    access_token: data.access_token,
    expires_in: data.expires_in,
    session: Object.freeze({
      session_id: s.session_id,
      session_version: s.session_version,
      org_id: s.org_id,
      store_id: s.store_id,
      staff_id: s.staff_id,
      device_id: s.device_id,
      permission_version: s.permission_version,
    }),
  };
}

function projectSession(
  payload: {
    access_token: string;
    expires_in: number;
    session: AccessSession["session"];
  },
  role: StaffRole,
  display: AccessSession["display"],
): AccessSession {
  const features = role === "admin" ? FULL_STORE_FEATURES : STAFF_STORE_FEATURES;
  return Object.freeze({
    access_token: payload.access_token,
    token_type: "Bearer" as const,
    expires_in: payload.expires_in,
    storage: "memory_only" as const,
    session: payload.session,
    role,
    features,
    display,
  });
}

/**
 * Create an AuthClient that calls the local Fastify server.
 * Cookie jar is browser-native (`credentials: "include"`).
 */
export function createHttpAuthClient(options: HttpAuthClientOptions): AuthClient {
  const base = options.apiBaseUrl.replace(/\/$/u, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  let authState = EMPTY_AUTH_STATE;
  let latestLoginAttempt = 0;

  const readCsrf = (): string | null => {
    if (typeof document === "undefined") return null;
    // Production: __Host-laundry_csrf; local HTTP: laundry_csrf (Host prefix requires Secure).
    const match = /(?:^|;\s*)(?:__Host-laundry_csrf|laundry_csrf)=([^;]+)/u.exec(document.cookie);
    return match?.[1] ?? null;
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

  const login = async (values: LoginFormValues): Promise<AuthResult<AccessSession>> => {
    const attempt = ++latestLoginAttempt;
    authState = EMPTY_AUTH_STATE;
    const superseded = (): AuthResult<AccessSession> => asError(SUPERSEDED_LOGIN_MESSAGE);
    const failLatest = (message: string): AuthResult<AccessSession> => {
      if (attempt !== latestLoginAttempt) return superseded();
      authState = EMPTY_AUTH_STATE;
      return asError(message);
    };

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
      if (attempt !== latestLoginAttempt) return superseded();
      const body: unknown = await res.json();
      if (attempt !== latestLoginAttempt) return superseded();
      if (!isRecord(body) || body.ok !== true) {
        const message =
          isRecord(body) && isRecord(body.error) && typeof body.error.message === "string"
            ? body.error.message
            : "登录失败";
        return failLatest(message);
      }
      const payload = readAccessPayload(body.data);
      if (payload === null) return failLatest("登录响应格式错误");
      const currentDirectory = await loadStaff(payload.access_token);
      if (attempt !== latestLoginAttempt) return superseded();
      if (currentDirectory === null) {
        return failLatest("无法从本地服务器加载员工目录");
      }
      const staff = currentDirectory.find((entry) => entry.staff_id === payload.session.staff_id);
      if (staff === undefined) return failLatest("登录响应缺少员工权限");
      const display: AccessSession["display"] = Object.freeze({
        store_name: "",
        staff_name: staff.display_name,
        org_code: values.org_code,
        store_code: values.store_code,
      });
      if (attempt !== latestLoginAttempt) return superseded();
      authState = Object.freeze({
        staffDirectory: currentDirectory,
        display,
        accessToken: payload.access_token,
      });
      return Object.freeze({
        ok: true as const,
        data: projectSession(payload, staff.role, display),
      });
    } catch {
      return failLatest("无法连接本地服务器");
    }
  };

  const createPinChallenge = async (
    request: PinChallengeRequest,
  ): Promise<AuthResult<PinChallengeResponse>> => {
    const accessToken = authState.accessToken;
    if (accessToken === null) return asPinError("未登录");
    const csrf = readCsrf();
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

  const verifyPin = async (request: PinVerifyRequest): Promise<AuthResult<AccessSession>> => {
    const stateAtStart = authState;
    const accessToken = stateAtStart.accessToken;
    if (accessToken === null) return asError("未登录");
    const csrf = readCsrf();
    if (csrf === null) return asError("缺少 CSRF cookie");
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
      if (!isRecord(body) || body.ok !== true) {
        return asError("PIN 验证失败");
      }
      // step_up responses must not be parsed as session switches.
      if (isRecord(body.data) && typeof body.data.step_up_proof_id === "string") {
        return asError("当前挑战为 step-up，请使用现场复核流程");
      }
      const payload = readAccessPayload(body.data);
      if (payload === null) return asError("PIN 验证响应格式错误");
      const staff = stateAtStart.staffDirectory.find(
        (entry) => entry.staff_id === payload.session.staff_id,
      );
      if (staff === undefined) return asError("PIN 验证响应缺少员工权限");
      if (authState !== stateAtStart) return asError("认证状态已变更，请重试");
      const display: AccessSession["display"] = Object.freeze({
        ...stateAtStart.display,
        staff_name: staff.display_name,
      });
      authState = Object.freeze({
        staffDirectory: stateAtStart.staffDirectory,
        display,
        accessToken: payload.access_token,
      });
      return Object.freeze({
        ok: true as const,
        data: projectSession(payload, staff.role, display),
      });
    } catch {
      return asError("无法连接本地服务器");
    }
  };

  const verifyStepUpPin = async (
    request: PinVerifyRequest,
  ): Promise<AuthResult<StepUpProofResult>> => {
    const accessToken = authState.accessToken;
    if (accessToken === null) return asStepUpError("未登录");
    const csrf = readCsrf();
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
  };

  const listSwitchableStaff = (): readonly SwitchableStaff[] =>
    Object.freeze(authState.staffDirectory.map((s) => Object.freeze({ ...s })));

  return Object.freeze({
    login,
    createPinChallenge,
    verifyPin,
    verifyStepUpPin,
    listSwitchableStaff,
  });
}
