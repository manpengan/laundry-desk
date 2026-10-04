import { z } from "zod";
import { channelHttp } from "./http.js";
import { alipayNotification, alipayPayment, alipayRefund } from "./alipay-projections.js";
import {
  channelClock,
  header,
  parseChannelJson,
  parseProviderResponse,
  providerErrorCode,
  requireRsaKey,
  rsaSign,
  rsaVerify,
  verifiedTimestamp,
  yuan,
} from "./protocol.js";
import {
  AlipayCredentialSchema,
  ChannelCentsSchema,
  ChannelProtocolError,
  MerchantOrderSchema,
  type AlipayCredential,
  type ChannelAdapter,
  type ChannelClock,
  type ChannelHttp,
  type ChannelHttpResponse,
} from "./types.js";

const NOT_FOUND = new Set(["ACQ.TRADE_NOT_EXIST", "TRADE_NOT_EXIST"]);

export function verifyAlipayResponse(
  response: ChannelHttpResponse,
  config: AlipayCredential,
  clock: ChannelClock,
): void {
  const timestamp = header(response, "alipay-timestamp");
  const nonce = header(response, "alipay-nonce");
  verifiedTimestamp(timestamp, clock.nowMs(), "ms");
  rsaVerify(
    `${timestamp}\n${nonce}\n${response.body}\n`,
    header(response, "alipay-signature"),
    config.platformPublicKey,
  );
}

/** Same rule as WeChat: success must be signed; only signed 4xx or unsigned 401 are definitive. */
function classifyAlipay(
  response: ChannelHttpResponse,
  config: AlipayCredential,
  clock: ChannelClock,
): void {
  let signed = true;
  try {
    verifyAlipayResponse(response, config, clock);
  } catch {
    signed = false;
  }
  if (response.status >= 200 && response.status < 300) {
    if (!signed) throw new ChannelProtocolError("CHANNEL_SIGNATURE_INVALID");
    return;
  }
  const code = providerErrorCode(response.body);
  if (!signed) {
    if (response.status === 401) throw new ChannelProtocolError("CHANNEL_REJECTED", code);
    throw new ChannelProtocolError("CHANNEL_SIGNATURE_INVALID", code);
  }
  if (response.status >= 500) throw new ChannelProtocolError("CHANNEL_TRANSPORT_FAILED", code);
  if (code !== null && NOT_FOUND.has(code))
    throw new ChannelProtocolError("CHANNEL_ORDER_NOT_FOUND", code);
  throw new ChannelProtocolError("CHANNEL_REJECTED", code);
}

/** Direct merchant public-key mode using the official v3 RSA2 wire protocol. */
export function createAlipayAdapter(
  raw: AlipayCredential,
  http: ChannelHttp = channelHttp,
  clock: ChannelClock = channelClock,
): ChannelAdapter {
  const config = AlipayCredentialSchema.parse(raw);
  requireRsaKey(config.privateKey, "private");
  requireRsaKey(config.platformPublicKey, "public");
  const request = async (path: string, value: unknown): Promise<unknown> => {
    const body = JSON.stringify(value);
    const authority = `app_id=${config.appId},nonce=${clock.nonce()},timestamp=${clock.nowMs()}`;
    const signature = rsaSign(`${authority}\nPOST\n${path}\n${body}\n`, config.privateKey);
    const response = await http({
      channel: "alipay",
      method: "POST",
      path,
      body,
      headers: {
        "Content-Type": "application/json",
        "alipay-request-id": clock.nonce(),
        Authorization: `ALIPAY-SHA256withRSA ${authority},sign=${signature}`,
      },
    });
    classifyAlipay(response, config, clock);
    return parseChannelJson(response.body);
  };
  const refundQuery = async (merchantOrder: string, merchantRefund: string) =>
    request("/v3/alipay/trade/fastpay/refund/query", {
      out_trade_no: merchantOrder,
      out_request_no: merchantRefund,
    });
  return Object.freeze({
    async checkout(input) {
      MerchantOrderSchema.parse(input.merchantOrder);
      ChannelCentsSchema.parse(input.amountCents);
      if (input.openId !== undefined) throw new ChannelProtocolError("CHANNEL_NOT_SENT");
      const value = await request("/v3/alipay/trade/precreate", {
        out_trade_no: input.merchantOrder,
        total_amount: yuan(input.amountCents),
        subject: z.string().trim().min(1).max(100).parse(input.description),
        seller_id: config.sellerId,
        notify_url: config.notifyUrl,
        timeout_express: "15m",
        qr_code_timeout_express: "15m",
      });
      const result = parseProviderResponse(() =>
        z.object({ out_trade_no: MerchantOrderSchema, qr_code: z.url().max(1024) }).parse(value),
      );
      const qr = new URL(result.qr_code);
      if (
        result.out_trade_no !== input.merchantOrder ||
        qr.origin !== "https://qr.alipay.com" ||
        qr.username ||
        qr.password ||
        qr.hash
      )
        throw new ChannelProtocolError("CHANNEL_BINDING_MISMATCH");
      return Object.freeze({ kind: "qr" as const, value: result.qr_code });
    },
    async query(merchantOrder) {
      MerchantOrderSchema.parse(merchantOrder);
      const value = await request("/v3/alipay/trade/query", { out_trade_no: merchantOrder });
      const payment = parseProviderResponse(() => alipayPayment(value));
      if (payment.merchantOrder !== merchantOrder)
        throw new ChannelProtocolError("CHANNEL_BINDING_MISMATCH");
      return payment;
    },
    async close(merchantOrder) {
      MerchantOrderSchema.parse(merchantOrder);
      // Cancel, not close: a precreated code that was never scanned has no trade to
      // close, while cancel also voids it (and returns money if the buyer just paid).
      const value = await request("/v3/alipay/trade/cancel", { out_trade_no: merchantOrder });
      const result = parseProviderResponse(() =>
        z
          .object({ out_trade_no: MerchantOrderSchema, retry_flag: z.enum(["Y", "N"]) })
          .parse(value),
      );
      if (result.out_trade_no !== merchantOrder)
        throw new ChannelProtocolError("CHANNEL_BINDING_MISMATCH");
      return Object.freeze({ outcome: result.retry_flag === "Y" ? "retry" : "closed" });
    },
    async refund(input) {
      MerchantOrderSchema.parse(input.merchantOrder);
      MerchantOrderSchema.parse(input.merchantRefund);
      ChannelCentsSchema.parse(input.amountCents);
      ChannelCentsSchema.parse(input.originalCents);
      if (input.amountCents > input.originalCents)
        throw new ChannelProtocolError("CHANNEL_BINDING_MISMATCH");
      await request("/v3/alipay/trade/refund", {
        out_trade_no: input.merchantOrder,
        out_request_no: input.merchantRefund,
        refund_amount: yuan(input.amountCents),
        refund_reason: z.string().trim().min(1).max(80).parse(input.reason),
      });
      // A successful submission is not completion. Query the exact refund reference.
      const value = await refundQuery(input.merchantOrder, input.merchantRefund);
      return parseProviderResponse(() => alipayRefund(value, input));
    },
    async queryRefund(input) {
      MerchantOrderSchema.parse(input.merchantOrder);
      MerchantOrderSchema.parse(input.merchantRefund);
      const value = await refundQuery(input.merchantOrder, input.merchantRefund);
      return parseProviderResponse(() => alipayRefund(value, input));
    },
    notification(response) {
      return alipayNotification(response.body, config);
    },
  });
}
