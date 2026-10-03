import { generateKeyPairSync, sign } from "node:crypto";
import type {
  AlipayCredential,
  ChannelClock,
  ChannelHttpResponse,
  PaymentChannel,
  WechatCredential,
} from "./types.js";

/** Synthetic keys only; this helper is used by protocol and PG acceptance fixtures. */
export function channelFixture() {
  const keys = () =>
    generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
  const merchant = keys();
  const platform = keys();
  const now = Date.parse("2026-10-03T00:00:00Z");
  const clock: ChannelClock = { nowMs: () => now, nonce: () => "synthetic_nonce_20261003" };
  const wechat: WechatCredential = {
    channel: "wechat",
    appId: "wx1234567890abcdef",
    merchantId: "1234567890",
    merchantSerial: "1234567890ABCDEF1234567890ABCDEF",
    privateKey: merchant.privateKey,
    platformKeyId: "PUB_KEY_ID_1234567890123456",
    platformPublicKey: platform.publicKey,
    apiV3Key: "synthetic-fixture-key".padEnd(32, "0"),
    notifyUrl: "https://example.invalid/wechat",
  };
  const alipay: AlipayCredential = {
    channel: "alipay",
    appId: "2026100300000001",
    sellerId: "2088100300000001",
    privateKey: merchant.privateKey,
    platformPublicKey: platform.publicKey,
    notifyUrl: "https://example.invalid/alipay",
  };
  const response = (channel: PaymentChannel, value: unknown, status = 200): ChannelHttpResponse => {
    const body = value === null ? "" : JSON.stringify(value);
    const timestamp = String(channel === "wechat" ? now / 1000 : now);
    const nonce = "synthetic_response_nonce";
    const signature = sign(
      "RSA-SHA256",
      Buffer.from(`${timestamp}\n${nonce}\n${body}\n`),
      platform.privateKey,
    ).toString("base64");
    const prefix = channel === "wechat" ? "wechatpay" : "alipay";
    return {
      status,
      body,
      headers: {
        [`${prefix}-timestamp`]: timestamp,
        [`${prefix}-nonce`]: nonce,
        [`${prefix}-signature`]: signature,
        ...(channel === "wechat" ? { "wechatpay-serial": wechat.platformKeyId } : {}),
      },
    };
  };
  return { now, clock, merchant, platform, wechat, alipay, response };
}
