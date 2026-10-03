import type { ByokKmsPort } from "../ai/byok-kms.js";
import { createByokRuntime } from "../ai/byok-runtime.js";
import type { LocalRuntime } from "../local/runtime-types.js";
import type { TenantContext } from "../db/types.js";
import { channelAdapter, readChannelSettings, ChannelBusinessError } from "./settings.js";
import { channelAudit, readIntent } from "./intent-store.js";
import { readRefund } from "./refund-store.js";
import { settleChannelRefund } from "./refund-settlement.js";
import { ChannelProtocolError, type ChannelHttp } from "./types.js";
export function createChannelRefundService(
  local: LocalRuntime,
  kms: ByokKmsPort | null,
  http?: ChannelHttp,
) {
  const { transact } = createByokRuntime(local, kms);
  const read = (tenant: TenantContext, id: string) =>
    transact(tenant, ({ client }) => readRefund(client, tenant, id));
  return Object.freeze({
    read,
    async advance(tenant: TenantContext, id: string) {
      const loaded = await transact(tenant, async ({ client }) => {
        const refund = await readRefund(client, tenant, id, true);
        if (refund === null) throw new ChannelBusinessError("RESOURCE_UNAVAILABLE");
        if (refund.state === "refunded" || refund.state === "failed") return null;
        if (
          refund.state === "needs_review" &&
          refund.dispatched_at === null &&
          refund.provider_refund === null
        ) {
          await client.query(
            `UPDATE payment_channel_refunds SET state='failed',error_code='CHANNEL_NOT_DISPATCHED',checked_at=statement_timestamp() WHERE org_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid`,
            [tenant.orgId, tenant.storeId, id],
          );
          await channelAudit(
            client,
            { ...tenant, staffId: refund.actor_id },
            "payment.channel.refund_cancel_undispatched",
            id,
            { reason: "restore_invalidated_authority" },
          );
          return null;
        }
        const intent = await readIntent(client, tenant, refund.intent_id);
        if (intent === null) throw new ChannelBusinessError("RESOURCE_UNAVAILABLE");
        const settings = await readChannelSettings(client, tenant, intent.channel, true);
        if (
          kms === null ||
          settings === null ||
          settings.account_fingerprint !== intent.account_fingerprint
        )
          throw new ChannelBusinessError("RESOURCE_UNAVAILABLE");
        const adapter = await channelAdapter(kms, tenant, settings, http);
        const dispatch = refund.dispatched_at === null && refund.state === "created";
        if (dispatch) {
          if (!settings.enabled) throw new ChannelBusinessError("RESOURCE_UNAVAILABLE");
          await client.query(
            `UPDATE payment_channel_refunds SET state='unknown',dispatched_at=statement_timestamp(),error_code='CHANNEL_AWAITING_PROVIDER' WHERE org_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid`,
            [tenant.orgId, tenant.storeId, id],
          );
          await channelAudit(
            client,
            { ...tenant, staffId: refund.actor_id },
            "payment.channel.refund_dispatch",
            id,
            { intent_id: intent.id },
          );
        }
        return {
          adapter,
          dispatch,
          input: {
            merchantOrder: intent.merchant_order,
            merchantRefund: refund.merchant_refund,
            amountCents: refund.amount_cents,
            originalCents: intent.amount_cents,
            reason: refund.reason,
          },
        };
      });
      if (loaded === null) return read(tenant, id);
      try {
        const receipt = await (loaded.dispatch
          ? loaded.adapter.refund(loaded.input)
          : loaded.adapter.queryRefund(loaded.input));
        return await transact(tenant, ({ client }) =>
          settleChannelRefund(client, tenant, local, id, receipt),
        );
      } catch (error) {
        if (!(error instanceof ChannelProtocolError)) throw error;
        await transact(tenant, ({ client }) =>
          client.query(
            `UPDATE payment_channel_refunds SET state=CASE WHEN state='needs_review' THEN state ELSE 'unknown' END,error_code=$4,checked_at=statement_timestamp() WHERE org_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND state NOT IN ('refunded','failed')`,
            [tenant.orgId, tenant.storeId, id, error.code],
          ),
        );
        return read(tenant, id);
      }
    },
  });
}
