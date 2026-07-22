import {
  FULL_STORE_FEATURES,
  STAFF_STORE_FEATURES,
  type StaffRole,
  type StoreFeatureFlags,
} from "./permissions.js";
import { getDeviceId } from "./device-id.js";
import type {
  AccessSession,
  AuthResult,
  LoginFormValues,
  LoginRequest,
  PinChallengeRequest,
  PinChallengeResponse,
  PinVerifyRequest,
  StepUpProofResult,
  SwitchableStaff,
} from "./types.js";

/**
 * Injectable auth port (E1). Real HTTP client lands with C6 + A7 OpenAPI.
 * Implementations must not write access tokens to cookies or Web Storage.
 */
export type AuthClient = Readonly<{
  login: (values: LoginFormValues) => Promise<AuthResult<AccessSession>>;
  createPinChallenge: (request: PinChallengeRequest) => Promise<AuthResult<PinChallengeResponse>>;
  /** quick_switch: issues replacement session. */
  verifyPin: (request: PinVerifyRequest) => Promise<AuthResult<AccessSession>>;
  /** step_up: issues proof without switching actor. */
  verifyStepUpPin: (request: PinVerifyRequest) => Promise<AuthResult<StepUpProofResult>>;
  listSwitchableStaff: () => readonly SwitchableStaff[];
}>;

const ACCESS_TTL = 900;
const PIN_MAX_ATTEMPTS = 5;

const DEMO_STAFF: readonly SwitchableStaff[] = Object.freeze([
  Object.freeze({
    staff_id: "11111111-1111-4111-8111-111111111101",
    display_name: "店员甲",
    role: "staff" as const,
  }),
  Object.freeze({
    staff_id: "11111111-1111-4111-8111-111111111102",
    display_name: "店员乙",
    role: "staff" as const,
  }),
  Object.freeze({
    staff_id: "11111111-1111-4111-8111-111111111103",
    display_name: "店长",
    role: "admin" as const,
  }),
]);

export type MockAuthClientOptions = Readonly<{
  /** Password that succeeds; default "demo". */
  validPassword?: string;
  /** PIN that succeeds for quick-switch; default "1234". */
  validPin?: string;
  /** Force login to fail with this message. */
  failLoginWith?: string;
  /** Force PIN verify to fail. */
  failPinWith?: string;
  staff?: readonly SwitchableStaff[];
  /** Override features for admin projection. */
  adminFeatures?: StoreFeatureFlags;
  /** Override features for staff projection. */
  staffFeatures?: StoreFeatureFlags;
}>;

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  let b64: string;
  if (typeof btoa === "function") {
    b64 = btoa(binary);
  } else {
    // Node unit-test path (no DOM btoa). Keep pure hex fallback — still three segments.
    b64 = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  return b64.replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function compactToken(subject: string): string {
  // Shape-compatible compact JWT (not cryptographically real).
  const h = "eyJhbGciOiJub25lIn0";
  const p = toBase64Url(JSON.stringify({ sub: subject }));
  return `${h}.${p}.mocksig`;
}

function uuidFromSeed(seed: string): string {
  const hex = seed
    .replace(/[^a-f0-9]/giu, "")
    .padEnd(32, "0")
    .slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Login username → role projection.
 * Default login is admin (full features). Username "staff" yields staff subset.
 * UI gate only; C8 enforces.
 */
function roleFromLoginUsername(username: string): StaffRole {
  const key = username.trim().toLowerCase();
  // Explicit staff mock user; everything else (incl. admin/demo/clerk) → admin full pack.
  if (key === "staff" || key === "店员") return "staff";
  return "admin";
}
function featuresForRole(
  role: StaffRole,
  adminFeatures: StoreFeatureFlags,
  staffFeatures: StoreFeatureFlags,
): Readonly<Record<string, boolean>> {
  return role === "admin" ? adminFeatures : staffFeatures;
}

function buildSession(
  values: Pick<LoginRequest, "org_code" | "store_code" | "username" | "device_id">,
  staff: SwitchableStaff,
  role: StaffRole,
  features: Readonly<Record<string, boolean>>,
  sessionVersion = 1,
): AccessSession {
  const sessionId = uuidFromSeed(`sess${values.username}${sessionVersion}`);
  return Object.freeze({
    access_token: compactToken(staff.staff_id),
    token_type: "Bearer" as const,
    expires_in: ACCESS_TTL,
    storage: "memory_only" as const,
    session: Object.freeze({
      session_id: sessionId,
      session_version: sessionVersion,
      org_id: uuidFromSeed(`org${values.org_code}`),
      store_id: uuidFromSeed(`store${values.store_code}`),
      staff_id: staff.staff_id,
      device_id: values.device_id,
      permission_version: 1,
    }),
    role,
    features: Object.freeze({ ...features }),
    display: Object.freeze({
      store_name: `门店 ${values.store_code}`,
      staff_name: staff.display_name,
      org_code: values.org_code,
      store_code: values.store_code,
    }),
  });
}

/**
 * In-memory mock AuthClient for UI + unit tests.
 * Never logs password/PIN; never writes Web Storage.
 * Default login → admin + full features; username "staff" → staff subset.
 * PIN switch applies target staff.role + matching feature pack.
 * UI gate only; C8 enforces.
 */
export function createMockAuthClient(options: MockAuthClientOptions = {}): AuthClient {
  const validPassword = options.validPassword ?? "demo";
  const validPin = options.validPin ?? "1234";
  const staffList = options.staff ?? DEMO_STAFF;
  const adminFeatures = options.adminFeatures ?? FULL_STORE_FEATURES;
  const staffFeatures = options.staffFeatures ?? STAFF_STORE_FEATURES;
  type ChallengeRow =
    | Readonly<{ purpose: "quick_switch"; target_staff_id: string; expires_at: number }>
    | Readonly<{
        purpose: "step_up";
        pending_action_ref: string;
        approver_staff_id: string;
        expires_at: number;
      }>;
  const challenges = new Map<string, ChallengeRow>();
  let lastLogin: LoginFormValues | null = null;
  let sessionVersion = 1;

  return {
    listSwitchableStaff: () => staffList,

    async login(values: LoginFormValues): Promise<AuthResult<AccessSession>> {
      // Intentionally do not log values.password
      if (options.failLoginWith) {
        return {
          ok: false,
          error: { code: "AUTHENTICATION_FAILED", message: options.failLoginWith },
        };
      }
      if (values.password !== validPassword) {
        return {
          ok: false,
          error: {
            code: "AUTHENTICATION_FAILED",
            message: "用户名或密码错误",
          },
        };
      }
      const role = roleFromLoginUsername(values.username);
      const features = featuresForRole(role, adminFeatures, staffFeatures);
      // Prefer a roster entry matching the projected role; else first entry.
      const primary = staffList.find((s) => s.role === role) ?? staffList[0] ?? null;
      if (!primary) {
        return {
          ok: false,
          error: { code: "AUTHENTICATION_FAILED", message: "无可用员工" },
        };
      }
      lastLogin = {
        org_code: values.org_code.trim(),
        store_code: values.store_code.trim(),
        username: values.username.trim(),
        password: "", // never retain password
      };
      sessionVersion = 1;
      const displayName = values.username.trim() || primary.display_name;
      const session = buildSession(
        {
          org_code: lastLogin.org_code,
          store_code: lastLogin.store_code,
          username: lastLogin.username,
          device_id: getDeviceId(),
        },
        {
          staff_id: primary.staff_id,
          display_name: displayName,
          role,
        },
        role,
        features,
        sessionVersion,
      );
      return { ok: true, data: session };
    },

    async createPinChallenge(
      request: PinChallengeRequest,
    ): Promise<AuthResult<PinChallengeResponse>> {
      const expiresAt = Math.floor(Date.now() / 1000) + 120;
      if (request.purpose === "quick_switch") {
        const challengeId = uuidFromSeed(`chal${request.target_staff_id}${Date.now()}`);
        challenges.set(challengeId, {
          purpose: "quick_switch",
          target_staff_id: request.target_staff_id,
          expires_at: expiresAt,
        });
        return {
          ok: true,
          data: Object.freeze({
            challenge_id: challengeId,
            purpose: "quick_switch" as const,
            expires_at: expiresAt,
            max_attempts: PIN_MAX_ATTEMPTS,
          }),
        };
      }
      if (request.approver_staff_id.length === 0 || request.pending_action_ref.length === 0) {
        return {
          ok: false,
          error: { code: "VALIDATION_FAILED", message: "step-up 参数不完整" },
        };
      }
      const challengeId = uuidFromSeed(`step${request.pending_action_ref}${Date.now()}`);
      challenges.set(challengeId, {
        purpose: "step_up",
        pending_action_ref: request.pending_action_ref,
        approver_staff_id: request.approver_staff_id,
        expires_at: expiresAt,
      });
      return {
        ok: true,
        data: Object.freeze({
          challenge_id: challengeId,
          purpose: "step_up" as const,
          expires_at: expiresAt,
          max_attempts: PIN_MAX_ATTEMPTS,
        }),
      };
    },

    async verifyPin(request: PinVerifyRequest): Promise<AuthResult<AccessSession>> {
      if (options.failPinWith) {
        return {
          ok: false,
          error: { code: "AUTHENTICATION_FAILED", message: options.failPinWith },
        };
      }
      const challenge = challenges.get(request.challenge_id);
      if (!challenge || challenge.purpose !== "quick_switch") {
        return {
          ok: false,
          error: { code: "AUTHENTICATION_FAILED", message: "挑战无效或已过期" },
        };
      }
      challenges.delete(request.challenge_id);
      if (request.pin !== validPin) {
        return {
          ok: false,
          error: { code: "AUTHENTICATION_FAILED", message: "PIN 错误" },
        };
      }
      const target = staffList.find((s) => s.staff_id === challenge.target_staff_id);
      if (!target) {
        return {
          ok: false,
          error: { code: "AUTHENTICATION_FAILED", message: "目标员工不存在" },
        };
      }
      const base = lastLogin ?? {
        org_code: "demo-org",
        store_code: "demo-store",
        username: "demo",
        password: "",
      };
      sessionVersion += 1;
      const role = target.role;
      const features = featuresForRole(role, adminFeatures, staffFeatures);
      const session = buildSession(
        {
          org_code: base.org_code,
          store_code: base.store_code,
          username: base.username,
          device_id: getDeviceId(),
        },
        target,
        role,
        features,
        sessionVersion,
      );
      return { ok: true, data: session };
    },

    async verifyStepUpPin(request: PinVerifyRequest): Promise<AuthResult<StepUpProofResult>> {
      if (options.failPinWith) {
        return {
          ok: false,
          error: { code: "AUTHENTICATION_FAILED", message: options.failPinWith },
        };
      }
      const challenge = challenges.get(request.challenge_id);
      if (!challenge || challenge.purpose !== "step_up") {
        return {
          ok: false,
          error: { code: "AUTHENTICATION_FAILED", message: "挑战无效或已过期" },
        };
      }
      challenges.delete(request.challenge_id);
      if (request.pin !== validPin) {
        return {
          ok: false,
          error: { code: "AUTHENTICATION_FAILED", message: "PIN 错误" },
        };
      }
      const now = Math.floor(Date.now() / 1000);
      return {
        ok: true,
        data: Object.freeze({
          step_up_proof_id: uuidFromSeed(`proof${challenge.pending_action_ref}${now}`),
          expires_at: now + 300,
        }),
      };
    },
  };
}
