import { z } from "zod";
import {
  createPinnedProviderHttp,
  readProviderJson,
  type ProviderHttpPort,
} from "../ai/provider-http.js";
import { WechatNotificationPayloadSchema, type WechatNotificationConfig } from "@laundry/contracts";
export type WechatNotificationPort = Readonly<{
  token(credential: Readonly<{ appId: string; secret: string }>): Promise<string>;
  send(
    token: string,
    openId: string,
    config: WechatNotificationConfig,
    payload: unknown,
  ): Promise<Readonly<{ state: "accepted" | "failed" | "unknown"; errorCode: string | null }>>;
}>;
export function createWechatNotificationPort(
  http: ProviderHttpPort = createPinnedProviderHttp(["api.weixin.qq.com"]),
): WechatNotificationPort {
  const request = async (path: string, body: unknown, token?: string) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const url = new URL(path, "https://api.weixin.qq.com");
    if (token !== undefined) url.searchParams.set("access_token", token);
    try {
      const response = await http.request({
        url: url.href,
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
        timeoutMs: 10_000,
      });
      if (response.status !== 200) throw new Error("WECHAT_RESPONSE_UNKNOWN");
      return await readProviderJson(response, 32 * 1024);
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  };
  return Object.freeze({
    async token(credential) {
      try {
        return z
          .object({
            access_token: z.string().min(1).max(2048),
            expires_in: z.number().int().positive(),
          })
          .parse(
            await request("/cgi-bin/stable_token", {
              grant_type: "client_credential",
              appid: credential.appId,
              secret: credential.secret,
              force_refresh: false,
            }),
          ).access_token;
      } catch {
        throw new Error("WECHAT_TOKEN_UNAVAILABLE");
      }
    },
    async send(token, openId, config, raw) {
      const payload = WechatNotificationPayloadSchema.parse(raw);
      z.string()
        .regex(/^[A-Za-z0-9_-]{16,128}$/u)
        .parse(openId);
      try {
        const result = z.object({ errcode: z.number().int() }).parse(
          await request(
            "/cgi-bin/message/subscribe/send",
            {
              touser: openId,
              template_id: config.template_id,
              page: "pages/home/index",
              miniprogram_state: config.miniprogram_state,
              lang: "zh_CN",
              data: {
                [config.ticket_field]: { value: payload.ticket },
                [config.store_field]: { value: payload.store },
                [config.status_field]: { value: payload.status },
              },
            },
            token,
          ),
        );
        return result.errcode === 0
          ? { state: "accepted", errorCode: null }
          : { state: "failed", errorCode: `WECHAT_REJECTED_${result.errcode}` };
      } catch {
        return { state: "unknown", errorCode: "WECHAT_SEND_UNKNOWN" };
      }
    },
  });
}
