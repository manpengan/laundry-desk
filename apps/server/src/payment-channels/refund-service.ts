import type { ByokKmsPort } from "../ai/byok-kms.js";
import { createByokRuntime } from "../ai/byok-runtime.js";
import type { LocalRuntime } from "../local/runtime-types.js";
import type { TenantContext } from "../db/types.js";
import { channelAdapter, readChannelSettings, ChannelBusinessError } from "./settings.js";
import { channelAudit, readIntent } from "./intent-store.js";
import { readRefund } from "./refund-store.js";
import { settleChannelRefund } from "./refund-settlement.js";
import { closeCode } from "./close-undispatched.js";
import { channelFailure } from "./outcome.js";
import type {
  ChannelAdapter,
  ChannelHttp,
  ChannelProtocolError,
  ChannelRefundInput,
} from "./types.js";

/** Rejections that a later attempt with the same refund reference may still pass. */
const RETRYABLE = new Set(["NOT_ENOUGH", "FREQUENCY_LIMITED", "SYSTEM_ERROR", "ACQ.SYSTEM_ERROR"]);

export function createChannelRefundService(
  local: LocalRuntime,
  kms: ByokKmsPort | null,
  http?: ChannelHttp,
) {
  const { transact } = createByokRuntime(local, kms);
  const read = (tenant: TenantContext, id: string) =>
    transact(tenant, ({ client }) => readRefund(client, tenant, id));
  /** Decrypts outside any row lock; the claim below re-checks the same settings version. */
  const adapterFor = async (tenant: TenantContext, id: string) => {
    const loaded = await transact(tenant, async ({ client }) => {
      const refund = await readRefund(client, tenant, id);
      if (refund === null) throw new ChannelBusinessError("RESOURCE_UNAVAILABLE");
      const intent = await readIntent(client, tenant, refund.intent_id);
      if (intent === null) throw new ChannelBusinessError("RESOURCE_UNAVAILABLE");
      return { intent, settings: await readChannelSettings(client, tenant, intent.channel) };
    });
    const { intent, settings } = loaded;
    if (
      kms === null ||
      settings === null ||
      settings.account_fingerprint !== intent.account_fingerprint
    )
      throw new ChannelBusinessError("RESOURCE_UNAVAILABLE");
    return {
      adapter: await channelAdapter(kms, tenant, settings, http),
      version: settings.version,
    };
  };
  const record = (tenant: TenantContext, id: string, state: "unknown" | "failed", code: string) =>
    transact(tenant, ({ client }) =>
      client.query(
        `UPDATE payment_channel_refunds SET state=CASE WHEN $5='failed' THEN 'failed' WHEN state='needs_review' THEN state ELSE 'unknown' END,
        error_code=$4,checked_at=statement_timestamp()
        WHERE org_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND state NOT IN ('refunded','failed')`,
        [tenant.orgId, tenant.storeId, id, code, state],
      ),
    );
  const submit = async (
    tenant: TenantContext,
    id: string,
    adapter: ChannelAdapter,
    input: ChannelRefundInput,
    resend: boolean,
  ) => {
    // Only a rejected submission proves the refund did not happen; a rejected query does not.
    let submitted = resend;
    try {
      let receipt;
      if (resend) receipt = await adapter.refund(input);
      else {
        try {
          receipt = await adapter.queryRefund(input);
        } catch (error) {
          const failure = channelFailure(error);
          if (failure.code !== "CHANNEL_ORDER_NOT_FOUND") throw failure;
          // Refund references are idempotent at both providers: resend a lost submission.
          submitted = true;
          receipt = await adapter.refund(input);
        }
      }
      return await transact(tenant, ({ client }) =>
        settleChannelRefund(client, tenant, local, id, receipt),
      );
    } catch (error) {
      const failure: ChannelProtocolError = channelFailure(error);
      const definitive =
        submitted &&
        failure.code === "CHANNEL_REJECTED" &&
        (failure.providerCode === null || !RETRYABLE.has(failure.providerCode));
      await record(
        tenant,
        id,
        definitive ? "failed" : "unknown",
        definitive ? closeCode("CHANNEL_REJECTED", failure) : failure.code,
      );
      return read(tenant, id);
    }
  };
  return Object.freeze({
    read,
    async advance(tenant: TenantContext, id: string) {
      const { adapter, version } = await adapterFor(tenant, id);
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
          settings === null ||
          settings.version !== version ||
          settings.account_fingerprint !== intent.account_fingerprint
        )
          throw new ChannelBusinessError("RESOURCE_UNAVAILABLE");
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
      return submit(tenant, id, adapter, loaded.input, loaded.dispatch);
    },
  });
}
