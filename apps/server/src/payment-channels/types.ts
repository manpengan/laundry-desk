import { z } from "zod";
import {
  PaymentChannelSchema,
  PaymentWechatCredentialSchema,
  PaymentAlipayCredentialSchema,
  PaymentCredentialSchema,
} from "@laundry/contracts";

export const ChannelSchema = PaymentChannelSchema;
export type PaymentChannel = z.infer<typeof ChannelSchema>;
export const ChannelCentsSchema = z.number().int().positive().max(5_000_000);
export const MerchantOrderSchema = z.string().regex(/^[A-Za-z0-9_]{1,32}$/u);
export const ProviderReferenceSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u);
export const WechatCredentialSchema = PaymentWechatCredentialSchema;
export const AlipayCredentialSchema = PaymentAlipayCredentialSchema;
export const ChannelCredentialSchema = PaymentCredentialSchema;
export type WechatCredential = z.infer<typeof WechatCredentialSchema>;
export type AlipayCredential = z.infer<typeof AlipayCredentialSchema>;
export type ChannelCredential = z.infer<typeof ChannelCredentialSchema>;

export type ChannelHttpRequest = Readonly<{
  channel: PaymentChannel;
  method: "GET" | "POST";
  path: string;
  headers: Readonly<Record<string, string>>;
  body: string;
}>;
export type ChannelHttpResponse = Readonly<{
  status: number;
  headers: Readonly<Record<string, string>>;
  body: string;
}>;
export type ChannelHttp = (request: ChannelHttpRequest) => Promise<ChannelHttpResponse>;
export type ChannelClock = Readonly<{ nowMs: () => number; nonce: () => string }>;
export type ChannelCheckout = Readonly<{
  merchantOrder: string;
  amountCents: number;
  description: string;
  expiresAt: Date;
  openId?: string;
}>;
export type ChannelCheckoutResult =
  | Readonly<{ kind: "qr"; value: string }>
  | Readonly<{
      kind: "jsapi";
      appId: string;
      timeStamp: string;
      nonceStr: string;
      package: string;
      signType: "RSA";
      paySign: string;
    }>;
export type ChannelPayment = Readonly<{
  merchantOrder: string;
  providerOrder: string | null;
  state: "pending" | "paid" | "closed";
  /** Optional in provider answers for unpaid orders; always present once paid. */
  amountCents: number | null;
  paidAt: Date | null;
}>;
/** Ends an unpaid order: WeChat close, Alipay cancel (which also covers unscanned codes). */
export type ChannelExpiry = Readonly<{ outcome: "closed" | "retry" }>;
export type ChannelRefundInput = Readonly<{
  merchantOrder: string;
  merchantRefund: string;
  amountCents: number;
  originalCents: number;
  reason: string;
}>;
export type ChannelRefund = Readonly<{
  merchantOrder: string;
  merchantRefund: string;
  providerRefund: string;
  amountCents: number;
  state: "pending" | "refunded" | "failed";
}>;
export type ChannelNotification =
  | Readonly<{ kind: "payment"; id: string; payment: ChannelPayment }>
  | Readonly<{ kind: "refund"; id: string; refund: ChannelRefund }>;
export type ChannelAdapter = Readonly<{
  checkout(input: ChannelCheckout): Promise<ChannelCheckoutResult>;
  query(merchantOrder: string): Promise<ChannelPayment>;
  /** Stops an unpaid order from being paid; ORDER_NOT_FOUND means it never existed. */
  close(merchantOrder: string): Promise<ChannelExpiry>;
  refund(input: ChannelRefundInput): Promise<ChannelRefund>;
  queryRefund(input: ChannelRefundInput): Promise<ChannelRefund>;
  notification(response: ChannelHttpResponse): ChannelNotification;
}>;

export type ChannelErrorCode =
  /** The request never left this computer (DNS, connect, TLS or local validation). */
  | "CHANNEL_NOT_SENT"
  /** The provider may have received the request; only a query can tell. */
  | "CHANNEL_TRANSPORT_FAILED"
  | "CHANNEL_SIGNATURE_INVALID"
  | "CHANNEL_RESPONSE_INVALID"
  | "CHANNEL_BINDING_MISMATCH"
  /** A definitive provider rejection; nothing was created or changed. */
  | "CHANNEL_REJECTED"
  /** The provider definitively has no such order/trade/refund. */
  | "CHANNEL_ORDER_NOT_FOUND";

const PROVIDER_CODE = /^[A-Za-z0-9_.]{1,64}$/u;

/** Deliberately contains no response body, URL, credentials or provider PII. */
export class ChannelProtocolError extends Error {
  /** The provider's public error code (e.g. ORDERPAID), never free text. */
  readonly providerCode: string | null;
  constructor(
    readonly code: ChannelErrorCode,
    providerCode?: unknown,
  ) {
    super(code);
    this.name = "ChannelProtocolError";
    this.providerCode =
      typeof providerCode === "string" && PROVIDER_CODE.test(providerCode) ? providerCode : null;
  }
}
