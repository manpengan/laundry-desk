import { randomUUID } from "node:crypto";
import { z } from "zod";
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
  parameters: z.strictObject({
    tickets: z.string().regex(/^[A-Za-z0-9-]{1,32}$/u),
    garment_count: z.string().regex(/^\d{1,8}$/u),
    balance_cents: z.string().regex(/^\d{1,12}$/u),
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
export type AliyunSmsSendResult = Readonly<
  | { status: "accepted"; bizId: string }
  | { status: "rejected"; code: "ALIYUN_REQUEST_REJECTED" }
  | { status: "uncertain"; code: "ALIYUN_OUTCOME_UNKNOWN" }
>;
type Fetch = (
  url: string,
  init: Readonly<{
    method: "POST";
    headers: Readonly<Record<string, string>>;
    redirect: "error";
    signal: AbortSignal;
  }>,
) => Promise<Response>;

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.ok || response.redirected || response.body === null)
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
  }>,
) {
  const request = async (
    action: "SendSms" | "QuerySendDetails",
    parameters: Readonly<Record<string, string>>,
    signal: AbortSignal,
  ): Promise<unknown> => {
    signal.throwIfAborted();
    const credentials = await options.credentials();
    const signed = signAliyunRequest({
      host: HOST,
      action,
      version: "2017-05-25",
      parameters,
      timestamp: (options.now?.() ?? new Date()).toISOString().replace(/\.\d{3}Z$/u, "Z"),
      nonce: options.nonce?.() ?? randomUUID(),
      credentials,
    });
    const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
    const response = await (options.fetch ?? fetch)(`https://${HOST}/?${signed.query}`, {
      method: "POST",
      headers: signed.headers,
      redirect: "error",
      signal: boundedSignal,
    });
    return boundedJson(response);
  };
  return Object.freeze({
    async send(candidate: AliyunSmsSendInput, signal: AbortSignal): Promise<AliyunSmsSendResult> {
      const input = SendInput.parse(candidate);
      try {
        const body = SendResult.parse(
          await request(
            "SendSms",
            {
              PhoneNumbers: input.phone,
              SignName: input.signName,
              TemplateCode: input.templateCode,
              TemplateParam: JSON.stringify(input.parameters),
              OutId: input.deliveryId,
            },
            signal,
          ),
        );
        if (body.Code !== "OK") return { status: "rejected", code: "ALIYUN_REQUEST_REJECTED" };
        if (!body.BizId || !/^[A-Za-z0-9^_-]{1,128}$/u.test(body.BizId))
          throw new Error("ALIYUN_RECEIPT_MISSING");
        return { status: "accepted", bizId: body.BizId };
      } catch {
        // SendSms has no provider idempotency. Never retry an ambiguous network outcome here.
        return { status: "uncertain", code: "ALIYUN_OUTCOME_UNKNOWN" };
      }
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
