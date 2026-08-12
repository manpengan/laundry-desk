import { readConfirmationSummary } from "../commands/confirmation-summary.js";
import type { CommandErrorDetail, CommandResult } from "../commands/types.js";
import type { HealthResult } from "./types.js";
import {
  hasExactKeys,
  isNonEmptyString,
  isRecord,
  isSafeBusinessValue,
} from "./desktop-value-boundary.js";

export const HEALTH_FAILURE_MESSAGE = "桌面本地服务不可用，请确认服务已启动后重试";

export type DesktopFailure = Readonly<{
  ok: false;
  error: Readonly<{ code: string; message: string }>;
}>;

export function readDesktopFailure(value: unknown): DesktopFailure | null {
  if (!isRecord(value) || !hasExactKeys(value, ["ok", "error"]) || value.ok !== false) return null;
  const error = value.error;
  if (!isRecord(error) || !hasExactKeys(error, ["code", "message"])) return null;
  if (!isNonEmptyString(error.code) || !isNonEmptyString(error.message)) return null;
  return Object.freeze({
    ok: false,
    error: Object.freeze({ code: error.code, message: error.message }),
  });
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
  const summary = value.summary === undefined ? undefined : readConfirmationSummary(value.summary);
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

export function desktopBridgeError<T>(message: string): CommandResult<T> {
  return Object.freeze({
    ok: false,
    error: Object.freeze({ code: "DESKTOP_BRIDGE", message }),
  });
}

export function readDesktopCommandResult<T>(value: unknown): CommandResult<T> {
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

export function desktopServiceUnavailable(message: string): HealthResult {
  return Object.freeze({
    ok: false,
    error: Object.freeze({ code: "SERVICE_UNAVAILABLE", message }),
  });
}

export function readDesktopHealthResult(value: unknown): HealthResult {
  if (readDesktopFailure(value) !== null) return desktopServiceUnavailable(HEALTH_FAILURE_MESSAGE);
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["ok", "data"]) ||
    value.ok !== true ||
    !isRecord(value.data) ||
    !hasExactKeys(value.data, ["status"]) ||
    value.data.status !== "ready"
  ) {
    return desktopServiceUnavailable(HEALTH_FAILURE_MESSAGE);
  }
  return Object.freeze({ ok: true, data: Object.freeze({ status: "ready" }) });
}
