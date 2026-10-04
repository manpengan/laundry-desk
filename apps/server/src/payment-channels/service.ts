import type { ByokKmsPort } from "../ai/byok-kms.js";
import type { LocalRuntime } from "../local/runtime-types.js";
import { createByokRuntime } from "../ai/byok-runtime.js";
import type { TenantContext } from "../db/types.js";
import { ChannelBusinessError, channelAdapter, readChannelSettings } from "./settings.js";
import { channelAudit, readIntent, type ChannelIntent } from "./intent-store.js";
import {
  closeCode,
  closeUndispatched,
  closeUnconfirmed,
  type CloseReason,
} from "./close-undispatched.js";
import { settleChannelPayment } from "./settlement.js";
import {
  channelFailure,
  notCreated,
  ORDER_CLOSED,
  ORDER_PAID,
  pastGrace,
  REVIEW_AFTER_MS,
} from "./outcome.js";
import { ChannelProtocolError, type ChannelAdapter, type ChannelHttp } from "./types.js";

const TERMINAL = new Set(["paid", "closed"]);
const undispatched = (intent: ChannelIntent) =>
  intent.dispatched_at === null && intent.provider_order === null && intent.paid_at === null;

export function createChannelService(
  local: LocalRuntime,
  kms: ByokKmsPort | null,
  http?: ChannelHttp,
) {
  const runtime = createByokRuntime(local, kms);
  const transact = runtime.transact;
  const read = async (tenant: TenantContext, id: string) =>
    transact(tenant, async ({ client }) => {
      const intent = await readIntent(client, tenant, id);
      if (intent === null) throw new ChannelBusinessError("RESOURCE_UNAVAILABLE");
      return intent;
    });
  /** Settings are read in a short transaction; DPAPI decryption runs outside it. */
  const load = async (tenant: TenantContext, id: string) => {
    const { intent, settings } = await transact(tenant, async ({ client }) => {
      const current = await readIntent(client, tenant, id);
      if (current === null) throw new ChannelBusinessError("RESOURCE_UNAVAILABLE");
      return {
        intent: current,
        settings: await readChannelSettings(client, tenant, current.channel),
      };
    });
    if (
      kms === null ||
      settings === null ||
      settings.account_fingerprint !== intent.account_fingerprint
    )
      throw new ChannelBusinessError("RESOURCE_UNAVAILABLE");
    return { intent, adapter: await channelAdapter(kms, tenant, settings, http) };
  };
  const finish = async (
    tenant: TenantContext,
    id: string,
    errorCode: string,
    detail: Readonly<Record<string, unknown>> = {},
  ) => {
    await transact(tenant, ({ client }) => closeUnconfirmed(client, tenant, id, errorCode, detail));
    return read(tenant, id);
  };
  /** The provider may hold the request; keep the reservation until a query decides. */
  const unknown = async (tenant: TenantContext, id: string, failure: ChannelProtocolError) => {
    await transact(tenant, async ({ client }) => {
      const intent = await readIntent(client, tenant, id, true);
      if (intent === null || TERMINAL.has(intent.state)) return;
      const review =
        intent.dispatched_at !== null && Date.now() > intent.expires_at.getTime() + REVIEW_AFTER_MS;
      await client.query(
        `UPDATE payment_channel_intents
        SET state=CASE WHEN $5 OR state='needs_review' THEN 'needs_review' ELSE 'unknown' END,
        error_code=CASE WHEN $5 THEN 'CHANNEL_REVIEW_REQUIRED' ELSE $4 END,checked_at=statement_timestamp()
        WHERE org_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid`,
        [tenant.orgId, tenant.storeId, id, failure.code, review],
      );
    });
    return read(tenant, id);
  };
  /** Ends an unpaid order at the provider, then releases the local reservation. */
  const end = async (
    tenant: TenantContext,
    id: string,
    adapter: ChannelAdapter,
    reason: CloseReason,
  ): Promise<ChannelIntent> => {
    const intent = await read(tenant, id);
    try {
      const result = await adapter.close(intent.merchant_order);
      if (result.outcome === "retry")
        return unknown(tenant, id, new ChannelProtocolError("CHANNEL_TRANSPORT_FAILED"));
      return finish(tenant, id, reason, { provider: "closed" });
    } catch (error) {
      const failure = channelFailure(error);
      if (failure.code === "CHANNEL_ORDER_NOT_FOUND")
        return finish(tenant, id, reason, { provider: "not_found" });
      if (failure.code === "CHANNEL_REJECTED" && failure.providerCode !== null) {
        if (ORDER_PAID.has(failure.providerCode)) return query(tenant, id, adapter, false);
        if (ORDER_CLOSED.has(failure.providerCode))
          return finish(tenant, id, reason, { provider: "already_closed" });
      }
      return unknown(tenant, id, failure);
    }
  };
  /** Settles the provider's answer; an expired unpaid code is ended when `expire` is set. */
  const query = async (
    tenant: TenantContext,
    id: string,
    adapter: ChannelAdapter,
    expire: boolean,
  ): Promise<ChannelIntent> => {
    const intent = await read(tenant, id);
    try {
      const payment = await adapter.query(intent.merchant_order);
      const settled = await transact(tenant, ({ client }) =>
        settleChannelPayment(client, tenant, local, id, payment),
      );
      if (expire && settled.state === "pending" && pastGrace(settled.expires_at))
        return end(tenant, id, adapter, "CHANNEL_EXPIRED");
      return settled;
    } catch (error) {
      const failure = channelFailure(error);
      // Unscanned Alipay codes and lost WeChat requests have no provider order at all.
      if (failure.code === "CHANNEL_ORDER_NOT_FOUND" && pastGrace(intent.expires_at))
        return expire
          ? end(tenant, id, adapter, "CHANNEL_EXPIRED")
          : finish(tenant, id, "CHANNEL_EXPIRED", { provider: "not_found" });
      return unknown(tenant, id, failure);
    }
  };
  const sync = async (tenant: TenantContext, id: string) => {
    const intent = await read(tenant, id);
    if (TERMINAL.has(intent.state)) return intent;
    if (undispatched(intent)) {
      await transact(tenant, ({ client }) => closeUndispatched(client, tenant, id, true));
      return read(tenant, id);
    }
    const { adapter } = await load(tenant, id);
    return query(tenant, id, adapter, true);
  };
  return Object.freeze({
    transact,
    read,
    sync,
    async dispatch(tenant: TenantContext, id: string, openId?: string) {
      const { intent, adapter } = await load(tenant, id);
      const claimed = await transact(tenant, async ({ client }) => {
        const current = await readIntent(client, tenant, id, true);
        if (
          current === null ||
          current.state !== "created" ||
          current.dispatched_at !== null ||
          current.expires_at.getTime() <= Date.now()
        )
          return false;
        const settings = await readChannelSettings(client, tenant, current.channel, true);
        if (settings === null || !settings.enabled)
          throw new ChannelBusinessError("RESOURCE_UNAVAILABLE");
        await client.query(
          `UPDATE payment_channel_intents SET state='unknown',dispatched_at=statement_timestamp(),error_code='CHANNEL_AWAITING_PROVIDER'
          WHERE org_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid`,
          [tenant.orgId, tenant.storeId, id],
        );
        await channelAudit(
          client,
          { ...tenant, staffId: current.actor_id },
          "payment.channel.dispatch",
          id,
          { channel: current.channel },
        );
        return true;
      });
      if (!claimed) return read(tenant, id);
      try {
        const checkout = await adapter.checkout({
          merchantOrder: intent.merchant_order,
          amountCents: intent.amount_cents,
          description: intent.purpose === "order" ? "洗护服务" : "会员账户充值",
          expiresAt: intent.expires_at,
          ...(openId === undefined ? {} : { openId }),
        });
        await transact(tenant, async ({ client }) => {
          await client.query(
            `UPDATE payment_channel_intents SET state='pending',checkout_json=$4::jsonb,error_code=NULL
            WHERE org_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND state='unknown'`,
            [tenant.orgId, tenant.storeId, id, JSON.stringify(checkout)],
          );
        });
        return read(tenant, id);
      } catch (error) {
        const failure = channelFailure(error);
        if (notCreated(failure))
          return finish(
            tenant,
            id,
            closeCode(
              failure.code === "CHANNEL_NOT_SENT" ? "CHANNEL_NOT_SENT" : "CHANNEL_REJECTED",
              failure,
            ),
            { provider_code: failure.providerCode },
          );
        return unknown(tenant, id, failure);
      }
    },
    async close(tenant: TenantContext, id: string) {
      const intent = await read(tenant, id);
      if (TERMINAL.has(intent.state)) return intent;
      if (undispatched(intent)) {
        await transact(tenant, ({ client }) => closeUndispatched(client, tenant, id, false));
        return read(tenant, id);
      }
      if (intent.paid_at !== null) return sync(tenant, id);
      const { adapter } = await load(tenant, id);
      return end(tenant, id, adapter, "CHANNEL_CLOSED_BY_STAFF");
    },
    /**
     * Administrator write-off for an expired intent that no provider answer can settle
     * (e.g. a merchant account that no longer exists). Never touches a verified receipt.
     */
    async resolve(tenant: TenantContext, id: string, note: string) {
      const intent = await read(tenant, id);
      if (
        !["unknown", "needs_review"].includes(intent.state) ||
        intent.provider_order !== null ||
        intent.paid_at !== null ||
        !pastGrace(intent.expires_at)
      )
        throw new ChannelBusinessError("RESOURCE_UNAVAILABLE");
      return finish(tenant, id, "CHANNEL_MANUAL_CLOSED", { note });
    },
  });
}
export type ChannelService = ReturnType<typeof createChannelService>;
