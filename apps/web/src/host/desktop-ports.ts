import type { AuthPort } from "../auth/AuthClient.js";
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
import { readMemberTopupConfirmationSummary } from "../commands/member-topup-confirmation.js";
import type {
  CommandErrorDetail,
  CommandPort,
  CommandResult,
  QueryPort,
} from "../commands/types.js";
import type {
  DesktopCommandInput,
  DesktopQueryInput,
  LaundryDesktopBridge,
} from "./desktop-bridge.js";
import { createDesktopPhotoPort } from "./desktop-photo-port.js";
import { createDesktopOfflinePort } from "./offline-port.js";
import { createDesktopResumePort } from "./desktop-resume-port.js";
import { createDesktopPrinterPort } from "./desktop-printer-port.js";
import { readDesktopSessionView } from "./desktop-session-view.js";
import { readStaffCredentialsCompleteResult } from "../auth/http-auth-boundary.js";
import type { AppPorts, HealthPort, HealthResult } from "./types.js";

export type { LaundryDesktopBridge } from "./desktop-bridge.js";

const EMPTY_STAFF_DIRECTORY: readonly SwitchableStaff[] = Object.freeze([]);
const EMPTY_BUSINESS_BODY: Readonly<Record<string, never>> = Object.freeze({});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PIN = /^\d{4,8}$/u;
const OPERATION_NAME = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u;
const MAX_OPERATION_NAME_LENGTH = 128;
const MAX_BUSINESS_VALUE_NODES = 10_000;
const MAX_STAFF_DIRECTORY_SIZE = 500;
const HEALTH_FAILURE_MESSAGE = "桌面本地服务不可用，请确认服务已启动后重试";
const FORBIDDEN_CREDENTIAL_KEYS = new Set([
  "cookie",
  "cookies",
  "authorization",
  "accesstoken",
  "refreshtoken",
  "token",
]);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const actual = Reflect.ownKeys(value);
  return (
    actual.length === expected.length &&
    expected.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isOperationName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_OPERATION_NAME_LENGTH &&
    OPERATION_NAME.test(value)
  );
}

function readCommandOptions(value: unknown): Readonly<{ confirmRef?: string }> | null {
  if (value === undefined) return Object.freeze({});
  if (!isRecord(value)) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.length === 0) return Object.freeze({});
  if (keys.length !== 1 || keys[0] !== "confirmRef") {
    return null;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, "confirmRef");
  if (descriptor === undefined || !("value" in descriptor) || !isUuid(descriptor.value)) {
    return null;
  }
  return Object.freeze({ confirmRef: descriptor.value });
}

function isCredentialBoundaryKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/giu, "").toLowerCase();
  return FORBIDDEN_CREDENTIAL_KEYS.has(normalized) || normalized.endsWith("token");
}

/**
 * Phase boundary: Task 10 owns authoritative contract-name and Zod validation.
 * This adapter rejects non-JSON values and credential-shaped keys. Legitimate business
 * fields such as payment.method remain intact; fixed main-process schemas prevent
 * renderer data from selecting transport controls.
 */
function isSafeBusinessValue(value: unknown): boolean {
  const pending: unknown[] = [value];
  const seen = new WeakSet<object>();
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (
      current === null ||
      typeof current === "string" ||
      typeof current === "boolean" ||
      (typeof current === "number" && Number.isFinite(current))
    ) {
      continue;
    }
    if (typeof current !== "object" || seen.has(current)) return false;
    if (++visited > MAX_BUSINESS_VALUE_NODES) return false;
    seen.add(current);
    if (!Array.isArray(current)) {
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) return false;
    }
    for (const key of Reflect.ownKeys(current)) {
      if (typeof key !== "string" || isCredentialBoundaryKey(key)) return false;
      if (Array.isArray(current) && key === "length") continue;
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor === undefined || !("value" in descriptor)) return false;
      pending.push(descriptor.value);
    }
  }
  return true;
}

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
  const command = readCommandResult<unknown>(value);
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

type ParsedFailure = Readonly<{
  ok: false;
  error: Readonly<{ code: string; message: string }>;
}>;

function readFailure(value: unknown): ParsedFailure | null {
  if (!isRecord(value) || !hasExactKeys(value, ["ok", "error"]) || value.ok !== false) return null;
  const error = value.error;
  if (!isRecord(error) || !hasExactKeys(error, ["code", "message"])) return null;
  if (!isNonEmptyString(error.code) || !isNonEmptyString(error.message)) return null;
  return Object.freeze({
    ok: false,
    error: Object.freeze({ code: error.code, message: error.message }),
  });
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
    return Object.freeze({
      purpose: "quick_switch",
      target_staff_id: value.target_staff_id,
    });
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
  return Object.freeze({
    challenge_id: value.challenge_id,
    pin: value.pin,
  });
}

function readSessionResult(value: unknown, malformedMessage: string): AuthResult<SessionView> {
  const failure = readFailure(value);
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
  const failure = readFailure(value);
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
  const failure = readFailure(value);
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

function readCommandDetail(value: unknown): CommandErrorDetail | null {
  if (!isRecord(value)) return null;
  const allowed = ["kind", "confirm_ref", "message", "summary"] as const;
  const keys = Reflect.ownKeys(value);
  if (
    !keys.every(
      (key) => typeof key === "string" && allowed.includes(key as (typeof allowed)[number]),
    )
  ) {
    return null;
  }
  for (const key of ["kind", "confirm_ref", "message"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "string") return null;
  }
  const summary =
    value.summary === undefined ? undefined : readMemberTopupConfirmationSummary(value.summary);
  if (summary === null) return null;
  return Object.freeze({
    ...(typeof value.kind === "string" ? { kind: value.kind } : {}),
    ...(typeof value.confirm_ref === "string" ? { confirm_ref: value.confirm_ref } : {}),
    ...(typeof value.message === "string" ? { message: value.message } : {}),
    ...(summary === undefined ? {} : { summary }),
  });
}

function readCommandFailure<T>(value: unknown): CommandResult<T> | null {
  if (!isRecord(value) || !hasExactKeys(value, ["ok", "error"]) || value.ok !== false) return null;
  const error = value.error;
  if (!isRecord(error) || !isNonEmptyString(error.code)) return null;
  const allowed = ["code", "detail", "message"] as const;
  const keys = Reflect.ownKeys(error);
  if (
    !keys.every(
      (key) => typeof key === "string" && allowed.includes(key as (typeof allowed)[number]),
    )
  ) {
    return null;
  }
  if (error.message !== undefined && typeof error.message !== "string") return null;
  const detail = error.detail === undefined ? undefined : readCommandDetail(error.detail);
  if (detail === null) return null;
  return Object.freeze({
    ok: false,
    error: Object.freeze({
      code: error.code,
      ...(detail === undefined ? {} : { detail }),
      ...(typeof error.message === "string" ? { message: error.message } : {}),
    }),
  });
}

function readCommandResult<T>(value: unknown): CommandResult<T> {
  const failure = readCommandFailure<T>(value);
  if (failure !== null) return failure;
  if (
    isRecord(value) &&
    hasExactKeys(value, ["ok", "data"]) &&
    value.ok === true &&
    isSafeBusinessValue(value.data)
  ) {
    return Object.freeze({ ok: true as const, data: value.data as T });
  }
  return desktopBridgeError("桌面宿主响应格式错误");
}

function desktopBridgeError<T>(message: string): CommandResult<T> {
  return Object.freeze({
    ok: false,
    error: Object.freeze({
      code: "DESKTOP_BRIDGE",
      message,
    }),
  });
}

function serviceUnavailable(message: string): HealthResult {
  return Object.freeze({
    ok: false,
    error: Object.freeze({ code: "SERVICE_UNAVAILABLE", message }),
  });
}

function readHealthResult(value: unknown): HealthResult {
  const failure = readFailure(value);
  if (failure !== null) {
    return serviceUnavailable(HEALTH_FAILURE_MESSAGE);
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["ok", "data"]) ||
    value.ok !== true ||
    !isRecord(value.data) ||
    !hasExactKeys(value.data, ["status"]) ||
    value.data.status !== "ready"
  ) {
    return serviceUnavailable(HEALTH_FAILURE_MESSAGE);
  }
  return Object.freeze({
    ok: true,
    data: Object.freeze({ status: "ready" }),
  });
}

function createAuthPort(bridge: LaundryDesktopBridge): AuthPort {
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
        const failure = readFailure(value);
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
        const failure = readFailure(value);
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

function createCommandPort(bridge: LaundryDesktopBridge): CommandPort {
  return Object.freeze({
    async execute<T>(
      name: string,
      body?: unknown,
      options?: Readonly<{ confirmRef?: string }>,
    ): Promise<CommandResult<T>> {
      const parsedOptions = readCommandOptions(options);
      if (
        !isOperationName(name) ||
        (body !== undefined && !isSafeBusinessValue(body)) ||
        parsedOptions === null
      ) {
        return desktopBridgeError("桌面命令参数格式错误");
      }
      const input: DesktopCommandInput =
        parsedOptions.confirmRef === undefined
          ? Object.freeze({
              name,
              body: body === undefined ? EMPTY_BUSINESS_BODY : body,
            })
          : Object.freeze({
              name,
              confirm_ref: parsedOptions.confirmRef,
            });
      try {
        return readCommandResult<T>(await bridge.command.execute(input));
      } catch {
        return readCommandResult<T>(null);
      }
    },
  });
}

function createQueryPort(bridge: LaundryDesktopBridge): QueryPort {
  return Object.freeze({
    async execute<T>(name: string, body?: unknown): Promise<CommandResult<T>> {
      if (!isOperationName(name) || (body !== undefined && !isSafeBusinessValue(body))) {
        return desktopBridgeError("桌面查询参数格式错误");
      }
      const input: DesktopQueryInput = Object.freeze({
        name,
        body: body === undefined ? EMPTY_BUSINESS_BODY : body,
      });
      try {
        return readCommandResult<T>(await bridge.query.execute(input));
      } catch {
        return readCommandResult<T>(null);
      }
    },
  });
}

function createHealthPort(bridge: LaundryDesktopBridge): HealthPort {
  return Object.freeze({
    async get(): Promise<HealthResult> {
      try {
        return readHealthResult(await bridge.health.get());
      } catch {
        return serviceUnavailable(HEALTH_FAILURE_MESSAGE);
      }
    },
  });
}

export function createDesktopPorts(bridge: LaundryDesktopBridge): AppPorts {
  const resume = createDesktopResumePort(bridge.offline);
  return Object.freeze({
    auth: createAuthPort(bridge),
    command: createCommandPort(bridge),
    query: createQueryPort(bridge),
    photo: createDesktopPhotoPort(bridge),
    offline: createDesktopOfflinePort(bridge.offline),
    ...(bridge.printer === undefined ? {} : { printer: createDesktopPrinterPort(bridge.printer) }),
    ...(resume === undefined ? {} : { resume }),
    health: createHealthPort(bridge),
  });
}
