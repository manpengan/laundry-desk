import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import {
  PaymentChannelSettingsRequestSchema,
  ChannelCheckoutInputSchema,
  ChannelIntentIdSchema,
  ChannelListInputSchema,
  ChannelRefundIdSchema,
  ChannelIntentsViewSchema,
  ChannelRefundsViewSchema,
} from "@laundry/contracts";
import type { ByokKmsPort } from "../ai/byok-kms.js";
import {
  fail,
  resolveSession,
  requireCsrf,
  type AuthRouteContext,
} from "../http/auth-route-support.js";
import { createByokMutationRateLimiter } from "../http/byok-rate-limit.js";
import { safeErrorContext } from "../http/local-logger.js";
import { requesterAuthorityIsCurrent } from "../ai/byok-requester-authority.js";
import { createByokRuntime } from "../ai/byok-runtime.js";
import { createChannelSettingsService, channelTenant, ChannelBusinessError } from "./settings.js";
import { createChannelService } from "./service.js";
import { channelIntentView, insertIntent, type ChannelIntent } from "./intent-store.js";
import { createChannelRefundService } from "./refund-service.js";
import { channelRefundView, type ChannelRefundRow } from "./refund-store.js";
import { reconcileChannelBill } from "./reconciliation.js";
import { installChannelWorker } from "./worker.js";
import { registerChannelCallbacks } from "./callback-routes.js";

export function registerPaymentChannelRoutes(
  app: FastifyInstance,
  context: AuthRouteContext,
  kms: ByokKmsPort | null,
) {
  const runtime = createByokRuntime(context.runtime, kms);
  const service = createChannelService(context.runtime, kms);
  const settings = createChannelSettingsService(context.runtime, kms);
  const refunds = createChannelRefundService(context.runtime, kms);
  const limiter = createByokMutationRateLimiter({ maxAttempts: 120, windowSeconds: 60 });
  const reauthLimiter = createByokMutationRateLimiter({ maxAttempts: 5, windowSeconds: 60 });
  const paths = [
    "settings",
    "checkout",
    "status",
    "list",
    "close",
    "refunds/list",
    "refunds/status",
    "reconcile",
  ] as const;
  for (const path of paths)
    for (const method of (path === "settings" ? ["GET", "POST"] : ["POST"]) as readonly (
      "GET" | "POST"
    )[])
      app.route({
        method,
        url: `/api/v2/payment-channels/${path}`,
        bodyLimit: path === "reconcile" ? 4 * 1024 * 1024 : 32 * 1024,
        async handler(request, reply) {
          try {
            const auth = await resolveSession(context.runtime, request);
            if (auth === null) {
              reply.code(401);
              return fail("AUTHENTICATION_FAILED");
            }
            if (auth.authority.role !== "admin") {
              reply.code(403);
              return fail("PERMISSION_DENIED");
            }
            const rate = (
              path === "settings" && method === "POST" ? reauthLimiter : limiter
            ).consume(auth.session.staff_id);
            if (!rate.allowed) {
              reply.code(429).header("Retry-After", String(rate.retryAfterSeconds));
              return fail("RATE_LIMITED");
            }
            if (method === "POST") {
              const csrf = await requireCsrf(context, request, reply, auth.session);
              if (csrf !== true) return csrf;
            }
            const tenant = channelTenant(auth);
            let data: unknown;
            if (path === "settings")
              data =
                method === "GET"
                  ? await settings.read(auth)
                  : await settings.save(
                      auth,
                      PaymentChannelSettingsRequestSchema.parse(request.body),
                    );
            else if (path === "checkout") {
              const input = ChannelCheckoutInputSchema.parse(request.body);
              const intent = await runtime.transact(tenant, async (tx) => {
                if (!(await requesterAuthorityIsCurrent(runtime, auth, tx)))
                  throw new ChannelBusinessError("POLICY_DENIED");
                return insertIntent(tx.client, tenant, {
                  idempotencyKey: input.idempotency_key,
                  channel: input.channel,
                  purpose: "order",
                  orderId: input.order_id,
                  accountId: null,
                  customerId: null,
                });
              });
              data = channelIntentView(await service.dispatch(tenant, intent.id));
            } else if (path === "status" || path === "close") {
              const input = ChannelIntentIdSchema.parse(request.body);
              data = channelIntentView(
                await (path === "close"
                  ? service.close(tenant, input.intent_id)
                  : service.sync(tenant, input.intent_id)),
              );
            } else if (path === "refunds/status") {
              const input = ChannelRefundIdSchema.parse(request.body);
              const row = await refunds.advance(tenant, input.refund_id);
              if (row === null) throw new ChannelBusinessError("RESOURCE_UNAVAILABLE");
              data = channelRefundView(row);
            } else if (path === "reconcile")
              data = await runtime.transact(tenant, async (tx) => {
                if (!(await requesterAuthorityIsCurrent(runtime, auth, tx)))
                  throw new ChannelBusinessError("POLICY_DENIED");
                return reconcileChannelBill(tx.client, tenant, request.body);
              });
            else {
              const input = ChannelListInputSchema.parse(request.body);
              data = await runtime.transact(tenant, async ({ client }) =>
                path === "list"
                  ? ChannelIntentsViewSchema.parse({
                      intents: (
                        await client.query<ChannelIntent>(
                          `SELECT * FROM payment_channel_intents WHERE org_id=$1::uuid AND store_id=$2::uuid AND ($3::uuid IS NULL OR order_id=$3::uuid) ORDER BY created_at DESC,id DESC LIMIT 100`,
                          [tenant.orgId, tenant.storeId, input.order_id ?? null],
                        )
                      ).rows.map(channelIntentView),
                    })
                  : ChannelRefundsViewSchema.parse({
                      refunds: (
                        await client.query<ChannelRefundRow>(
                          `SELECT r.* FROM payment_channel_refunds r JOIN payment_channel_intents i ON i.org_id=r.org_id AND i.store_id=r.store_id AND i.id=r.intent_id WHERE r.org_id=$1::uuid AND r.store_id=$2::uuid AND ($3::uuid IS NULL OR i.order_id=$3::uuid) ORDER BY r.created_at DESC,r.id DESC LIMIT 100`,
                          [tenant.orgId, tenant.storeId, input.order_id ?? null],
                        )
                      ).rows.map(channelRefundView),
                    }),
              );
            }
            return { ok: true, data };
          } catch (error) {
            if (error instanceof ZodError) {
              reply.code(400);
              return fail("VALIDATION_FAILED");
            }
            if (error instanceof ChannelBusinessError) {
              reply.code(error.code === "POLICY_DENIED" ? 403 : 409);
              return fail(error.code);
            }
            request.log.error(safeErrorContext(error), "Payment channel operation failed");
            reply.code(500);
            return fail("TRANSACTION_FAILED");
          }
        },
      });
  if (context.runtime.pool !== null && kms !== null) {
    installChannelWorker(app, context.runtime, kms);
    registerChannelCallbacks(app, context.runtime, kms);
  }
}
