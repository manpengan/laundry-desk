import { z } from "zod";
import { channelHttp } from "./http.js";
import {
  channelClock,
  header,
  parseChannelJson,
  parseProviderResponse,
  providerErrorCode,
  requireRsaKey,
  rsaSign,
  rsaVerify,
  shanghaiTimestamp,
  verifiedTimestamp,
} from "./protocol.js";
import { wechatNotification, wechatPayment, wechatRefund } from "./wechat-projections.js";
import {
  ChannelCentsSchema,
  ChannelProtocolError,
  MerchantOrderSchema,
  WechatCredentialSchema,
  type ChannelAdapter,
  type ChannelClock,
  type ChannelHttp,
  type ChannelHttpResponse,
  type WechatCredential,
} from "./types.js";

/** WeChat answers for an order/refund that does not exist at all. */
const NOT_FOUND = new Set(["ORDER_NOT_EXIST", "RESOURCE_NOT_EXISTS"]);

export function verifyWechatResponse(
  response: ChannelHttpResponse,
  config: WechatCredential,
  clock: ChannelClock,
): void {
  if (header(response, "wechatpay-serial") !== config.platformKeyId)
    throw new ChannelProtocolError("CHANNEL_SIGNATURE_INVALID");
  const timestamp = header(response, "wechatpay-timestamp");
  const nonce = header(response, "wechatpay-nonce");
  verifiedTimestamp(timestamp, clock.nowMs(), "seconds");
  rsaVerify(
    `${timestamp}\n${nonce}\n${response.body}\n`,
    header(response, "wechatpay-signature"),
    config.platformPublicKey,
  );
}

function verified(response: ChannelHttpResponse, config: WechatCredential, clock: ChannelClock) {
  try {
    verifyWechatResponse(response, config, clock);
    return true;
  } catch {
    return false;
  }
}

/**
 * Success must be signed. A signed 4xx is a definitive rejection; 401 is the one
 * unsigned answer accepted as definitive, because WeChat cannot sign for a merchant
 * whose request it failed to authenticate. Everything else leaves the result unknown.
 */
function classifyWechat(
  response: ChannelHttpResponse,
  config: WechatCredential,
  clock: ChannelClock,
): void {
  const signed = verified(response, config, clock);
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

/** Merchant direct mode, API v3 public-key verification; no auto certificate download. */
export function createWechatAdapter(
  raw: WechatCredential,
  http: ChannelHttp = channelHttp,
  clock: ChannelClock = channelClock,
): ChannelAdapter {
  const config = WechatCredentialSchema.parse(raw);
  requireRsaKey(config.privateKey, "private");
  requireRsaKey(config.platformPublicKey, "public");
  const request = async (
    method: "GET" | "POST",
    path: string,
    value?: unknown,
  ): Promise<unknown> => {
    const body = value === undefined ? "" : JSON.stringify(value);
    const timestamp = String(Math.floor(clock.nowMs() / 1000));
    const nonce = clock.nonce();
    const signature = rsaSign(
      `${method}\n${path}\n${timestamp}\n${nonce}\n${body}\n`,
      config.privateKey,
    );
    const response = await http({
      channel: "wechat",
      method,
      path,
      body,
      headers: {
        "Content-Type": "application/json",
        "Wechatpay-Serial": config.platformKeyId,
        Authorization: `WECHATPAY2-SHA256-RSA2048 mchid="${config.merchantId}",nonce_str="${nonce}",timestamp="${timestamp}",serial_no="${config.merchantSerial}",signature="${signature}"`,
      },
    });
    classifyWechat(response, config, clock);
    return response.body === "" ? null : parseChannelJson(response.body);
  };
  return Object.freeze({
    async checkout(input) {
      MerchantOrderSchema.parse(input.merchantOrder);
      ChannelCentsSchema.parse(input.amountCents);
      const jsapi = input.openId !== undefined;
      if (jsapi)
        z.string()
          .regex(/^[A-Za-z0-9_-]{20,128}$/u)
          .parse(input.openId);
      const result = await request("POST", `/v3/pay/transactions/${jsapi ? "jsapi" : "native"}`, {
        appid: config.appId,
        mchid: config.merchantId,
        description: z.string().min(1).max(100).parse(input.description),
        out_trade_no: input.merchantOrder,
        time_expire: shanghaiTimestamp(input.expiresAt),
        notify_url: config.notifyUrl,
        amount: { total: input.amountCents, currency: "CNY" },
        ...(jsapi ? { payer: { openid: input.openId } } : {}),
      });
      if (!jsapi) {
        const value = parseProviderResponse(
          () =>
            z
              .object({
                code_url: z
                  .string()
                  .regex(/^weixin:\/\/wxpay\/bizpayurl\?[A-Za-z0-9=&_-]+$/u)
                  .max(1024),
              })
              .parse(result).code_url,
        );
        return Object.freeze({ kind: "qr" as const, value });
      }
      const prepay = parseProviderResponse(
        () =>
          z.object({ prepay_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u) }).parse(result)
            .prepay_id,
      );
      const timeStamp = String(Math.floor(clock.nowMs() / 1000));
      const nonceStr = clock.nonce();
      const packageValue = `prepay_id=${prepay}`;
      return Object.freeze({
        kind: "jsapi" as const,
        appId: config.appId,
        timeStamp,
        nonceStr,
        package: packageValue,
        signType: "RSA" as const,
        paySign: rsaSign(
          `${config.appId}\n${timeStamp}\n${nonceStr}\n${packageValue}\n`,
          config.privateKey,
        ),
      });
    },
    async query(merchantOrder) {
      MerchantOrderSchema.parse(merchantOrder);
      const value = await request(
        "GET",
        `/v3/pay/transactions/out-trade-no/${merchantOrder}?mchid=${config.merchantId}`,
      );
      const payment = parseProviderResponse(() => wechatPayment(value, config));
      if (payment.merchantOrder !== merchantOrder)
        throw new ChannelProtocolError("CHANNEL_BINDING_MISMATCH");
      return payment;
    },
    async close(merchantOrder) {
      MerchantOrderSchema.parse(merchantOrder);
      await request("POST", `/v3/pay/transactions/out-trade-no/${merchantOrder}/close`, {
        mchid: config.merchantId,
      });
      return Object.freeze({ outcome: "closed" as const });
    },
    async refund(input) {
      MerchantOrderSchema.parse(input.merchantOrder);
      MerchantOrderSchema.parse(input.merchantRefund);
      ChannelCentsSchema.parse(input.amountCents);
      ChannelCentsSchema.parse(input.originalCents);
      if (input.amountCents > input.originalCents)
        throw new ChannelProtocolError("CHANNEL_BINDING_MISMATCH");
      const value = await request("POST", "/v3/refund/domestic/refunds", {
        out_trade_no: input.merchantOrder,
        out_refund_no: input.merchantRefund,
        reason: z.string().trim().min(1).max(80).parse(input.reason),
        notify_url: config.notifyUrl,
        amount: { refund: input.amountCents, total: input.originalCents, currency: "CNY" },
      });
      return parseProviderResponse(() => wechatRefund(value, input));
    },
    async queryRefund(input) {
      MerchantOrderSchema.parse(input.merchantRefund);
      const value = await request("GET", `/v3/refund/domestic/refunds/${input.merchantRefund}`);
      return parseProviderResponse(() => wechatRefund(value, input));
    },
    notification(response) {
      verifyWechatResponse(response, config, clock);
      return wechatNotification(response.body, config);
    },
  });
}
