import type { FastifyInstance } from "fastify";
import { z, ZodError } from "zod";
import {
  MINIAPP_TRANSACTION_SCHEMAS,
  MiniappPublicSchema,
  type MiniappTransactionAction,
} from "@laundry/contracts";
import type { ByokKmsPort } from "../ai/byok-kms.js";
import { HandlerCommandError } from "../bus/types.js";
import {
  fail,
  resolveSession,
  requireCsrf,
  type AuthRouteContext,
} from "../http/auth-route-support.js";
import { createByokMutationRateLimiter } from "../http/byok-rate-limit.js";
import { trustedClientSource } from "../http/request-security.js";
import { isConfiguredRuntimeTenant } from "../http/runtime-surface-policy.js";
import { createMiniappIdentityService } from "./identity.js";
import { createMiniappSettingsService } from "./settings.js";
import { createMiniappService } from "./service.js";
import { MiniappError, readMiniappSettings } from "./types.js";
import type { WechatLoginPort } from "./wechat.js";

export function registerMiniappRoutes(
  app: FastifyInstance,
  context: AuthRouteContext,
  kms: ByokKmsPort | null,
  provider?: WechatLoginPort,
) {
  const identity = createMiniappIdentityService(context.runtime, kms, provider);
  const service = createMiniappService(context.runtime, kms, identity),
    settings = createMiniappSettingsService(context.runtime, kms);
  const limiter = createByokMutationRateLimiter({ maxAttempts: 120, windowSeconds: 60 }),
    loginLimiter = createByokMutationRateLimiter({ maxAttempts: 10, windowSeconds: 60 });
  app.addHook("onClose", async () => identity.clear());
  const routes = [
    { method: "GET" as const, path: "public" },
    { method: "GET" as const, path: "settings" },
    { method: "POST" as const, path: "settings" },
    ...[
      "auth/login",
      "auth/logout",
      "query",
      "subscriptions",
      ...Object.keys(MINIAPP_TRANSACTION_SCHEMAS).map((action) => `transactions/${action}`),
    ].map((path) => ({ method: "POST" as const, path })),
  ];
  for (const { method, path } of routes)
    app.route({
      method,
      url: `/api/v2/miniapp/${path}`,
      bodyLimit: 32 * 1024,
      async handler(request, reply) {
        reply.header("Cache-Control", "no-store");
        try {
          const source = trustedClientSource(request, context.requestSecurity);
          if (source === null) throw new MiniappError("AUTHENTICATION_FAILED");
          const rate = (
            path === "auth/login" || (path === "settings" && method === "POST")
              ? loginLimiter
              : limiter
          ).consume(source);
          if (!rate.allowed) {
            reply.code(429).header("Retry-After", String(rate.retryAfterSeconds));
            return fail("RATE_LIMITED");
          }
          let data: unknown;
          if (path === "settings") {
            const auth = await resolveSession(context.runtime, request);
            if (auth === null) throw new MiniappError("AUTHENTICATION_FAILED");
            if (auth.authority.role !== "admin" || !isConfiguredRuntimeTenant(auth))
              throw new MiniappError("PERMISSION_DENIED");
            if (method === "POST") {
              const csrf = await requireCsrf(context, request, reply, auth.session);
              if (csrf !== true) return csrf;
            }
            data =
              method === "GET" ? await settings.read() : await settings.save(auth, request.body);
          } else if (path === "public")
            data = await identity.transaction(async ({ client, tenant }) => {
              const config = await readMiniappSettings(client);
              if (config === null || !config.enabled)
                throw new MiniappError("RESOURCE_UNAVAILABLE");
              const store = (
                await client.query<{ name: string }>(
                  `SELECT name FROM stores WHERE org_id=$1::uuid AND id=$2::uuid`,
                  [tenant.orgId, tenant.storeId],
                )
              ).rows[0];
              return MiniappPublicSchema.parse({
                store_name: store?.name,
                app_id: config.app_id,
                subscription_template_ids: config.subscription_template_ids,
              });
            });
          else if (path === "auth/login") data = await identity.login(request.body);
          else {
            const bearer = request.headers.authorization;
            if (typeof bearer !== "string" || !/^Bearer m1\.[A-Za-z0-9_-]{43}$/u.test(bearer))
              throw new MiniappError("AUTHENTICATION_FAILED");
            const token = bearer.slice(7);
            if (path === "auth/logout") {
              z.strictObject({}).parse(request.body);
              data = await identity.logout(token);
            } else if (path === "query") data = await service.query(token, request.body);
            else if (path === "subscriptions") data = await service.subscribe(token, request.body);
            else
              data = await service.transaction(
                token,
                path.slice("transactions/".length) as MiniappTransactionAction,
                request.body,
              );
          }
          return { ok: true, data };
        } catch (error) {
          if (error instanceof ZodError) {
            reply.code(400);
            return fail("VALIDATION_FAILED");
          }
          if (error instanceof MiniappError) {
            reply.code(
              error.code === "AUTHENTICATION_FAILED"
                ? 401
                : error.code === "PERMISSION_DENIED" || error.code === "POLICY_DENIED"
                  ? 403
                  : 409,
            );
            return fail(error.code);
          }
          if (error instanceof HandlerCommandError) {
            reply.code(409);
            return { ok: false, error: error.commandError };
          }
          request.log.error({ code: "MINIAPP_OPERATION_FAILED" }, "Miniapp operation failed");
          reply.code(500);
          return fail("TRANSACTION_FAILED");
        }
      },
    });
}
