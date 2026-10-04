import { randomUUID } from "node:crypto";
import type { SqlClient, TenantContext } from "../db/types.js";
import type { LocalRuntime } from "../local/runtime-types.js";
import { appendRefundTxn } from "../order/pg-order-refund.js";
import { deriveBusinessDate, assertBusinessDayOpen } from "../order/server-pricing.js";
import { createPgMemberStore } from "../member/pg-store.js";
import { channelAudit, readIntent, type ChannelIntent } from "./intent-store.js";
import { readRefund, type ChannelRefundRow } from "./refund-store.js";
import { ChannelBusinessError } from "./settings.js";
import { ChannelProtocolError, type ChannelRefund } from "./types.js";
async function applyRefund(
  client: SqlClient,
  tenant: TenantContext,
  local: LocalRuntime,
  intent: ChannelIntent,
  row: ChannelRefundRow,
) {
  const now = Math.floor(Date.now() / 1000);
  const date = deriveBusinessDate(now, local.order.timeZone, local.order.rolloverHour);
  await local.order.lockBusinessDay?.(client, tenant, date);
  await assertBusinessDayOpen(local.order.isBusinessDayClosed, date);
  if (intent.purpose === "topup" && intent.account_id !== null) {
    const result = await createPgMemberStore(client, tenant).refund({
      account_id: intent.account_id,
      amount_cents: row.amount_cents,
      tender: intent.channel,
      reason: row.reason,
      staff_id: row.actor_id,
      store_id: tenant.storeId,
      at: now,
      business_date: date,
      note: `channel-refund:${row.id}`,
    });
    return result.ok ? { paymentId: null, ledgerId: result.value.ledger_id } : null;
  }
  if (intent.order_id === null || intent.payment_id === null) return null;
  const result = await appendRefundTxn(
    client,
    {
      org_id: tenant.orgId,
      store_id: tenant.storeId,
      order_id: intent.order_id,
      amount_cents: row.amount_cents,
      expected_method: intent.channel,
      ref_payment_id: intent.payment_id,
      reason: row.reason,
      staff_id: row.actor_id,
      at: now,
      business_date: date,
    },
    randomUUID,
  );
  return result === null ? null : { paymentId: result.payment.payment_id, ledgerId: null };
}
export async function settleChannelRefund(
  client: SqlClient,
  tenant: TenantContext,
  local: LocalRuntime,
  id: string,
  receipt: ChannelRefund,
): Promise<ChannelRefundRow> {
  const row = await readRefund(client, tenant, id, true);
  if (row === null) throw new ChannelBusinessError("RESOURCE_UNAVAILABLE");
  const intent = await readIntent(client, tenant, row.intent_id, true);
  if (intent === null) throw new ChannelBusinessError("RESOURCE_UNAVAILABLE");
  if (
    receipt.merchantOrder !== intent.merchant_order ||
    receipt.merchantRefund !== row.merchant_refund ||
    receipt.amountCents !== row.amount_cents ||
    (row.provider_refund !== null && row.provider_refund !== receipt.providerRefund)
  )
    throw new ChannelProtocolError("CHANNEL_BINDING_MISMATCH");
  if (row.state === "refunded" || (row.state === "failed" && receipt.state === "failed"))
    return row;
  if (
    (row.state === "failed" && receipt.state !== "failed") ||
    (row.state === "needs_review" && row.provider_refund !== null && receipt.state !== "refunded")
  )
    throw new ChannelProtocolError("CHANNEL_BINDING_MISMATCH");
  const actorTenant = { ...tenant, staffId: row.actor_id };
  await client.query("SELECT set_config('app.staff_id',$1,true)", [row.actor_id]);
  await client.query(
    `UPDATE payment_channel_refunds SET state=$4,provider_refund=$5,checked_at=statement_timestamp(),error_code=$6 WHERE org_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid`,
    [
      tenant.orgId,
      tenant.storeId,
      id,
      receipt.state === "refunded" ? "needs_review" : receipt.state,
      receipt.providerRefund,
      receipt.state === "refunded" ? "CHANNEL_LEDGER_NOT_APPLIED" : null,
    ],
  );
  if (receipt.state === "refunded") {
    await client.query("SAVEPOINT channel_refund_apply");
    let applied: Awaited<ReturnType<typeof applyRefund>> = null;
    try {
      await client.query("SELECT set_config('app.channel_refund_id',$1,true)", [id]);
      applied = await applyRefund(client, actorTenant, local, intent, row);
      await client.query("RELEASE SAVEPOINT channel_refund_apply");
    } catch (error) {
      await client.query("ROLLBACK TO SAVEPOINT channel_refund_apply");
      await client.query("RELEASE SAVEPOINT channel_refund_apply");
      await client.query(
        `UPDATE payment_channel_refunds SET error_code=$4 WHERE org_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid`,
        [
          tenant.orgId,
          tenant.storeId,
          id,
          error instanceof Error ? "CHANNEL_LEDGER_APPLY_FAILED" : "CHANNEL_LEDGER_UNKNOWN_FAILURE",
        ],
      );
    }
    if (applied !== null)
      await client.query(
        `UPDATE payment_channel_refunds SET state='refunded',payment_id=$4::uuid,member_ledger_id=$5::uuid,error_code=NULL WHERE org_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid`,
        [tenant.orgId, tenant.storeId, id, applied.paymentId, applied.ledgerId],
      );
    await channelAudit(client, actorTenant, "payment.channel.refund_settle", id, {
      state: applied === null ? "needs_review" : "refunded",
      amount_cents: row.amount_cents,
      payment_id: applied?.paymentId ?? null,
      member_ledger_id: applied?.ledgerId ?? null,
    });
  }
  const current = await readRefund(client, tenant, id);
  if (current === null) throw new ChannelBusinessError("RESOURCE_UNAVAILABLE");
  return current;
}
