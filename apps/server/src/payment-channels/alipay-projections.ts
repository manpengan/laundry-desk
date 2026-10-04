import { z } from "zod";
import { fen, providerDate, rsaVerify } from "./protocol.js";
import {
  ChannelProtocolError,
  MerchantOrderSchema,
  ProviderReferenceSchema,
  type AlipayCredential,
  type ChannelNotification,
  type ChannelPayment,
  type ChannelRefund,
  type ChannelRefundInput,
} from "./types.js";

const Payment = z.object({
  out_trade_no: MerchantOrderSchema,
  trade_no: ProviderReferenceSchema,
  trade_status: z.enum(["WAIT_BUYER_PAY", "TRADE_CLOSED", "TRADE_SUCCESS", "TRADE_FINISHED"]),
  total_amount: z.string().max(16),
  send_pay_date: z.string().max(40).optional(),
});
export function alipayPayment(raw: unknown): ChannelPayment {
  const value = Payment.parse(raw);
  const paid = value.trade_status === "TRADE_SUCCESS" || value.trade_status === "TRADE_FINISHED";
  if (paid && value.send_pay_date === undefined)
    throw new ChannelProtocolError("CHANNEL_RESPONSE_INVALID");
  return Object.freeze({
    merchantOrder: value.out_trade_no,
    providerOrder: value.trade_no,
    state: paid ? "paid" : value.trade_status === "WAIT_BUYER_PAY" ? "pending" : "closed",
    amountCents: fen(value.total_amount),
    paidAt: paid ? providerDate(value.send_pay_date as string) : null,
  });
}
const Refund = z.object({
  out_trade_no: MerchantOrderSchema,
  out_request_no: MerchantOrderSchema,
  trade_no: ProviderReferenceSchema,
  total_amount: z.string().max(16),
  refund_amount: z.string().max(16),
  refund_status: z.literal("REFUND_SUCCESS").optional(),
});
export function alipayRefund(raw: unknown, expected: ChannelRefundInput): ChannelRefund {
  // An answer without refund fields means Alipay never received this out_request_no;
  // resubmitting the same reference is idempotent.
  if (typeof raw === "object" && raw !== null && !("refund_amount" in raw))
    throw new ChannelProtocolError("CHANNEL_ORDER_NOT_FOUND");
  const value = Refund.parse(raw);
  if (
    value.out_trade_no !== expected.merchantOrder ||
    value.out_request_no !== expected.merchantRefund ||
    fen(value.refund_amount) !== expected.amountCents ||
    fen(value.total_amount) !== expected.originalCents
  )
    throw new ChannelProtocolError("CHANNEL_BINDING_MISMATCH");
  return Object.freeze({
    merchantOrder: value.out_trade_no,
    merchantRefund: value.out_request_no,
    providerRefund: `${value.trade_no}_${value.out_request_no}`,
    amountCents: expected.amountCents,
    state: value.refund_status === "REFUND_SUCCESS" ? "refunded" : "pending",
  });
}
export function alipayNotification(raw: string, config: AlipayCredential): ChannelNotification {
  if (Buffer.byteLength(raw, "utf8") > 65536 || /%(?![A-Fa-f0-9]{2})/u.test(raw))
    throw new ChannelProtocolError("CHANNEL_RESPONSE_INVALID");
  const parameters = new URLSearchParams(raw);
  const values = Object.fromEntries(parameters.entries());
  if (Object.keys(values).length !== [...parameters].length || Object.keys(values).length > 64)
    throw new ChannelProtocolError("CHANNEL_RESPONSE_INVALID");
  const signature = values.sign;
  if (typeof signature !== "string" || values.sign_type !== "RSA2")
    throw new ChannelProtocolError("CHANNEL_SIGNATURE_INVALID");
  const canonical = Object.keys(values)
    .filter((key) => key !== "sign" && key !== "sign_type" && values[key] !== "")
    .sort()
    .map((key) => `${key}=${values[key]}`)
    .join("&");
  rsaVerify(canonical, signature, config.platformPublicKey);
  if (values.app_id !== config.appId || values.seller_id !== config.sellerId)
    throw new ChannelProtocolError("CHANNEL_BINDING_MISMATCH");
  const id = ProviderReferenceSchema.parse(values.notify_id);
  const payment = alipayPayment({ ...values, send_pay_date: values.gmt_payment });
  return Object.freeze({ kind: "payment", id, payment });
}
