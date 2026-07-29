import type { CommandFailure, CommandResult } from "../commands/types.js";

export const MAX_PHOTO_BYTES = 8 * 1_024 * 1_024;

export type PhotoKind = "receive" | "defect" | "ready" | "other";
export type PhotoContentType = "image/jpeg" | "image/png" | "image/webp";

export type PhotoUploadInput = Readonly<{
  upload_id: string;
  order_id: string;
  garment_id: string;
  kind: PhotoKind;
  content_type: PhotoContentType;
  bytes: Uint8Array;
  taken_at?: number;
}>;

export type PhotoRow = Readonly<{
  photo_id: string;
  garment_id: string;
  order_id: string;
  kind: PhotoKind;
  content_type: PhotoContentType;
  byte_size: number;
  taken_at: number;
  created_by_staff_id: string;
}>;

export type PhotoUploadData = Readonly<{
  execution: "executed";
  result: PhotoRow;
}>;

export type PhotoReadVariant = "thumbnail" | "original";

export type PhotoBinaryData = Readonly<{
  content_type: PhotoContentType;
  bytes: Uint8Array;
}>;

export type PhotoPort = Readonly<{
  upload: (input: PhotoUploadInput) => Promise<CommandResult<PhotoUploadData>>;
  read: (photoId: string, variant: PhotoReadVariant) => Promise<CommandResult<PhotoBinaryData>>;
  remove: (photoId: string, deleteId: string) => Promise<CommandResult<PhotoUploadData>>;
}>;

export type HttpPhotoPortOptions = Readonly<{
  apiBaseUrl: string;
  fetchImpl: typeof fetch;
  getAccessToken: () => string | null;
  readCsrf: () => string | null;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PHOTO_KINDS: readonly PhotoKind[] = Object.freeze(["receive", "defect", "ready", "other"]);
const PHOTO_CONTENT_TYPES: readonly PhotoContentType[] = Object.freeze([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

function failure(code: string, message: string): CommandResult<never> {
  return Object.freeze({
    ok: false as const,
    error: Object.freeze({ code, message }),
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

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPhotoKind(value: unknown): value is PhotoKind {
  return typeof value === "string" && PHOTO_KINDS.includes(value as PhotoKind);
}

function isPhotoContentType(value: unknown): value is PhotoContentType {
  return typeof value === "string" && PHOTO_CONTENT_TYPES.includes(value as PhotoContentType);
}

function parsePhotoRow(value: unknown): PhotoRow | null {
  const keys = [
    "photo_id",
    "garment_id",
    "order_id",
    "kind",
    "content_type",
    "byte_size",
    "taken_at",
    "created_by_staff_id",
  ] as const;
  if (!isRecord(value) || !hasExactKeys(value, keys)) return null;
  if (
    typeof value.photo_id !== "string" ||
    !UUID.test(value.photo_id) ||
    typeof value.garment_id !== "string" ||
    !UUID.test(value.garment_id) ||
    typeof value.order_id !== "string" ||
    !UUID.test(value.order_id) ||
    !isPhotoKind(value.kind) ||
    !isPhotoContentType(value.content_type) ||
    !isPositiveSafeInteger(value.byte_size) ||
    !isNonNegativeSafeInteger(value.taken_at) ||
    typeof value.created_by_staff_id !== "string" ||
    !UUID.test(value.created_by_staff_id)
  ) {
    return null;
  }
  return Object.freeze({
    photo_id: value.photo_id,
    garment_id: value.garment_id,
    order_id: value.order_id,
    kind: value.kind,
    content_type: value.content_type,
    byte_size: value.byte_size,
    taken_at: value.taken_at,
    created_by_staff_id: value.created_by_staff_id,
  });
}

export function parsePhotoUploadData(value: unknown): PhotoUploadData | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["execution", "result"]) ||
    value.execution !== "executed"
  ) {
    return null;
  }
  const result = parsePhotoRow(value.result);
  return result === null ? null : Object.freeze({ execution: "executed", result });
}

function parseFailure(value: unknown): CommandFailure {
  if (!isRecord(value) || !isRecord(value.error)) {
    return Object.freeze({ code: "PHOTO_UPLOAD_FAILED", message: "照片上传失败" });
  }
  return Object.freeze({
    code: typeof value.error.code === "string" ? value.error.code : "PHOTO_UPLOAD_FAILED",
    ...(typeof value.error.message === "string" ? { message: value.error.message } : {}),
  });
}

function validInput(input: PhotoUploadInput): boolean {
  return (
    UUID.test(input.upload_id) &&
    UUID.test(input.order_id) &&
    UUID.test(input.garment_id) &&
    ["receive", "defect", "ready", "other"].includes(input.kind) &&
    ["image/jpeg", "image/png", "image/webp"].includes(input.content_type) &&
    input.bytes.byteLength >= 1 &&
    input.bytes.byteLength <= MAX_PHOTO_BYTES &&
    (input.taken_at === undefined || (Number.isSafeInteger(input.taken_at) && input.taken_at >= 0))
  );
}

function readPhotoPath(photoId: string, variant: PhotoReadVariant): string | null {
  if (!UUID.test(photoId) || (variant !== "thumbnail" && variant !== "original")) return null;
  return variant === "thumbnail"
    ? `/api/v2/photos/${photoId}/thumbnail`
    : `/api/v2/photos/${photoId}`;
}

async function parseReadFailure(response: Response): Promise<CommandFailure> {
  try {
    return parseFailure((await response.json()) as unknown);
  } catch {
    return Object.freeze({ code: "PHOTO_READ_FAILED", message: "照片读取失败" });
  }
}

async function readBoundedPhotoBytes(response: Response): Promise<Uint8Array | null> {
  if (response.body === null) return null;
  const reader = response.body.getReader();
  let chunks: readonly Uint8Array[] = Object.freeze([]);
  let totalBytes = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    if (next.value.byteLength === 0) continue;
    totalBytes += next.value.byteLength;
    if (totalBytes > MAX_PHOTO_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks = Object.freeze([...chunks, Uint8Array.from(next.value)]);
  }
  if (totalBytes < 1) return null;
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function createHttpPhotoPort(options: HttpPhotoPortOptions): PhotoPort {
  const base = options.apiBaseUrl.replace(/\/$/u, "");
  const fetchImpl = options.fetchImpl;
  return Object.freeze({
    async upload(input: PhotoUploadInput): Promise<CommandResult<PhotoUploadData>> {
      if (!validInput(input)) return failure("VALIDATION_FAILED", "照片参数无效");
      const token = options.getAccessToken();
      if (token === null || token.length === 0) return failure("AUTHENTICATION_FAILED", "未登录");
      const csrf = options.readCsrf();
      if (csrf === null || csrf.length === 0) return failure("CSRF_REJECTED", "缺少 CSRF cookie");
      const query = new URLSearchParams({
        upload_id: input.upload_id,
        order_id: input.order_id,
        garment_id: input.garment_id,
        kind: input.kind,
        ...(input.taken_at === undefined ? {} : { taken_at: String(input.taken_at) }),
      });
      try {
        const body = new Blob([Uint8Array.from(input.bytes)], { type: input.content_type });
        const response = await fetchImpl(`${base}/api/v2/photos?${query.toString()}`, {
          method: "POST",
          credentials: "include",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": input.content_type,
            "x-csrf-token": csrf,
          },
          body,
        });
        const value: unknown = await response.json();
        if (isRecord(value) && hasExactKeys(value, ["ok", "data"]) && value.ok === true) {
          const data = parsePhotoUploadData(value.data);
          if (data !== null) return Object.freeze({ ok: true as const, data });
          return failure("PHOTO_UPLOAD_FAILED", "照片上传响应格式错误");
        }
        return Object.freeze({ ok: false as const, error: parseFailure(value) });
      } catch {
        return failure("NETWORK", "无法连接本地服务器");
      }
    },
    async read(
      photoId: string,
      variant: PhotoReadVariant,
    ): Promise<CommandResult<PhotoBinaryData>> {
      const path = readPhotoPath(photoId, variant);
      if (path === null) return failure("VALIDATION_FAILED", "照片参数无效");
      const token = options.getAccessToken();
      if (token === null || token.length === 0) return failure("AUTHENTICATION_FAILED", "未登录");
      try {
        const response = await fetchImpl(`${base}${path}`, {
          method: "GET",
          credentials: "include",
          headers: { authorization: `Bearer ${token}` },
        });
        if (!response.ok) {
          return Object.freeze({ ok: false as const, error: await parseReadFailure(response) });
        }
        const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim() ?? "";
        if (!isPhotoContentType(contentType)) {
          return failure("PHOTO_READ_FAILED", "照片响应类型错误");
        }
        const contentLengthHeader = response.headers.get("content-length");
        const contentLength =
          contentLengthHeader === null ? null : Number.parseInt(contentLengthHeader, 10);
        if (
          contentLength !== null &&
          (!Number.isSafeInteger(contentLength) ||
            String(contentLength) !== contentLengthHeader ||
            contentLength < 1 ||
            contentLength > MAX_PHOTO_BYTES)
        ) {
          return failure("PHOTO_READ_FAILED", "照片响应大小错误");
        }
        const bytes = await readBoundedPhotoBytes(response);
        if (bytes === null || (contentLength !== null && bytes.byteLength !== contentLength)) {
          return failure("PHOTO_READ_FAILED", "照片响应大小错误");
        }
        return Object.freeze({
          ok: true as const,
          data: Object.freeze({ content_type: contentType, bytes: Uint8Array.from(bytes) }),
        });
      } catch {
        return failure("NETWORK", "无法连接本地服务器");
      }
    },
    async remove(photoId: string, deleteId: string): Promise<CommandResult<PhotoUploadData>> {
      if (!UUID.test(photoId) || !UUID.test(deleteId)) {
        return failure("VALIDATION_FAILED", "照片参数无效");
      }
      const token = options.getAccessToken();
      if (token === null || token.length === 0) return failure("AUTHENTICATION_FAILED", "未登录");
      const csrf = options.readCsrf();
      if (csrf === null || csrf.length === 0) return failure("CSRF_REJECTED", "缺少 CSRF cookie");
      try {
        const response = await fetchImpl(`${base}/api/v2/photos/${photoId}/delete`, {
          method: "POST",
          credentials: "include",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "x-csrf-token": csrf,
          },
          body: JSON.stringify({ delete_id: deleteId }),
        });
        const value: unknown = await response.json();
        if (isRecord(value) && hasExactKeys(value, ["ok", "data"]) && value.ok === true) {
          const data = parsePhotoUploadData(value.data);
          if (data !== null) return Object.freeze({ ok: true as const, data });
          return failure("PHOTO_DELETE_FAILED", "照片删除响应格式错误");
        }
        return Object.freeze({ ok: false as const, error: parseFailure(value) });
      } catch {
        return failure("NETWORK", "无法连接本地服务器");
      }
    },
  });
}
