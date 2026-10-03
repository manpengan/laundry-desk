import {
  CustomerPortalOrdersListResultSchema,
  CustomerPortalOrderGetResultSchema,
  CustomerPortalGarmentsListResultSchema,
  CustomerPortalGarmentProgressResultSchema,
  CustomerPortalReceiptResultSchema,
  CustomerPortalWalletResultSchema,
  CustomerPortalBenefitsResultSchema,
  CustomerPortalProfileResultSchema,
  MiniappPublicSchema as PublicSchema,
  MiniappSessionSchema as SessionSchema,
} from "@laundry/contracts";
import { z } from "zod";
import type { MiniappConfig } from "./config.js";
import { loginCode, type WxPort } from "./wx-port.js";

const Envelope = z.object({ ok: z.literal(true), data: z.unknown() });
const querySchemas = {
  "customer.self_service.orders.list": CustomerPortalOrdersListResultSchema,
  "customer.self_service.order.get": CustomerPortalOrderGetResultSchema,
  "customer.self_service.garments.list": CustomerPortalGarmentsListResultSchema,
  "customer.self_service.garment.progress": CustomerPortalGarmentProgressResultSchema,
  "customer.self_service.receipt.get": CustomerPortalReceiptResultSchema,
  "customer.self_service.wallet.get": CustomerPortalWalletResultSchema,
  "customer.self_service.benefits.get": CustomerPortalBenefitsResultSchema,
  "customer.self_service.profile.get": CustomerPortalProfileResultSchema,
} as const;
type QueryName = keyof typeof querySchemas;
type Session = Extract<z.infer<typeof SessionSchema>, { authenticated: true }>;
export type MiniappPublic = z.infer<typeof PublicSchema>;

export function createMiniappClient(wx: WxPort, config: MiniappConfig, now = Date.now) {
  let session: Session | null = null;
  let generation = 0;
  let pending = new Set<Readonly<{ abort(): void }>>();
  const clear = () => {
    session = null;
    generation += 1;
    const previous = pending;
    pending = new Set();
    for (const task of previous) task.abort();
  };
  const request = <T>(
    path: string,
    body: unknown,
    schema: z.ZodType<T>,
    auth = true,
    method: "GET" | "POST" = "POST",
  ): Promise<T> => {
    if (auth && (session === null || session.expires_at * 1000 <= now())) {
      clear();
      return Promise.reject(new Error("登录已过期，请重新登录"));
    }
    const current = generation;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = () => {
        settled = true;
        // Native callbacks are asynchronous; deferral also handles synchronous test adapters.
        void Promise.resolve().then(() => pending.delete(task));
      };
      const task = wx.request({
        url: `${config.apiOrigin}/api/v2/miniapp/${path}`,
        method,
        timeout: 15_000,
        header: {
          "content-type": "application/json",
          ...(auth && session ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        ...(method === "POST" ? { data: body } : {}),
        success: (response) => {
          if (settled) return;
          finish();
          if (current !== generation) {
            reject(new Error("会话已结束"));
            return;
          }
          if (response.statusCode === 401) {
            clear();
            reject(new Error("登录已过期，请重新登录"));
            return;
          }
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(
              new Error(
                response.statusCode === 429
                  ? "操作过于频繁，请稍后重试"
                  : "操作未完成，请刷新确认后重试",
              ),
            );
            return;
          }
          const envelope = Envelope.safeParse(response.data);
          const data = schema.safeParse(envelope.success ? envelope.data.data : undefined);
          if (!envelope.success || !data.success) {
            reject(new Error("服务返回异常，请稍后重试"));
            return;
          }
          resolve(data.data);
        },
        fail: () => {
          if (settled) return;
          finish();
          reject(
            new Error(current === generation ? "网络连接失败，请刷新确认处理结果" : "会话已结束"),
          );
        },
      });
      pending.add(task);
    });
  };
  return Object.freeze({
    clear,
    authorityEpoch: () => generation,
    isAuthenticated: () => session !== null && session.expires_at * 1000 > now(),
    async public() {
      const value = await request("public", undefined, PublicSchema, false, "GET");
      if (value.app_id !== wx.getAccountInfoSync().miniProgram.appId)
        throw new Error("门店小程序配置不匹配，请联系门店");
      return value;
    },
    async login(phoneCode?: string) {
      clear();
      const current = generation;
      if (phoneCode !== undefined && !/^[\w-]{1,512}$/u.test(phoneCode))
        throw new Error("手机号授权未完成");
      const code = await loginCode(wx);
      if (generation !== current) throw new Error("会话已结束");
      const data = await request(
        "auth/login",
        { code, ...(phoneCode ? { phone_code: phoneCode } : {}) },
        SessionSchema,
        false,
      );
      if (generation !== current) throw new Error("会话已结束");
      if ("authenticated" in data) {
        if (data.expires_at * 1000 <= now() || data.expires_at * 1000 > now() + 16 * 60_000)
          throw new Error("登录有效期异常，请重试");
        session = data;
      }
      return "authenticated" in data;
    },
    async logout() {
      try {
        await request("auth/logout", {}, z.strictObject({ logged_out: z.literal(true) }));
      } finally {
        clear();
      }
    },
    async query<Name extends QueryName>(name: Name, input: Readonly<Record<string, unknown>>) {
      const result = await request(
        "query",
        { name, input },
        z.strictObject({ execution: z.literal("executed"), result: z.unknown() }),
      );
      return querySchemas[name].parse(result.result) as z.output<(typeof querySchemas)[Name]>;
    },
    // Only fixed functions in transaction-client.ts may choose the path/schema.
    transaction: request,
  });
}
export type MiniappClient = ReturnType<typeof createMiniappClient>;
