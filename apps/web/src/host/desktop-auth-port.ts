import type { AuthPort } from "../auth/AuthClient.js";
import { readStaffCredentialsCompleteResult } from "../auth/http-auth-boundary.js";
import type {
  AuthResult,
  LoginFormValues,
  PinChallengeRequest,
  PinChallengeResponse,
  PinVerifyRequest,
  SessionView,
  StaffCredentialsCompleteInput,
  StepUpProofResult,
  SwitchableStaff,
} from "../auth/types.js";
import type { LaundryDesktopBridge } from "./desktop-bridge.js";
import { readDesktopCommandResult, readDesktopFailure } from "./desktop-result-boundary.js";
import { readDesktopSessionView } from "./desktop-session-view.js";
import {
  EMPTY_BUSINESS_BODY,
  hasExactKeys,
  isNonEmptyString,
  isPositiveInteger,
  isRecord,
  isUuid,
} from "./desktop-value-boundary.js";

const EMPTY_STAFF_DIRECTORY: readonly SwitchableStaff[] = Object.freeze([]);
const PIN = /^\d{4,8}$/u;
const MAX_STAFF_DIRECTORY_SIZE = 500;

function readSwitchableStaff(value: unknown): SwitchableStaff | null {
  const keys = ["staff_id", "display_name", "role"] as const;
  if (!isRecord(value) || !hasExactKeys(value, keys)) return null;
  if (
    !isUuid(value.staff_id) ||
    !isNonEmptyString(value.display_name) ||
    (value.role !== "admin" && value.role !== "staff")
  ) {
    return null;
  }
  return Object.freeze({
    staff_id: value.staff_id,
    display_name: value.display_name,
    role: value.role,
  });
}

function readStaffDirectory(value: unknown): readonly SwitchableStaff[] | null {
  if (!Array.isArray(value) || value.length > MAX_STAFF_DIRECTORY_SIZE) return null;
  const staff: SwitchableStaff[] = [];
  const staffIds = new Set<string>();
  for (const candidate of value) {
    const parsed = readSwitchableStaff(candidate);
    if (parsed === null || staffIds.has(parsed.staff_id)) return null;
    staffIds.add(parsed.staff_id);
    staff.push(parsed);
  }
  return Object.freeze(staff);
}

function readStaffDirectoryFromAccessResult(value: unknown): readonly SwitchableStaff[] | null {
  const command = readDesktopCommandResult<unknown>(value);
  if (!command.ok || !isRecord(command.data)) return null;
  const result = "result" in command.data ? command.data.result : command.data;
  if (!isRecord(result) || !Array.isArray(result.staff)) return null;
  const directory: SwitchableStaff[] = [];
  const seen = new Set<string>();
  for (const row of result.staff) {
    if (
      !isRecord(row) ||
      !isUuid(row.staff_id) ||
      !isNonEmptyString(row.display_name) ||
      (row.role !== "admin" && row.role !== "staff") ||
      typeof row.is_active !== "boolean"
    ) {
      return null;
    }
    if (!row.is_active) continue;
    if (seen.has(row.staff_id) || directory.length >= MAX_STAFF_DIRECTORY_SIZE) return null;
    seen.add(row.staff_id);
    directory.push(
      Object.freeze({
        staff_id: row.staff_id,
        display_name: row.display_name,
        role: row.role,
      }),
    );
  }
  return Object.freeze(directory);
}

type ParsedLoginSuccess = Readonly<{
  sessionView: SessionView;
  staffDirectory: readonly SwitchableStaff[];
}>;

function readLoginSuccess(value: unknown): ParsedLoginSuccess | null {
  if (!isRecord(value) || !hasExactKeys(value, ["ok", "data"]) || value.ok !== true) return null;
  const data = value.data;
  if (!isRecord(data) || !hasExactKeys(data, ["session_view", "staff_directory"])) return null;
  const sessionView = readDesktopSessionView(data.session_view);
  const staffDirectory = readStaffDirectory(data.staff_directory);
  if (sessionView === null || staffDirectory === null) return null;
  return Object.freeze({ sessionView, staffDirectory });
}

function authError<T>(message: string): AuthResult<T> {
  return Object.freeze({
    ok: false,
    error: Object.freeze({ code: "AUTH_CLIENT", message }),
  });
}

function readLoginInput(value: unknown): LoginFormValues | null {
  const keys = ["org_code", "store_code", "username", "password"] as const;
  if (!isRecord(value) || !hasExactKeys(value, keys)) return null;
  if (!keys.every((key) => isNonEmptyString(value[key]))) return null;
  return Object.freeze({
    org_code: value.org_code as string,
    store_code: value.store_code as string,
    username: value.username as string,
    password: value.password as string,
  });
}

function readPinChallengeInput(value: unknown): PinChallengeRequest | null {
  if (!isRecord(value)) return null;
  if (
    value.purpose === "quick_switch" &&
    hasExactKeys(value, ["purpose", "target_staff_id"]) &&
    isUuid(value.target_staff_id)
  ) {
    return Object.freeze({ purpose: "quick_switch", target_staff_id: value.target_staff_id });
  }
  if (
    value.purpose === "step_up" &&
    hasExactKeys(value, ["purpose", "pending_action_ref", "approver_staff_id"]) &&
    isNonEmptyString(value.pending_action_ref) &&
    isUuid(value.approver_staff_id)
  ) {
    return Object.freeze({
      purpose: "step_up",
      pending_action_ref: value.pending_action_ref,
      approver_staff_id: value.approver_staff_id,
    });
  }
  return null;
}

function readPinVerifyInput(value: unknown): PinVerifyRequest | null {
  if (!isRecord(value) || !hasExactKeys(value, ["challenge_id", "pin"])) return null;
  if (!isUuid(value.challenge_id) || typeof value.pin !== "string" || !PIN.test(value.pin)) {
    return null;
  }
  return Object.freeze({ challenge_id: value.challenge_id, pin: value.pin });
}

function readSessionResult(value: unknown, malformedMessage: string): AuthResult<SessionView> {
  const failure = readDesktopFailure(value);
  if (failure !== null) return failure;
  if (!isRecord(value) || !hasExactKeys(value, ["ok", "data"]) || value.ok !== true) {
    return authError(malformedMessage);
  }
  const session = readDesktopSessionView(value.data);
  return session === null
    ? authError(malformedMessage)
    : Object.freeze({ ok: true as const, data: session });
}

function readPinChallenge(value: unknown): AuthResult<PinChallengeResponse> {
  const failure = readDesktopFailure(value);
  if (failure !== null) return failure;
  if (!isRecord(value) || !hasExactKeys(value, ["ok", "data"]) || value.ok !== true) {
    return authError("桌面 PIN challenge 响应格式错误");
  }
  const data = value.data;
  const keys = ["challenge_id", "purpose", "expires_at", "max_attempts"] as const;
  if (
    !isRecord(data) ||
    !hasExactKeys(data, keys) ||
    !isNonEmptyString(data.challenge_id) ||
    (data.purpose !== "quick_switch" && data.purpose !== "step_up") ||
    !isPositiveInteger(data.expires_at) ||
    !isPositiveInteger(data.max_attempts)
  ) {
    return authError("桌面 PIN challenge 响应格式错误");
  }
  return Object.freeze({
    ok: true as const,
    data: Object.freeze({
      challenge_id: data.challenge_id,
      purpose: data.purpose,
      expires_at: data.expires_at,
      max_attempts: data.max_attempts,
    }),
  });
}

function readStepUpResult(value: unknown): AuthResult<StepUpProofResult> {
  const failure = readDesktopFailure(value);
  if (failure !== null) return failure;
  if (!isRecord(value) || !hasExactKeys(value, ["ok", "data"]) || value.ok !== true) {
    return authError("桌面 step-up 响应格式错误");
  }
  const data = value.data;
  if (readDesktopSessionView(data) !== null) {
    return authError("当前挑战为 quick-switch，请使用切换账号流程");
  }
  if (
    !isRecord(data) ||
    !hasExactKeys(data, ["step_up_proof_id", "expires_at"]) ||
    !isNonEmptyString(data.step_up_proof_id) ||
    !isPositiveInteger(data.expires_at)
  ) {
    return authError("桌面 step-up 响应格式错误");
  }
  return Object.freeze({
    ok: true as const,
    data: Object.freeze({
      step_up_proof_id: data.step_up_proof_id,
      expires_at: data.expires_at,
    }),
  });
}

function isStepUpSuccess(value: unknown): boolean {
  if (!isRecord(value) || value.ok !== true || !isRecord(value.data)) return false;
  return Object.prototype.hasOwnProperty.call(value.data, "step_up_proof_id");
}

export function createDesktopAuthPort(bridge: LaundryDesktopBridge): AuthPort {
  let staffDirectory = EMPTY_STAFF_DIRECTORY;
  return Object.freeze({
    async refreshSession(): Promise<AuthResult<SessionView>> {
      try {
        const sessionResult = readSessionResult(
          await bridge.auth.refresh(),
          "桌面登录刷新响应格式错误",
        );
        if (!sessionResult.ok) {
          staffDirectory = EMPTY_STAFF_DIRECTORY;
          return sessionResult;
        }
        const directory = readStaffDirectoryFromAccessResult(
          await bridge.query.execute({ name: "staff.access.list", body: EMPTY_BUSINESS_BODY }),
        );
        if (directory === null) {
          staffDirectory = EMPTY_STAFF_DIRECTORY;
          return authError("桌面员工目录刷新失败");
        }
        staffDirectory = directory;
        return sessionResult;
      } catch {
        staffDirectory = EMPTY_STAFF_DIRECTORY;
        return authError("桌面宿主调用失败");
      }
    },

    async completeStaffCredentials(request: StaffCredentialsCompleteInput) {
      if (bridge.auth.credentialComplete === undefined) {
        return authError("桌面凭据设置能力不可用");
      }
      try {
        const value = await bridge.auth.credentialComplete(request);
        const failure = readDesktopFailure(value);
        if (failure !== null) return failure;
        if (!isRecord(value) || !hasExactKeys(value, ["ok", "data"]) || value.ok !== true) {
          return authError("桌面凭据设置响应格式错误");
        }
        const parsed = readStaffCredentialsCompleteResult(value.data);
        return parsed === null
          ? authError("桌面凭据设置响应格式错误")
          : Object.freeze({ ok: true as const, data: parsed });
      } catch {
        return authError("桌面宿主调用失败");
      }
    },

    async logout(): Promise<void> {
      staffDirectory = EMPTY_STAFF_DIRECTORY;
      try {
        await bridge.auth.logout();
      } catch {
        // The renderer session is cleared by the caller even when the host is unavailable.
      }
    },

    async login(values: LoginFormValues): Promise<AuthResult<SessionView>> {
      const input = readLoginInput(values);
      if (input === null) {
        staffDirectory = EMPTY_STAFF_DIRECTORY;
        return authError("桌面登录参数格式错误");
      }
      try {
        const value = await bridge.auth.login(input);
        const failure = readDesktopFailure(value);
        if (failure !== null) {
          staffDirectory = EMPTY_STAFF_DIRECTORY;
          return failure;
        }
        const success = readLoginSuccess(value);
        if (success === null) {
          staffDirectory = EMPTY_STAFF_DIRECTORY;
          return authError("桌面登录响应格式错误");
        }
        staffDirectory = success.staffDirectory;
        return Object.freeze({ ok: true as const, data: success.sessionView });
      } catch {
        staffDirectory = EMPTY_STAFF_DIRECTORY;
        return authError("桌面宿主调用失败");
      }
    },

    async createPinChallenge(
      request: PinChallengeRequest,
    ): Promise<AuthResult<PinChallengeResponse>> {
      const input = readPinChallengeInput(request);
      if (input === null) return authError("桌面 PIN challenge 参数格式错误");
      try {
        return readPinChallenge(await bridge.auth.pinChallenge(input));
      } catch {
        return authError("桌面宿主调用失败");
      }
    },

    async verifyPin(request: PinVerifyRequest): Promise<AuthResult<SessionView>> {
      const input = readPinVerifyInput(request);
      if (input === null) return authError("桌面 PIN 验证参数格式错误");
      try {
        const value = await bridge.auth.pinVerify(input);
        if (isStepUpSuccess(value)) {
          return authError("当前挑战为 step-up，请使用现场复核流程");
        }
        return readSessionResult(value, "桌面 PIN 验证响应格式错误");
      } catch {
        return authError("桌面宿主调用失败");
      }
    },

    async verifyStepUpPin(request: PinVerifyRequest): Promise<AuthResult<StepUpProofResult>> {
      const input = readPinVerifyInput(request);
      if (input === null) return authError("桌面 step-up 参数格式错误");
      try {
        return readStepUpResult(await bridge.auth.pinVerify(input));
      } catch {
        return authError("桌面宿主调用失败");
      }
    },

    listSwitchableStaff: () => staffDirectory,
  });
}
