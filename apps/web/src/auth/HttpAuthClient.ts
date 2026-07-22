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
  SwitchableStaff,
} from "./types.js";
import type { AuthClient } from "./AuthClient.js";

/** Matches packages/contracts CSRF_HEADER_NAME (avoid web→contracts dep for host). */
const CSRF_HEADER_NAME = "x-csrf-token";

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

function roleFromStaffId(staffId: string, directory: readonly SwitchableStaff[]): StaffRole {
  const hit = directory.find((s) => s.staff_id === staffId);
  if (hit !== undefined) return hit.role;
  return staffId.endsWith("103") ? "admin" : "staff";
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
  directory: readonly SwitchableStaff[],
  display: AccessSession["display"],
): AccessSession {
  const role = roleFromStaffId(payload.session.staff_id, directory);
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
  let staffDirectory: SwitchableStaff[] = [];
  let lastDisplay: AccessSession["display"] = Object.freeze({
    store_name: "",
    staff_name: "",
    org_code: "",
    store_code: "",
  });
  let accessToken: string | null = null;

  const storeLabel = (orgCode: string, storeCode: string): string => {
    if (orgCode === "hongfa" && storeCode === "main") return "宏发·总店";
    if (orgCode.length > 0 && storeCode.length > 0) return `${orgCode} / ${storeCode}`;
    return "门店";
  };

  const readCsrf = (): string | null => {
    if (typeof document === "undefined") return null;
    // Production: __Host-laundry_csrf; local HTTP: laundry_csrf (Host prefix requires Secure).
    const match = /(?:^|;\s*)(?:__Host-laundry_csrf|laundry_csrf)=([^;]+)/u.exec(document.cookie);
    return match?.[1] ?? null;
  };

  const loadStaff = async (): Promise<void> => {
    try {
      const res = await fetchImpl(`${base}/api/v2/local/staff`, { credentials: "include" });
      if (!res.ok) return;
      const body: unknown = await res.json();
      if (!isRecord(body) || body.ok !== true || !Array.isArray(body.data)) return;
      const next: SwitchableStaff[] = [];
      for (const row of body.data) {
        if (!isRecord(row)) continue;
        if (
          typeof row.staff_id === "string" &&
          typeof row.display_name === "string" &&
          (row.role === "admin" || row.role === "staff")
        ) {
          next.push(
            Object.freeze({
              staff_id: row.staff_id,
              display_name: row.display_name,
              role: row.role,
            }),
          );
        }
      }
      staffDirectory = next;
    } catch {
      // optional
    }
  };

  const login = async (values: LoginFormValues): Promise<AuthResult<AccessSession>> => {
    await loadStaff();
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
      const body: unknown = await res.json();
      if (!isRecord(body) || body.ok !== true) {
        const message =
          isRecord(body) && isRecord(body.error) && typeof body.error.message === "string"
            ? body.error.message
            : "登录失败";
        return asError(message);
      }
      const payload = readAccessPayload(body.data);
      if (payload === null) return asError("登录响应格式错误");
      accessToken = payload.access_token;
      const staffName =
        staffDirectory.find((s) => s.staff_id === payload.session.staff_id)?.display_name ??
        values.username;
      lastDisplay = Object.freeze({
        store_name: storeLabel(values.org_code, values.store_code),
        staff_name: staffName,
        org_code: values.org_code,
        store_code: values.store_code,
      });
      return Object.freeze({
        ok: true as const,
        data: projectSession(payload, staffDirectory, lastDisplay),
      });
    } catch {
      return asError("无法连接本地服务器");
    }
  };

  const createPinChallenge = async (
    request: PinChallengeRequest,
  ): Promise<AuthResult<PinChallengeResponse>> => {
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
      const payload = readAccessPayload(body.data);
      if (payload === null) return asError("PIN 验证响应格式错误");
      accessToken = payload.access_token;
      const staffName =
        staffDirectory.find((s) => s.staff_id === payload.session.staff_id)?.display_name ??
        lastDisplay.staff_name;
      lastDisplay = Object.freeze({ ...lastDisplay, staff_name: staffName });
      return Object.freeze({
        ok: true as const,
        data: projectSession(payload, staffDirectory, lastDisplay),
      });
    } catch {
      return asError("无法连接本地服务器");
    }
  };

  const listSwitchableStaff = (): readonly SwitchableStaff[] =>
    Object.freeze(staffDirectory.map((s) => Object.freeze({ ...s })));

  return Object.freeze({
    login,
    createPinChallenge,
    verifyPin,
    listSwitchableStaff,
  });
}
