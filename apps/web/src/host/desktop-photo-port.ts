import type { CommandErrorDetail, CommandFailure, CommandResult } from "../commands/types.js";
import type { LaundryDesktopBridge } from "./desktop-bridge.js";
import {
  MAX_PHOTO_BYTES,
  parsePhotoUploadData,
  type PhotoContentType,
  type PhotoKind,
  type PhotoPort,
  type PhotoUploadData,
  type PhotoUploadInput,
} from "./photo-port.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PHOTO_KINDS: readonly PhotoKind[] = Object.freeze(["receive", "defect", "ready", "other"]);
const PHOTO_CONTENT_TYPES: readonly PhotoContentType[] = Object.freeze([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

function bridgeError(message: string): CommandResult<never> {
  return Object.freeze({
    ok: false,
    error: Object.freeze({ code: "DESKTOP_BRIDGE", message }),
  });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expected.length &&
    expected.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function readDetail(value: unknown): CommandErrorDetail | null {
  if (!isRecord(value)) return null;
  const allowed = ["kind", "confirm_ref", "message"] as const;
  const keys = Reflect.ownKeys(value);
  if (
    !keys.every(
      (key) =>
        typeof key === "string" &&
        allowed.includes(key as (typeof allowed)[number]) &&
        typeof value[key] === "string",
    )
  ) {
    return null;
  }
  return Object.freeze({
    ...(typeof value.kind === "string" ? { kind: value.kind } : {}),
    ...(typeof value.confirm_ref === "string" ? { confirm_ref: value.confirm_ref } : {}),
    ...(typeof value.message === "string" ? { message: value.message } : {}),
  });
}

function readFailure(value: unknown): CommandFailure | null {
  if (!isRecord(value) || !hasExactKeys(value, ["ok", "error"]) || value.ok !== false) return null;
  if (!isRecord(value.error) || typeof value.error.code !== "string") return null;
  const keys = Reflect.ownKeys(value.error);
  if (
    !keys.every((key) => typeof key === "string" && ["code", "detail", "message"].includes(key)) ||
    (value.error.message !== undefined && typeof value.error.message !== "string")
  ) {
    return null;
  }
  const detail = value.error.detail === undefined ? undefined : readDetail(value.error.detail);
  if (detail === null) return null;
  return Object.freeze({
    code: value.error.code,
    ...(detail === undefined ? {} : { detail }),
    ...(typeof value.error.message === "string" ? { message: value.error.message } : {}),
  });
}

function validInput(input: PhotoUploadInput): boolean {
  return (
    UUID.test(input.order_id) &&
    UUID.test(input.garment_id) &&
    PHOTO_KINDS.includes(input.kind) &&
    PHOTO_CONTENT_TYPES.includes(input.content_type) &&
    input.bytes instanceof Uint8Array &&
    input.bytes.byteLength >= 1 &&
    input.bytes.byteLength <= MAX_PHOTO_BYTES &&
    (input.taken_at === undefined || (Number.isSafeInteger(input.taken_at) && input.taken_at >= 0))
  );
}

function readResult(value: unknown): CommandResult<PhotoUploadData> {
  const failure = readFailure(value);
  if (failure !== null) return Object.freeze({ ok: false, error: failure });
  if (isRecord(value) && hasExactKeys(value, ["ok", "data"]) && value.ok === true) {
    const data = parsePhotoUploadData(value.data);
    if (data !== null) return Object.freeze({ ok: true, data });
  }
  return bridgeError("桌面照片响应格式错误");
}

export function createDesktopPhotoPort(bridge: LaundryDesktopBridge): PhotoPort {
  return Object.freeze({
    async upload(input) {
      if (!validInput(input)) return bridgeError("桌面照片参数格式错误");
      if (bridge.photo === undefined) return bridgeError("桌面照片能力不可用");
      try {
        return readResult(
          await bridge.photo.upload(
            Object.freeze({ ...input, bytes: Uint8Array.from(input.bytes) }),
          ),
        );
      } catch {
        return bridgeError("桌面照片响应格式错误");
      }
    },
  });
}
