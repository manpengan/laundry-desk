import { randomUUID } from "node:crypto";
import {
  ChannelRefundInputSchema,
  ChannelRefundViewSchema,
  createCommandError,
} from "@laundry/contracts";
import { HandlerCommandError, type CommandHandler } from "../bus/types.js";
import type { SqlClient, TenantContext } from "../db/types.js";
import { ChannelBusinessError, readChannelSettings } from "./settings.js";
import { readIntent } from "./intent-store.js";
export type ChannelRefundRow = Readonly<{
  id: string;
  org_id: string;
  store_id: string;
  intent_id: string;
  actor_id: string;
  idempotency_key: string;
  merchant_refund: string;
  amount_cents: number;
  reason: string;
  state: "created" | "pending" | "unknown" | "refunded" | "failed" | "needs_review";
  provider_refund: string | null;
  payment_id: string | null;
  member_ledger_id: string | null;
  created_at: Date;
  dispatched_at: Date | null;
  checked_at: Date | null;
  error_code: string | null;
}>;
export async function readRefund(
  client: SqlClient,
  tenant: TenantContext,
  id: string,
  lock = false,
) {
  return (
    (
      await client.query<ChannelRefundRow>(
        `SELECT * FROM payment_channel_refunds WHERE org_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid${lock ? " FOR UPDATE" : ""}`,
        [tenant.orgId, tenant.storeId, id],
      )
    ).rows[0] ?? null
  );
}
export const channelRefundView = (row: ChannelRefundRow) =>
  ChannelRefundViewSchema.parse({
    refund_id: row.id,
    intent_id: row.intent_id,
    amount_cents: row.amount_cents,
    state: row.state,
    payment_id: row.payment_id,
    error_code: row.error_code,
  });
export const queueChannelRefund: CommandHandler = async (ctx) => {
  try {
    if (ctx.client.memoryTransaction === true || ctx.request.idempotencyKey === undefined)
      throw new ChannelBusinessError("RESOURCE_UNAVAILABLE");
    const input = ChannelRefundInputSchema.parse(ctx.parsed);
    const intent = await readIntent(ctx.client, ctx.tenant, input.intent_id, true);
    if (intent === null || intent.state !== "paid")
      throw new ChannelBusinessError("RESOURCE_UNAVAILABLE");
    const prior = (
      await ctx.client.query<ChannelRefundRow>(
        `SELECT * FROM payment_channel_refunds WHERE org_id=$1::uuid AND store_id=$2::uuid AND idempotency_key=$3::uuid`,
        [ctx.tenant.orgId, ctx.tenant.storeId, ctx.request.idempotencyKey],
      )
    ).rows[0];
    if (prior !== undefined) {
      if (
        prior.intent_id !== intent.id ||
        prior.amount_cents !== input.amount_cents ||
        prior.reason !== input.reason
      )
        throw new ChannelBusinessError("IDEMPOTENCY_CONFLICT");
      return { result: channelRefundView(prior) };
    }
    const settings = await readChannelSettings(ctx.client, ctx.tenant, intent.channel, true);
    if (
      settings === null ||
      !settings.enabled ||
      settings.account_fingerprint !== intent.account_fingerprint
    )
      throw new ChannelBusinessError("RESOURCE_UNAVAILABLE");
    const reserved = (
      await ctx.client.query<{ amount: string }>(
        `SELECT COALESCE(sum(amount_cents),0)::text AS amount FROM payment_channel_refunds WHERE org_id=$1::uuid AND store_id=$2::uuid AND intent_id=$3::uuid AND state<>'failed'`,
        [ctx.tenant.orgId, ctx.tenant.storeId, intent.id],
      )
    ).rows[0];
    if (input.amount_cents > intent.amount_cents - Number(reserved?.amount ?? 0))
      throw new ChannelBusinessError("VALIDATION_FAILED");
    if (intent.purpose === "topup") {
      if (!ctx.actor.permissions?.includes("member_refund"))
        throw new ChannelBusinessError("POLICY_DENIED");
      await ctx.client.query(
        "SELECT id FROM member_accounts WHERE org_id=$1::uuid AND id=$2::uuid FOR UPDATE",
        [ctx.tenant.orgId, intent.account_id],
      );
      const balance = (
        await ctx.client.query<{ available: string }>(
          `SELECT
       COALESCE((SELECT sum(principal_delta_cents) FROM member_ledger WHERE org_id=$1::uuid AND account_id=$2::uuid),0)-
       COALESCE((SELECT sum(r.amount_cents) FROM payment_channel_refunds r JOIN payment_channel_intents i ON i.org_id=r.org_id AND i.store_id=r.store_id AND i.id=r.intent_id
       WHERE i.org_id=$1::uuid AND i.account_id=$2::uuid AND r.state NOT IN ('refunded','failed')),0) AS available`,
          [ctx.tenant.orgId, intent.account_id],
        )
      ).rows[0];
      if (input.amount_cents > Number(balance?.available ?? 0))
        throw new ChannelBusinessError("VALIDATION_FAILED");
    }
    const id = randomUUID();
    const row = (
      await ctx.client.query<ChannelRefundRow>(
        `INSERT INTO payment_channel_refunds(id,org_id,store_id,intent_id,actor_id,idempotency_key,merchant_refund,amount_cents,reason)
   VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7,$8,$9) RETURNING *`,
        [
          id,
          ctx.tenant.orgId,
          ctx.tenant.storeId,
          intent.id,
          ctx.actor.staffId,
          ctx.request.idempotencyKey,
          id.replaceAll("-", ""),
          input.amount_cents,
          input.reason,
        ],
      )
    ).rows[0];
    if (row === undefined) throw new ChannelBusinessError("RESOURCE_UNAVAILABLE");
    return {
      result: channelRefundView(row),
      audit: {
        entity: "payment_channel_refund",
        entityId: id,
        afterJson: JSON.stringify({
          intent_id: intent.id,
          amount_cents: input.amount_cents,
          reason: input.reason,
        }),
      },
    };
  } catch (error) {
    if (error instanceof ChannelBusinessError)
      throw new HandlerCommandError(createCommandError(error.code));
    throw error;
  }
};
