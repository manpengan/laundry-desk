import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import {
  PaymentChannelSettingsRequestSchema,
  ChannelAvailabilityViewSchema,
  ChannelCheckoutInputSchema,
  ChannelIntentIdSchema,
  ChannelListInputSchema,
  ChannelRefundIdSchema,
  ChannelResolveInputSchema,
  ChannelIntentsViewSchema,
  ChannelRefundsViewSchema,
} from "@laundry/contracts";
import type { ByokKmsPort } from "../ai/byok-kms.js";
import type { AuthorizedSession } from "../auth/session-view.js";
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
import { permissionsForAuthority } from "../bus/runtime.js";
import type { TenantContext } from "../db/types.js";
import {
  createChannelSettingsService,
  channelTenant,
  ChannelBusinessError,
  assertAdminPassword,
} from "./settings.js";
import { createChannelService } from "./service.js";
import { channelIntentView, insertIntent, type ChannelIntent } from "./intent-store.js";
import { createChannelRefundService } from "./refund-service.js";
import { channelRefundView, type ChannelRefundRow } from "./refund-store.js";
import { reconcileChannelBill } from "./reconciliation.js";
import {
  listReconciliations,
  readReconciliation,
  reviewReconciliation,
} from "./reconciliation-history.js";
import { installChannelWorker } from "./worker.js";
import { registerChannelCallbacks } from "./callback-routes.js";

type Path =
  | "settings"
  | "available"
  | "checkout"
  | "status"
  | "list"
  | "close"
  | "refunds/list"
  | "refunds/status"
  | "reconcile"
  | "reconcile/history"
  | "reconcile/detail"
  | "reconcile/review"
  | "resolve";
/** Collecting by code is counter work, like cash: it follows order_write (ADR-85 r1). */
const COLLECTOR_PATHS: ReadonlySet<Path> = new Set([
  "available",
  "checkout",
  "status",
  "list",
  "close",
]);
const GET_PATHS: ReadonlySet<Path> = new Set(["settings", "available"]);

const isAdmin = (auth: AuthorizedSession) => auth.authority.role === "admin";
const mayCollect = (auth: AuthorizedSession) =>
  permissionsForAuthority(auth.authority).includes("order_write");

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
  const handle = async (
    path: Path,
    auth: AuthorizedSession,
    tenant: TenantContext,
    body: unknown,
    method: "GET" | "POST",
  ) => {
    if (path === "settings")
      return method === "GET"
        ? settings.read(auth)
        : settings.save(auth, PaymentChannelSettingsRequestSchema.parse(body));
    if (path === "available")
      return runtime.transact(tenant, async ({ client }) =>
        ChannelAvailabilityViewSchema.parse({
          channels: (
            await client.query<{ channel: "wechat" | "alipay"; enabled: boolean }>(
              `SELECT channel,enabled FROM payment_channel_settings WHERE org_id=$1::uuid AND store_id=$2::uuid ORDER BY channel`,
              [tenant.orgId, tenant.storeId],
            )
          ).rows,
          can_manage: isAdmin(auth),
        }),
      );
    if (path === "checkout") {
      const input = ChannelCheckoutInputSchema.parse(body);
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
      return channelIntentView(await service.dispatch(tenant, intent.id));
    }
    if (path === "status" || path === "close") {
      const input = ChannelIntentIdSchema.parse(body);
      const current = await service.read(tenant, input.intent_id);
      // Counter staff act on order collections only; top-ups stay with administrators.
      if (!isAdmin(auth) && current.purpose !== "order")
        throw new ChannelBusinessError("POLICY_DENIED");
      return channelIntentView(
        await (path === "close"
          ? service.close(tenant, input.intent_id)
          : service.sync(tenant, input.intent_id)),
      );
    }
    if (path === "resolve") {
      const input = ChannelResolveInputSchema.parse(body);
      await runtime.transact(tenant, async (tx) => {
        if (!(await requesterAuthorityIsCurrent(runtime, auth, tx)))
          throw new ChannelBusinessError("POLICY_DENIED");
        await assertAdminPassword(context.runtime, auth, tx.client, tenant, input.password);
      });
      return channelIntentView(await service.resolve(tenant, input.intent_id, input.note));
    }
    if (path === "refunds/status") {
      const input = ChannelRefundIdSchema.parse(body);
      const row = await refunds.advance(tenant, input.refund_id);
      if (row === null) throw new ChannelBusinessError("RESOURCE_UNAVAILABLE");
      return channelRefundView(row);
    }
    if (path === "reconcile")
      return runtime.transact(tenant, async (tx) => {
        if (!(await requesterAuthorityIsCurrent(runtime, auth, tx)))
          throw new ChannelBusinessError("POLICY_DENIED");
        return reconcileChannelBill(tx.client, tenant, body);
      });
    if (path === "reconcile/history" || path === "reconcile/detail" || path === "reconcile/review")
      return runtime.transact(tenant, async (tx) => {
        if (!(await requesterAuthorityIsCurrent(runtime, auth, tx)))
          throw new ChannelBusinessError("POLICY_DENIED");
        if (path === "reconcile/history") return listReconciliations(tx.client, tenant, body);
        if (path === "reconcile/detail") return readReconciliation(tx.client, tenant, body);
        return reviewReconciliation(tx.client, tenant, body);
      });
    const input = ChannelListInputSchema.parse(body);
    // Staff see the collections of the order in front of them, not the store's history.
    if (!isAdmin(auth) && input.order_id === undefined)
      throw new ChannelBusinessError("POLICY_DENIED");
    return runtime.transact(tenant, async ({ client }) =>
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
  };
  const paths: readonly Path[] = [
    "settings",
    "available",
    "checkout",
    "status",
    "list",
    "close",
    "refunds/list",
    "refunds/status",
    "reconcile",
    "reconcile/history",
    "reconcile/detail",
    "reconcile/review",
    "resolve",
  ];
  for (const path of paths)
    for (const method of (path === "settings"
      ? ["GET", "POST"]
      : GET_PATHS.has(path)
        ? ["GET"]
        : ["POST"]) as readonly ("GET" | "POST")[])
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
            if (COLLECTOR_PATHS.has(path) ? !mayCollect(auth) : !isAdmin(auth)) {
              reply.code(403);
              return fail("PERMISSION_DENIED");
            }
            const reauth = (path === "settings" && method === "POST") || path === "resolve";
            const rate = (reauth ? reauthLimiter : limiter).consume(auth.session.staff_id);
            if (!rate.allowed) {
              reply.code(429).header("Retry-After", String(rate.retryAfterSeconds));
              return fail("RATE_LIMITED");
            }
            if (method === "POST") {
              const csrf = await requireCsrf(context, request, reply, auth.session);
              if (csrf !== true) return csrf;
            }
            const data = await handle(path, auth, channelTenant(auth), request.body, method);
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
