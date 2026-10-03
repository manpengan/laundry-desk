import { z } from "zod";
import { channelHttp } from "./http.js";
import { alipayNotification, alipayPayment, alipayRefund } from "./alipay-projections.js";
import {
  channelClock,
  header,
  parseChannelJson,
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
    verifyAlipayResponse(response, config, clock);
    if (response.status < 200 || response.status >= 300)
      throw new ChannelProtocolError("CHANNEL_REJECTED");
    return parseChannelJson(response.body);
  };
  return Object.freeze({
    async checkout(input) {
      MerchantOrderSchema.parse(input.merchantOrder);
      ChannelCentsSchema.parse(input.amountCents);
      if (input.openId !== undefined) throw new ChannelProtocolError("CHANNEL_RESPONSE_INVALID");
      const result = z
        .object({ out_trade_no: MerchantOrderSchema, qr_code: z.url().max(1024) })
        .parse(
          await request("/v3/alipay/trade/precreate", {
            out_trade_no: input.merchantOrder,
            total_amount: yuan(input.amountCents),
            subject: z.string().trim().min(1).max(100).parse(input.description),
            seller_id: config.sellerId,
            notify_url: config.notifyUrl,
            timeout_express: "15m",
            qr_code_timeout_express: "15m",
          }),
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
      const payment = alipayPayment(
        await request("/v3/alipay/trade/query", { out_trade_no: merchantOrder }),
      );
      if (payment.merchantOrder !== merchantOrder)
        throw new ChannelProtocolError("CHANNEL_BINDING_MISMATCH");
      return payment;
    },
    async close(merchantOrder) {
      MerchantOrderSchema.parse(merchantOrder);
      const result = z
        .object({ out_trade_no: MerchantOrderSchema })
        .parse(await request("/v3/alipay/trade/close", { out_trade_no: merchantOrder }));
      if (result.out_trade_no !== merchantOrder)
        throw new ChannelProtocolError("CHANNEL_BINDING_MISMATCH");
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
      return alipayRefund(
        await request("/v3/alipay/trade/fastpay/refund/query", {
          out_trade_no: input.merchantOrder,
          out_request_no: input.merchantRefund,
        }),
        input,
      );
    },
    async queryRefund(input) {
      MerchantOrderSchema.parse(input.merchantOrder);
      MerchantOrderSchema.parse(input.merchantRefund);
      return alipayRefund(
        await request("/v3/alipay/trade/fastpay/refund/query", {
          out_trade_no: input.merchantOrder,
          out_request_no: input.merchantRefund,
        }),
        input,
      );
    },
    notification(response) {
      return alipayNotification(response.body, config);
    },
  });
}
