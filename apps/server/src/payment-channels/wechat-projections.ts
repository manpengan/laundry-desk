import { createDecipheriv } from "node:crypto";
import { z } from "zod";
import { parseChannelJson, providerDate } from "./protocol.js";
import {
  ChannelProtocolError,
  MerchantOrderSchema,
  ProviderReferenceSchema,
  type ChannelNotification,
  type ChannelPayment,
  type ChannelRefund,
  type ChannelRefundInput,
  type WechatCredential,
} from "./types.js";

const Amount = z.number().int().nonnegative().max(5_000_000);
const Payment = z.object({
  appid: z.string(),
  mchid: z.string(),
  out_trade_no: MerchantOrderSchema,
  transaction_id: ProviderReferenceSchema.optional(),
  trade_state: z.enum([
    "SUCCESS",
    "REFUND",
    "NOTPAY",
    "CLOSED",
    "REVOKED",
    "USERPAYING",
    "PAYERROR",
  ]),
  // The query API documents every amount field as optional; unpaid orders may omit
  // `currency` (only `payer_currency` is returned). A paid answer must carry `total`.
  amount: z.object({ total: Amount.optional(), currency: z.literal("CNY").optional() }).optional(),
  success_time: z.string().optional(),
});
export function wechatPayment(raw: unknown, config: WechatCredential): ChannelPayment {
  const value = Payment.parse(raw);
  if (value.appid !== config.appId || value.mchid !== config.merchantId)
    throw new ChannelProtocolError("CHANNEL_BINDING_MISMATCH");
  const paid = value.trade_state === "SUCCESS" || value.trade_state === "REFUND";
  const total = value.amount?.total ?? null;
  if (
    paid &&
    (value.transaction_id === undefined || value.success_time === undefined || total === null)
  )
    throw new ChannelProtocolError("CHANNEL_RESPONSE_INVALID");
  return Object.freeze({
    merchantOrder: value.out_trade_no,
    providerOrder: value.transaction_id ?? null,
    state: paid
      ? "paid"
      : ["NOTPAY", "USERPAYING"].includes(value.trade_state)
        ? "pending"
        : "closed",
    amountCents: total,
    paidAt: paid ? providerDate(value.success_time as string) : null,
  });
}
const Refund = z.object({
  out_trade_no: MerchantOrderSchema,
  out_refund_no: MerchantOrderSchema,
  refund_id: ProviderReferenceSchema,
  status: z.enum(["SUCCESS", "CLOSED", "PROCESSING", "ABNORMAL"]),
  amount: z.object({ total: Amount, refund: Amount, currency: z.literal("CNY").optional() }),
});
export function wechatRefund(raw: unknown, expected?: ChannelRefundInput): ChannelRefund {
  const value = Refund.parse(raw);
  if (
    expected !== undefined &&
    (value.out_trade_no !== expected.merchantOrder ||
      value.out_refund_no !== expected.merchantRefund ||
      value.amount.refund !== expected.amountCents ||
      value.amount.total !== expected.originalCents)
  )
    throw new ChannelProtocolError("CHANNEL_BINDING_MISMATCH");
  return Object.freeze({
    merchantOrder: value.out_trade_no,
    merchantRefund: value.out_refund_no,
    providerRefund: value.refund_id,
    amountCents: value.amount.refund,
    state:
      value.status === "SUCCESS"
        ? "refunded"
        : ["PROCESSING", "ABNORMAL"].includes(value.status)
          ? "pending"
          : "failed",
  });
}
const Notification = z.object({
  id: ProviderReferenceSchema,
  event_type: z.enum(["TRANSACTION.SUCCESS", "REFUND.SUCCESS", "REFUND.ABNORMAL", "REFUND.CLOSED"]),
  resource_type: z.literal("encrypt-resource"),
  resource: z.object({
    algorithm: z.literal("AEAD_AES_256_GCM"),
    ciphertext: z
      .string()
      .min(24)
      .max(131072)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/u),
    nonce: z.string().length(12),
    associated_data: z.string().max(256).optional(),
  }),
});
export function wechatNotification(raw: string, config: WechatCredential): ChannelNotification {
  const envelope = Notification.parse(parseChannelJson(raw));
  const encrypted = Buffer.from(envelope.resource.ciphertext, "base64");
  let bytes: Buffer;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      Buffer.from(config.apiV3Key, "utf8"),
      Buffer.from(envelope.resource.nonce, "utf8"),
    );
    decipher.setAAD(Buffer.from(envelope.resource.associated_data ?? "", "utf8"));
    decipher.setAuthTag(encrypted.subarray(-16));
    bytes = Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]);
  } catch {
    throw new ChannelProtocolError("CHANNEL_SIGNATURE_INVALID");
  }
  try {
    const value = parseChannelJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (envelope.event_type === "TRANSACTION.SUCCESS") {
      const payment = wechatPayment(value, config);
      if (payment.state !== "paid") throw new ChannelProtocolError("CHANNEL_BINDING_MISMATCH");
      return Object.freeze({ kind: "payment", id: envelope.id, payment });
    }
    const refund = z.object({ mchid: z.string(), refund_status: z.string() }).parse(value);
    if (
      refund.mchid !== config.merchantId ||
      `REFUND.${refund.refund_status}` !== envelope.event_type
    )
      throw new ChannelProtocolError("CHANNEL_BINDING_MISMATCH");
    return Object.freeze({
      kind: "refund",
      id: envelope.id,
      refund: wechatRefund({ ...(value as Record<string, unknown>), status: refund.refund_status }),
    });
  } finally {
    bytes.fill(0);
  }
}
