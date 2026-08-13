import {
  DeliveryEvidenceAttachmentSchema,
  type DeliveryEvidenceAttachment,
  type DeliveryEvidenceAttachmentKind,
  type DeliveryTaskLeg,
} from "@laundry/contracts";

import type { CommandResult } from "../commands/types.js";

export const MAX_DELIVERY_EVIDENCE_BYTES = 8 * 1_024 * 1_024;
type ContentType = DeliveryEvidenceAttachment["content_type"];

export type DeliveryEvidenceUploadInput = Readonly<{
  attachment_id: string;
  delivery_order_id: string;
  delivery_task_id: string;
  leg: DeliveryTaskLeg;
  expected_delivery_task_version: number;
  kind: DeliveryEvidenceAttachmentKind;
  captured_at: number;
  content_type: ContentType;
  bytes: Uint8Array;
}>;

export type DeliveryEvidenceMediaPort = Readonly<{
  upload: (
    input: DeliveryEvidenceUploadInput,
    options?: Readonly<{ signal?: AbortSignal }>,
  ) => Promise<CommandResult<Readonly<{ attachment: DeliveryEvidenceAttachment }>>>;
  read: (
    attachmentId: string,
    options?: Readonly<{ signal?: AbortSignal }>,
  ) => Promise<CommandResult<Readonly<{ content_type: ContentType; bytes: Uint8Array }>>>;
}>;

type Options = Readonly<{
  apiBaseUrl: string;
  fetchImpl: typeof fetch;
  getAccessToken: () => string | null;
  readCsrf: () => string | null;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CONTENT_TYPES: readonly ContentType[] = Object.freeze([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const failure = (code: string, message: string): CommandResult<never> =>
  Object.freeze({ ok: false as const, error: Object.freeze({ code, message }) });

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseFailure(value: unknown) {
  if (!isRecord(value) || !isRecord(value.error)) {
    return Object.freeze({ code: "DELIVERY_MEDIA_FAILED", message: "交付附件请求失败" });
  }
  return Object.freeze({
    code: typeof value.error.code === "string" ? value.error.code : "DELIVERY_MEDIA_FAILED",
    ...(typeof value.error.message === "string" ? { message: value.error.message } : {}),
  });
}

function validInput(input: DeliveryEvidenceUploadInput): boolean {
  return (
    UUID.test(input.attachment_id) &&
    UUID.test(input.delivery_order_id) &&
    UUID.test(input.delivery_task_id) &&
    ["pickup", "return"].includes(input.leg) &&
    Number.isSafeInteger(input.expected_delivery_task_version) &&
    input.expected_delivery_task_version > 0 &&
    ["photo", "signature"].includes(input.kind) &&
    Number.isSafeInteger(input.captured_at) &&
    input.captured_at >= 0 &&
    CONTENT_TYPES.includes(input.content_type) &&
    input.bytes.byteLength >= 1 &&
    input.bytes.byteLength <= MAX_DELIVERY_EVIDENCE_BYTES
  );
}

async function readBounded(response: Response): Promise<Uint8Array | null> {
  const buffer = new Uint8Array(await response.arrayBuffer());
  return buffer.byteLength >= 1 && buffer.byteLength <= MAX_DELIVERY_EVIDENCE_BYTES ? buffer : null;
}

export function createHttpDeliveryEvidenceMediaPort(options: Options): DeliveryEvidenceMediaPort {
  const base = options.apiBaseUrl.replace(/\/$/u, "");
  return Object.freeze({
    async upload(input, requestOptions = {}) {
      if (!validInput(input)) return failure("VALIDATION_FAILED", "交付附件参数无效");
      const token = options.getAccessToken();
      const csrf = options.readCsrf();
      if (token === null) return failure("AUTHENTICATION_FAILED", "未登录");
      if (csrf === null) return failure("CSRF_REJECTED", "缺少 CSRF cookie");
      const query = new URLSearchParams({
        attachment_id: input.attachment_id,
        delivery_order_id: input.delivery_order_id,
        delivery_task_id: input.delivery_task_id,
        leg: input.leg,
        expected_delivery_task_version: String(input.expected_delivery_task_version),
        kind: input.kind,
        captured_at: String(input.captured_at),
      });
      try {
        const response = await options.fetchImpl(
          `${base}/api/v2/delivery-evidence/attachments?${query.toString()}`,
          {
            method: "POST",
            credentials: "include",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": input.content_type,
              "x-csrf-token": csrf,
            },
            body: new Blob([Uint8Array.from(input.bytes)], { type: input.content_type }),
            ...(requestOptions.signal === undefined ? {} : { signal: requestOptions.signal }),
          },
        );
        const value: unknown = await response.json();
        if (response.ok && isRecord(value) && value.ok === true && isRecord(value.data)) {
          const parsed = DeliveryEvidenceAttachmentSchema.safeParse(value.data.attachment);
          if (parsed.success) {
            return Object.freeze({
              ok: true as const,
              data: Object.freeze({ attachment: Object.freeze({ ...parsed.data }) }),
            });
          }
        }
        return Object.freeze({ ok: false as const, error: parseFailure(value) });
      } catch {
        return failure(
          requestOptions.signal?.aborted === true ? "REQUEST_ABORTED" : "NETWORK",
          "交付附件上传失败",
        );
      }
    },
    async read(attachmentId, requestOptions = {}) {
      if (!UUID.test(attachmentId)) return failure("VALIDATION_FAILED", "附件编号无效");
      const token = options.getAccessToken();
      if (token === null) return failure("AUTHENTICATION_FAILED", "未登录");
      try {
        const response = await options.fetchImpl(
          `${base}/api/v2/delivery-evidence/attachments/${attachmentId}`,
          {
            credentials: "include",
            headers: { authorization: `Bearer ${token}` },
            ...(requestOptions.signal === undefined ? {} : { signal: requestOptions.signal }),
          },
        );
        const type = response.headers.get("content-type")?.split(";", 1)[0] as
          ContentType | undefined;
        if (response.ok && type !== undefined && CONTENT_TYPES.includes(type)) {
          const bytes = await readBounded(response);
          if (bytes !== null)
            return Object.freeze({
              ok: true as const,
              data: Object.freeze({ content_type: type, bytes }),
            });
        }
        const value: unknown = await response.json().catch(() => null);
        return Object.freeze({ ok: false as const, error: parseFailure(value) });
      } catch {
        return failure(
          requestOptions.signal?.aborted === true ? "REQUEST_ABORTED" : "NETWORK",
          "交付附件读取失败",
        );
      }
    },
  });
}
