import { randomUUID } from "node:crypto";
import { z } from "zod";
import { failedBeforeSending } from "../../http/unsent-failure.js";
import { signAliyunRequest, type AliyunCredentials } from "./aliyun-signature.js";

const HOST = "dysmsapi.aliyuncs.com";
const MAX_RESPONSE_BYTES = 64 * 1024;
const Phone = z.string().regex(/^1[3-9]\d{9}$/u);
const DeliveryId = z.uuid();
const TemplateCode = z.string().regex(/^SMS_\d{1,32}$/u);
const SendInput = z.strictObject({
  phone: Phone,
  deliveryId: DeliveryId,
  signName: z
    .string()
    .trim()
    .min(2)
    .max(12)
    .regex(/^[\p{L}\p{N}·]+$/u),
  templateCode: TemplateCode,
  // ADR-77 r1: the approved template reads the balance in 元 ("20.00"), never in 分.
  parameters: z.strictObject({
    tickets: z.string().regex(/^[A-Za-z0-9-]{1,32}$/u),
    garment_count: z.string().regex(/^\d{1,8}$/u),
    balance_yuan: z.string().regex(/^\d{1,10}\.\d{2}$/u),
  }),
});
const QueryInput = z.strictObject({
  phone: Phone,
  deliveryId: DeliveryId,
  templateCode: TemplateCode,
  sendDate: z.string().regex(/^\d{8}$/u),
  bizId: z
    .string()
    .regex(/^[A-Za-z0-9^_-]{1,128}$/u)
    .optional(),
});
const SendResult = z.object({ Code: z.string().max(128), BizId: z.string().max(128).optional() });
const Details = z.object({
  Code: z.literal("OK"),
  TotalCount: z.union([z.string().regex(/^\d{1,10}$/u), z.number().int().nonnegative().max(1e9)]),
  SmsSendDetailDTOs: z.object({
    SmsSendDetailDTO: z
      .array(
        z.object({
          OutId: z.string().max(128).optional(),
          PhoneNum: z.string().max(32),
          TemplateCode: z.string().max(64).optional(),
          SendStatus: z.union([z.literal(1), z.literal(2), z.literal(3)]),
        }),
      )
      .max(50),
  }),
});
export type AliyunSmsSendInput = z.infer<typeof SendInput>;
export type AliyunSmsQueryInput = z.infer<typeof QueryInput>;
/**
 * ADR-91 §2: not_sent never produced a message (it never reached Aliyun, or Aliyun reported
 * its own failure); rejected is Aliyun's explicit refusal; only a request Aliyun may have
 * accepted is uncertain.
 */
export type AliyunSmsSendResult = Readonly<
  | { status: "accepted"; bizId: string }
  | { status: "not_sent"; code: string }
  | { status: "rejected"; code: string }
  | { status: "uncertain"; code: "ALIYUN_OUTCOME_UNKNOWN" }
>;
type Outcome = "not_sent" | "rejected" | "uncertain";
export type AliyunSmsFailureLog = (
  entry: Readonly<{
    stage: "prepare" | "send" | "response";
    outcome: Outcome;
    code: string;
    http_status: number | null;
    aliyun_code: string | null;
  }>,
) => void;
/** Aliyun codes staff can act on; anything else is a generic refusal. */
const REJECTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^InvalidAccessKeyId(\.|$)/u, "ALIYUN_ACCESS_KEY_INVALID"],
  [/^(SignatureDoesNotMatch|IncompleteSignature)$/u, "ALIYUN_SECRET_INVALID"],
  [/^(Forbidden(\.RAM)?|isv\.ACCOUNT_ABNORMAL|isv\.ACCOUNT_NOT_EXISTS)$/u, "ALIYUN_ACCOUNT_DENIED"],
  [
    /^isv\.(SMS_SIGNATURE_ILLEGAL|SMS_SIGN_ILLEGAL|SIGN_NAME_ILLEGAL)$/u,
    "ALIYUN_SIGN_NAME_INVALID",
  ],
  [/^isv\.SMS_TEMPLATE_ILLEGAL$/u, "ALIYUN_TEMPLATE_INVALID"],
  [
    /^isv\.(TEMPLATE_MISSING_PARAMETERS|TEMPLATE_PARAMS_ILLEGAL|PARAM_LENGTH_LIMIT|INVALID_JSON_PARAM)$/u,
    "ALIYUN_TEMPLATE_PARAMS_INVALID",
  ],
  [/^isv\.(MOBILE_NUMBER_ILLEGAL|MOBILE_COUNT_OVER_LIMIT)$/u, "ALIYUN_PHONE_INVALID"],
  [/^isv\.(BUSINESS_LIMIT_CONTROL|DAY_LIMIT_CONTROL|MONTH_LIMIT_CONTROL)$/u, "ALIYUN_RATE_LIMITED"],
  [/^isv\.(AMOUNT_NOT_ENOUGH|OUT_OF_SERVICE)$/u, "ALIYUN_BALANCE_INSUFFICIENT"],
];
const rejectionCode = (code: string) =>
  REJECTIONS.find(([pattern]) => pattern.test(code))?.[1] ?? "ALIYUN_REQUEST_REJECTED";
const AliyunCode = z.string().regex(/^[A-Za-z0-9_.]{1,64}$/u);
const defaultFailureLog: AliyunSmsFailureLog = (entry) => {
  // Structured and free of recipient, message and credential data.
  const line = { level: "warn", time: new Date().toISOString(), msg: "Aliyun SMS not accepted" };
  process.stderr.write(`${JSON.stringify({ ...line, ...entry })}\n`);
};
type Fetch = (
  url: string,
  init: Readonly<{
    method: "POST";
    headers: Readonly<Record<string, string>>;
    redirect: "error";
    signal: AbortSignal;
  }>,
) => Promise<Response>;

/** Reads a direct (2xx or 4xx) answer; callers decide what its status means. */
async function boundedJson(response: Response): Promise<unknown> {
  const direct =
    response.status >= 200 &&
    response.status < 500 &&
    !(response.status >= 300 && response.status < 400);
  if (!direct || response.redirected || response.body === null)
    throw new Error("ALIYUN_RESPONSE_INVALID");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.length;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("ALIYUN_RESPONSE_TOO_LARGE");
      }
      chunks.push(item.value);
    }
    return JSON.parse(Buffer.concat(chunks, size).toString("utf8")) as unknown;
  } finally {
    reader.releaseLock();
  }
}

export function createAliyunSmsClient(
  options: Readonly<{
    credentials: () => Promise<AliyunCredentials>;
    fetch?: Fetch;
    now?: () => Date;
    nonce?: () => string;
    log?: AliyunSmsFailureLog;
  }>,
) {
  const sign = async (
    action: "SendSms" | "QuerySendDetails",
    parameters: Readonly<Record<string, string>>,
  ) => {
    const credentials = await options.credentials();
    return signAliyunRequest({
      host: HOST,
      action,
      version: "2017-05-25",
      parameters,
      timestamp: (options.now?.() ?? new Date()).toISOString().replace(/\.\d{3}Z$/u, "Z"),
      nonce: options.nonce?.() ?? randomUUID(),
      credentials,
    });
  };
  const dispatch = (signed: Awaited<ReturnType<typeof sign>>, signal: AbortSignal) =>
    (options.fetch ?? fetch)(`https://${HOST}/?${signed.query}`, {
      method: "POST",
      headers: signed.headers,
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    });
  const request = async (
    action: "SendSms" | "QuerySendDetails",
    parameters: Readonly<Record<string, string>>,
    signal: AbortSignal,
  ): Promise<unknown> => {
    signal.throwIfAborted();
    const response = await dispatch(await sign(action, parameters), signal);
    if (!response.ok) throw new Error("ALIYUN_RESPONSE_INVALID");
    return boundedJson(response);
  };
  const log = options.log ?? defaultFailureLog;
  function failure(
    stage: "prepare" | "send" | "response",
    outcome: Outcome,
    code: string,
    detail: Readonly<{ httpStatus?: number; aliyunCode?: string }> = {},
  ): AliyunSmsSendResult {
    const aliyun = AliyunCode.safeParse(detail.aliyunCode);
    log({
      stage,
      outcome,
      code,
      http_status: detail.httpStatus ?? null,
      aliyun_code: aliyun.success ? aliyun.data : null,
    });
    return outcome === "uncertain"
      ? { status: "uncertain", code: "ALIYUN_OUTCOME_UNKNOWN" }
      : { status: outcome, code };
  }
  /** Classifies an answer from Aliyun: the request has reached it. */
  async function answered(response: Response): Promise<AliyunSmsSendResult> {
    const httpStatus = response.status;
    if (httpStatus >= 500)
      return failure("response", "uncertain", "ALIYUN_OUTCOME_UNKNOWN", { httpStatus });
    let body: z.infer<typeof SendResult>;
    try {
      body = SendResult.parse(await boundedJson(response));
    } catch {
      return httpStatus >= 400
        ? failure("response", "rejected", "ALIYUN_REQUEST_REJECTED", { httpStatus })
        : failure("response", "uncertain", "ALIYUN_OUTCOME_UNKNOWN", { httpStatus });
    }
    const aliyunCode = body.Code;
    if (aliyunCode === "OK" && httpStatus < 300) {
      if (body.BizId && /^[A-Za-z0-9^_-]{1,128}$/u.test(body.BizId))
        return { status: "accepted", bizId: body.BizId };
      return failure("response", "uncertain", "ALIYUN_OUTCOME_UNKNOWN", { httpStatus });
    }
    // Aliyun asks callers to retry its own system errors: the message was not sent.
    if (aliyunCode === "isp.SYSTEM_ERROR")
      return failure("response", "not_sent", "ALIYUN_SYSTEM_BUSY", { httpStatus, aliyunCode });
    return failure("response", "rejected", rejectionCode(aliyunCode), { httpStatus, aliyunCode });
  }
  return Object.freeze({
    async send(candidate: AliyunSmsSendInput, signal: AbortSignal): Promise<AliyunSmsSendResult> {
      const parsed = SendInput.safeParse(candidate);
      if (!parsed.success) return failure("prepare", "rejected", "ALIYUN_INPUT_INVALID");
      const input = parsed.data;
      let signed: Awaited<ReturnType<typeof sign>>;
      try {
        signed = await sign("SendSms", {
          PhoneNumbers: input.phone,
          SignName: input.signName,
          TemplateCode: input.templateCode,
          TemplateParam: JSON.stringify(input.parameters),
          OutId: input.deliveryId,
        });
      } catch {
        return failure("prepare", "not_sent", "ALIYUN_CREDENTIAL_UNAVAILABLE");
      }
      if (signal.aborted) return failure("prepare", "not_sent", "ALIYUN_NOT_SENT");
      let response: Response;
      try {
        response = await dispatch(signed, signal);
      } catch (error) {
        // SendSms has no provider idempotency: only a provably unopened connection is retried.
        return failedBeforeSending(error)
          ? failure("send", "not_sent", "ALIYUN_NOT_SENT")
          : failure("send", "uncertain", "ALIYUN_OUTCOME_UNKNOWN");
      }
      return answered(response);
    },
    async query(
      candidate: AliyunSmsQueryInput,
      signal: AbortSignal,
    ): Promise<"delivered" | "failed" | "pending" | "unknown"> {
      const input = QueryInput.parse(candidate);
      const matches: number[] = [];
      for (let page = 1; page <= 10; page++) {
        const body = Details.parse(
          await request(
            "QuerySendDetails",
            {
              PhoneNumber: input.phone,
              SendDate: input.sendDate,
              PageSize: "50",
              CurrentPage: String(page),
              ...(input.bizId === undefined ? {} : { BizId: input.bizId }),
            },
            signal,
          ),
        );
        matches.push(
          ...body.SmsSendDetailDTOs.SmsSendDetailDTO.filter(
            (item) =>
              item.OutId === input.deliveryId &&
              item.PhoneNum === input.phone &&
              item.TemplateCode === input.templateCode,
          ).map((item) => item.SendStatus),
        );
        if (matches.length > 1) return "unknown";
        if (Number(body.TotalCount) <= page * 50)
          return matches.length === 0
            ? "unknown"
            : matches[0] === 3
              ? "delivered"
              : matches[0] === 2
                ? "failed"
                : "pending";
      }
      return "unknown";
    },
  });
}
