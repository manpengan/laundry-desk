import type { FastifyInstance } from "fastify";
import type { ByokKmsPort } from "../ai/byok-kms.js";
import { createByokRuntime } from "../ai/byok-runtime.js";
import type { LocalRuntime } from "../local/runtime-types.js";
import { LOCAL_PROFILE } from "../local/profile.js";
import { createByokMutationRateLimiter } from "../http/byok-rate-limit.js";
import { safeErrorContext } from "../http/local-logger.js";
import { readChannelSettings, channelAdapter, ChannelBusinessError } from "./settings.js";
import { settleChannelPayment } from "./settlement.js";
import { settleChannelRefund } from "./refund-settlement.js";
export function registerChannelCallbacks(
  app: FastifyInstance,
  local: LocalRuntime,
  kms: ByokKmsPort,
) {
  const runtime = createByokRuntime(local, kms);
  const tenant = {
    orgId: LOCAL_PROFILE.orgId,
    storeId: LOCAL_PROFILE.storeId,
    staffId: LOCAL_PROFILE.adminStaffId,
  };
  const limiter = createByokMutationRateLimiter({ maxAttempts: 120, windowSeconds: 60 });
  void app.register(async (callback) => {
    callback.removeContentTypeParser("application/json");
    callback.addContentTypeParser(
      ["application/json", "application/x-www-form-urlencoded"],
      { parseAs: "buffer" },
      (_request, body, done) => {
        try {
          if (typeof body === "string") return done(new Error("CHANNEL_BODY_INVALID"));
          done(null, new TextDecoder("utf-8", { fatal: true }).decode(body));
        } catch {
          done(new Error("CHANNEL_BODY_INVALID"));
        }
      },
    );
    for (const channel of ["wechat", "alipay"] as const)
      callback.post(
        `/api/v2/payment-channels/callback/${channel}`,
        { bodyLimit: 65536 },
        async (request, reply) => {
          const rate = limiter.consume(request.ip);
          if (!rate.allowed) {
            reply.code(429);
            return channel === "wechat" ? { code: "FAIL", message: "retry later" } : "failure";
          }
          if (
            request.headers.cookie !== undefined ||
            request.headers.authorization !== undefined ||
            request.headers.origin !== undefined ||
            typeof request.body !== "string"
          ) {
            reply.code(400);
            return channel === "wechat" ? { code: "FAIL", message: "invalid request" } : "failure";
          }
          try {
            const rawBody = request.body;
            const headers = Object.fromEntries(
              Object.entries(request.headers).filter(
                (entry): entry is [string, string] => typeof entry[1] === "string",
              ),
            );
            await runtime.transact(tenant, async ({ client }) => {
              const settings = await readChannelSettings(client, tenant, channel);
              if (settings === null) throw new ChannelBusinessError("RESOURCE_UNAVAILABLE");
              const adapter = await channelAdapter(kms, tenant, settings);
              const notice = adapter.notification({ status: 200, headers, body: rawBody });
              if (notice.kind === "payment") {
                const row = (
                  await client.query<{ id: string }>(
                    `SELECT id FROM payment_channel_intents WHERE org_id=$1::uuid AND store_id=$2::uuid AND channel=$3 AND merchant_order=$4 AND account_fingerprint=$5`,
                    [
                      tenant.orgId,
                      tenant.storeId,
                      channel,
                      notice.payment.merchantOrder,
                      settings.account_fingerprint,
                    ],
                  )
                ).rows[0];
                if (row === undefined) throw new ChannelBusinessError("RESOURCE_UNAVAILABLE");
                await settleChannelPayment(client, tenant, local, row.id, notice.payment);
              } else {
                const row = (
                  await client.query<{ id: string }>(
                    `SELECT r.id FROM payment_channel_refunds r JOIN payment_channel_intents i ON i.org_id=r.org_id AND i.store_id=r.store_id AND i.id=r.intent_id WHERE r.org_id=$1::uuid AND r.store_id=$2::uuid AND i.channel=$3 AND r.merchant_refund=$4 AND i.account_fingerprint=$5`,
                    [
                      tenant.orgId,
                      tenant.storeId,
                      channel,
                      notice.refund.merchantRefund,
                      settings.account_fingerprint,
                    ],
                  )
                ).rows[0];
                if (row === undefined) throw new ChannelBusinessError("RESOURCE_UNAVAILABLE");
                await settleChannelRefund(client, tenant, local, row.id, notice.refund);
              }
            });
            if (channel === "wechat") {
              reply.code(204);
              return null;
            }
            return "success";
          } catch (error) {
            request.log.warn(safeErrorContext(error), "Payment callback verification failed");
            reply.code(400);
            return channel === "wechat"
              ? { code: "FAIL", message: "verification failed" }
              : "failure";
          }
        },
      );
  });
}
