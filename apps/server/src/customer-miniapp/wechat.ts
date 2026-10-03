import { z } from "zod";
import {
  createPinnedProviderHttp,
  readProviderJson,
  type ProviderHttpPort,
} from "../ai/provider-http.js";
import { MiniappError } from "./types.js";

const Code = z.string().min(1).max(256);
const OpenId = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/u);
const Credentials = z.strictObject({
  appId: z.string().regex(/^wx[A-Za-z0-9]{16}$/u),
  secret: z.string().regex(/^[A-Za-z0-9_-]{16,256}$/u),
});
export type WechatLoginPort = Readonly<{
  identity(credential: z.infer<typeof Credentials>, code: string): Promise<string>;
  phone(credential: z.infer<typeof Credentials>, code: string): Promise<string>;
}>;

/** Only fixed WeChat endpoints; credentials and session_key never leave this adapter. */
export function createWechatLoginPort(
  http: ProviderHttpPort = createPinnedProviderHttp(["api.weixin.qq.com"]),
): WechatLoginPort {
  const request = async (
    path: string,
    query: Readonly<Record<string, string>>,
    body?: unknown,
  ): Promise<unknown> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const url = new URL(path, "https://api.weixin.qq.com");
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    try {
      const response = await http.request({
        url: url.href,
        method: body === undefined ? "GET" : "POST",
        headers: {
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
        timeoutMs: 10_000,
      });
      const result = await readProviderJson(response, 32 * 1024);
      const status = z.object({ errcode: z.number().int().optional() }).parse(result);
      if (status.errcode !== undefined && status.errcode !== 0)
        throw new MiniappError("AUTHENTICATION_FAILED");
      return result;
    } catch {
      throw new MiniappError("AUTHENTICATION_FAILED");
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  };
  return Object.freeze({
    async identity(raw, code) {
      const credential = Credentials.parse(raw);
      const result = await request("/sns/jscode2session", {
        appid: credential.appId,
        secret: credential.secret,
        js_code: Code.parse(code),
        grant_type: "authorization_code",
      });
      return z.object({ openid: OpenId, session_key: z.string().min(1).max(256) }).parse(result)
        .openid;
    },
    async phone(raw, code) {
      const credential = Credentials.parse(raw);
      const token = z
        .object({
          access_token: z.string().min(1).max(2048),
          expires_in: z.number().int().positive(),
        })
        .parse(
          await request(
            "/cgi-bin/stable_token",
            {},
            {
              grant_type: "client_credential",
              appid: credential.appId,
              secret: credential.secret,
              force_refresh: false,
            },
          ),
        );
      const result = z
        .object({
          phone_info: z.object({
            purePhoneNumber: z.string().regex(/^1[3-9][0-9]{9}$/u),
            countryCode: z.literal("86"),
            watermark: z.object({
              appid: z.literal(credential.appId),
              timestamp: z.number().int().positive(),
            }),
          }),
        })
        .parse(
          await request(
            "/wxa/business/getuserphonenumber",
            { access_token: token.access_token },
            { code: Code.parse(code) },
          ),
        );
      const age = Math.floor(Date.now() / 1000) - result.phone_info.watermark.timestamp;
      if (age < -60 || age > 300) throw new MiniappError("AUTHENTICATION_FAILED");
      return result.phone_info.purePhoneNumber;
    },
  });
}
