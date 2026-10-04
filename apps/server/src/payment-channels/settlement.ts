import { randomUUID } from "node:crypto";
import type { LocalRuntime } from "../local/runtime-types.js";
import type { SqlClient, TenantContext } from "../db/types.js";
import { appendPaymentTxn } from "../order/pg-order-operations.js";
import { deriveBusinessDate, assertBusinessDayOpen } from "../order/server-pricing.js";
import { createPgMemberStore } from "../member/pg-store.js";
import { ChannelBusinessError } from "./settings.js";
import { channelAudit, readIntent, type ChannelIntent } from "./intent-store.js";
import { ChannelProtocolError, type ChannelPayment } from "./types.js";

async function applyPaid(
  client: SqlClient,
  tenant: TenantContext,
  local: LocalRuntime,
  intent: ChannelIntent,
) {
  const now = Math.floor(Date.now() / 1000);
  const date = deriveBusinessDate(now, local.order.timeZone, local.order.rolloverHour);
  await local.order.lockBusinessDay?.(client, tenant, date);
  await assertBusinessDayOpen(local.order.isBusinessDayClosed, date);
  if (intent.purpose === "order" && intent.order_id !== null) {
    const result = await appendPaymentTxn(
      client,
      {
        org_id: tenant.orgId,
        store_id: tenant.storeId,
        order_id: intent.order_id,
        amount_cents: intent.amount_cents,
        method: intent.channel,
        kind: "pay",
        staff_id: intent.actor_id,
        at: now,
        business_date: date,
        note: `channel:${intent.id}`,
      },
      randomUUID,
    );
    if (result === null) return null;
    return { paymentId: result.payment.payment_id, ledgerId: null };
  }
  if (intent.account_id === null) return null;
  const result = await createPgMemberStore(client, tenant).topup({
    account_id: intent.account_id,
    amount_cents: intent.amount_cents,
    store_id: tenant.storeId,
    staff_id: intent.actor_id,
    tender: intent.channel,
    at: now,
    business_date: date,
    note: `channel:${intent.id}`,
    frozen_bonus: { bonus_cents: intent.bonus_cents, rule_id: intent.bonus_rule_id },
  });
  return result.ok ? { paymentId: null, ledgerId: result.value.ledger_id } : null;
}
export async function settleChannelPayment(
  client: SqlClient,
  tenant: TenantContext,
  local: LocalRuntime,
  id: string,
  payment: ChannelPayment,
): Promise<ChannelIntent> {
  const intent = await readIntent(client, tenant, id, true);
  if (intent === null) throw new ChannelBusinessError("RESOURCE_UNAVAILABLE");
  if (
    intent.merchant_order !== payment.merchantOrder ||
    (payment.state === "paid" && payment.amountCents === null) ||
    (payment.amountCents !== null && intent.amount_cents !== payment.amountCents) ||
    (intent.provider_order !== null &&
      payment.providerOrder !== null &&
      payment.providerOrder !== intent.provider_order)
  )
    throw new ChannelProtocolError("CHANNEL_BINDING_MISMATCH");
  // Money reported after a definitive close is an anomaly for reconciliation to surface.
  if (intent.state === "closed" && payment.state === "paid")
    throw new ChannelProtocolError("CHANNEL_BINDING_MISMATCH");
  if (intent.state === "paid") {
    if (payment.state === "pending") throw new ChannelProtocolError("CHANNEL_BINDING_MISMATCH");
    // A paid trade later reported closed (Alipay after a full refund) changes nothing here:
    // refunds are recorded through payment_channel_refunds.
    return intent;
  }
  if (intent.state === "closed") return intent;
  if (intent.provider_order !== null && payment.state !== "paid")
    throw new ChannelProtocolError("CHANNEL_BINDING_MISMATCH");
  const actorTenant = Object.freeze({ ...tenant, staffId: intent.actor_id });
  await client.query("SELECT set_config('app.staff_id',$1,true)", [intent.actor_id]);
  if (payment.state !== "paid") {
    await client.query(
      `UPDATE payment_channel_intents SET state=$4,checked_at=statement_timestamp(),error_code=NULL,
      checkout_json=CASE WHEN $4='closed' THEN NULL ELSE checkout_json END WHERE org_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid`,
      [tenant.orgId, tenant.storeId, id, payment.state],
    );
  } else {
    if (payment.providerOrder === null || payment.paidAt === null)
      throw new ChannelProtocolError("CHANNEL_RESPONSE_INVALID");
    // Preserve the reservation while the verified receipt awaits its ledger.
    await client.query(
      `UPDATE payment_channel_intents SET state='needs_review',provider_order=$4,paid_at=$5,
      checked_at=statement_timestamp(),checkout_json=NULL,error_code='CHANNEL_LEDGER_NOT_APPLIED'
      WHERE org_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid`,
      [tenant.orgId, tenant.storeId, id, payment.providerOrder, payment.paidAt],
    );
    await client.query("SAVEPOINT channel_ledger_apply");
    await client.query("SELECT set_config('app.channel_settlement_id',$1,true)", [id]);
    let applied: Awaited<ReturnType<typeof applyPaid>>;
    try {
      applied = await applyPaid(client, actorTenant, local, intent);
      await client.query("RELEASE SAVEPOINT channel_ledger_apply");
    } catch (error) {
      // The verified receipt survives a closed day or unavailable ledger. The
      // visible needs_review state is retried; no unverified credit is invented.
      await client.query("ROLLBACK TO SAVEPOINT channel_ledger_apply");
      await client.query("RELEASE SAVEPOINT channel_ledger_apply");
      await client.query(
        `UPDATE payment_channel_intents SET error_code=$4
        WHERE org_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid`,
        [
          tenant.orgId,
          tenant.storeId,
          id,
          error instanceof Error ? "CHANNEL_LEDGER_APPLY_FAILED" : "CHANNEL_LEDGER_UNKNOWN_FAILURE",
        ],
      );
      applied = null;
    }
    if (applied !== null) {
      await client.query(
        `UPDATE payment_channel_intents SET state='paid',payment_id=$4::uuid,member_ledger_id=$5::uuid,error_code=NULL
        WHERE org_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid`,
        [tenant.orgId, tenant.storeId, id, applied.paymentId, applied.ledgerId],
      );
    }
    await channelAudit(client, actorTenant, "payment.channel.settle", id, {
      state: applied === null ? "needs_review" : "paid",
      amount_cents: intent.amount_cents,
      payment_id: applied?.paymentId ?? null,
      member_ledger_id: applied?.ledgerId ?? null,
      customer_session_id: intent.customer_session_id,
    });
  }
  const current = await readIntent(client, tenant, id);
  if (current === null) throw new ChannelBusinessError("RESOURCE_UNAVAILABLE");
  return current;
}
