import type { ByokKmsPort } from "../ai/byok-kms.js";
import type { LocalRuntime } from "../local/runtime-types.js";
import { createByokRuntime } from "../ai/byok-runtime.js";
import type { TenantContext } from "../db/types.js";
import { ChannelBusinessError, channelAdapter, readChannelSettings } from "./settings.js";
import { channelAudit, readIntent } from "./intent-store.js";
import { closeUndispatched } from "./close-undispatched.js";
import { settleChannelPayment } from "./settlement.js";
import { ChannelProtocolError, type ChannelHttp } from "./types.js";

export function createChannelService(
  local: LocalRuntime,
  kms: ByokKmsPort | null,
  http?: ChannelHttp,
) {
  const runtime = createByokRuntime(local, kms);
  const transact = runtime.transact;
  const load = (tenant: TenantContext, id: string) =>
    transact(tenant, async ({ client }) => {
      const intent = await readIntent(client, tenant, id);
      if (intent === null) throw new ChannelBusinessError("RESOURCE_UNAVAILABLE");
      const settings = await readChannelSettings(client, tenant, intent.channel);
      if (
        kms === null ||
        settings === null ||
        settings.account_fingerprint !== intent.account_fingerprint
      )
        throw new ChannelBusinessError("RESOURCE_UNAVAILABLE");
      return { intent, adapter: await channelAdapter(kms, tenant, settings, http) };
    });
  const read = async (tenant: TenantContext, id: string) =>
    transact(tenant, async ({ client }) => {
      const intent = await readIntent(client, tenant, id);
      if (intent === null) throw new ChannelBusinessError("RESOURCE_UNAVAILABLE");
      return intent;
    });
  const unknown = async (tenant: TenantContext, id: string, error: unknown) => {
    if (!(error instanceof ChannelProtocolError)) throw error;
    await transact(tenant, async ({ client }) => {
      const intent = await readIntent(client, tenant, id, true);
      if (intent === null || intent.state === "paid" || intent.state === "closed") return;
      await client.query(
        `UPDATE payment_channel_intents SET state=CASE WHEN state='needs_review' THEN state ELSE 'unknown' END,
        error_code=$4,checked_at=statement_timestamp() WHERE org_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid`,
        [tenant.orgId, tenant.storeId, id, error.code],
      );
    });
    return read(tenant, id);
  };
  const sync = async (tenant: TenantContext, id: string) => {
    const intent = await read(tenant, id);
    if (intent.state === "paid" || intent.state === "closed") return intent;
    if (
      intent.dispatched_at === null &&
      intent.provider_order === null &&
      intent.paid_at === null
    ) {
      await transact(tenant, ({ client }) => closeUndispatched(client, tenant, id, true));
      return read(tenant, id);
    }
    const { adapter } = await load(tenant, id);
    try {
      const payment = await adapter.query(intent.merchant_order);
      return await transact(tenant, ({ client }) =>
        settleChannelPayment(client, tenant, local, id, payment),
      );
    } catch (error) {
      return unknown(tenant, id, error);
    }
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
        return unknown(tenant, id, error);
      }
    },
    async close(tenant: TenantContext, id: string) {
      const intent = await read(tenant, id);
      if (intent.state === "paid" || intent.state === "closed") return intent;
      if (
        intent.dispatched_at === null &&
        intent.provider_order === null &&
        intent.paid_at === null
      ) {
        await transact(tenant, ({ client }) => closeUndispatched(client, tenant, id, false));
        return read(tenant, id);
      }
      if (intent.paid_at !== null) return sync(tenant, id);
      const { adapter } = await load(tenant, id);
      try {
        await adapter.close(intent.merchant_order);
      } catch (error) {
        return unknown(tenant, id, error);
      }
      return sync(tenant, id);
    },
  });
}
export type ChannelService = ReturnType<typeof createChannelService>;
