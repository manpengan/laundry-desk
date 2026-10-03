import { z } from "zod";
import {
  MINIAPP_TRANSACTION_SCHEMAS as S,
  MiniappBalancePaymentSchema,
  MiniappBenefitAppliedSchema,
  MiniappPaymentIntentSchema,
} from "@laundry/contracts";
import { insertIntent, type ChannelIntent } from "../payment-channels/intent-store.js";
import { readActiveBonusRules } from "../member/pg-bonus-rules.js";
import { matchBonusRule } from "../member/bonus.js";
import {
  ownedAccount,
  requireOwnedOrder,
  type Delegation,
  createMiniappDomainExecutor,
} from "./authority.js";
import { MiniappError, type MiniappTransaction } from "./types.js";

export function miniappIntentView(row: ChannelIntent, withCheckout = true) {
  return MiniappPaymentIntentSchema.parse({
    intent_id: row.id,
    state: row.state,
    amount_cents: row.amount_cents,
    checkout:
      withCheckout && row.state === "pending" && row.checkout_json?.kind === "jsapi"
        ? row.checkout_json
        : null,
  });
}
export async function ownedIntent(tx: MiniappTransaction, id: string) {
  const row = (
    await tx.client.query<ChannelIntent>(
      `SELECT * FROM payment_channel_intents WHERE org_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
    AND customer_canonical_root(customer_id)=$4::uuid AND channel='wechat' AND customer_session_id IS NOT NULL FOR SHARE`,
      [tx.tenant.orgId, tx.tenant.storeId, id, tx.customerId],
    )
  ).rows[0];
  if (row === undefined) throw new MiniappError("RESOURCE_UNAVAILABLE");
  return row;
}
export async function createMiniappPayment(
  tx: MiniappTransaction,
  authority: Delegation,
  action: "payment/create" | "topup/create",
  raw: unknown,
) {
  if (
    !(authority.actor.permissions ?? []).includes(
      action === "payment/create" ? "order_write" : "customer_write",
    )
  )
    throw new MiniappError("PERMISSION_DENIED");
  const merchant = (
    await tx.client.query<{ app_id: string }>(
      `SELECT app_id FROM payment_channel_settings WHERE org_id=$1::uuid AND store_id=$2::uuid AND channel='wechat' AND enabled FOR SHARE`,
      [tx.tenant.orgId, tx.tenant.storeId],
    )
  ).rows[0];
  if (merchant?.app_id !== tx.settings.app_id) throw new MiniappError("POLICY_DENIED");
  if (action === "payment/create") {
    const input = S[action].parse(raw);
    const order = await requireOwnedOrder(tx, input.order_id);
    return miniappIntentView(
      await insertIntent(tx.client, authority.tenant, {
        idempotencyKey: input.idempotency_key,
        channel: "wechat",
        purpose: "order",
        orderId: input.order_id,
        accountId: null,
        customerId: order.customer_id,
        customerSessionId: tx.identity.sessionId,
      }),
      false,
    );
  }
  const input = S[action].parse(raw);
  const { id: accountId, customer_id: accountCustomerId } = await ownedAccount(tx);
  const bonus = matchBonusRule(
    await readActiveBonusRules(tx.client, tx.tenant),
    input.amount_cents,
  );
  return miniappIntentView(
    await insertIntent(tx.client, authority.tenant, {
      idempotencyKey: input.idempotency_key,
      channel: "wechat",
      purpose: "topup",
      orderId: null,
      accountId,
      customerId: accountCustomerId,
      customerSessionId: tx.identity.sessionId,
      amountCents: input.amount_cents,
      bonusCents: bonus.bonus_cents,
      bonusRuleId: bonus.rule_id,
    }),
    false,
  );
}
export async function applyMiniappBenefit(
  tx: MiniappTransaction,
  authority: Delegation,
  action: string,
  raw: unknown,
  execute: ReturnType<typeof createMiniappDomainExecutor>,
) {
  if (action === "balance/pay") {
    const input = S["balance/pay"].parse(raw);
    const { id: accountId } = await ownedAccount(tx);
    const order = await requireOwnedOrder(tx, input.order_id);
    const unresolved = await tx.client.query(
      `SELECT 1 FROM payment_channel_intents WHERE org_id=$1::uuid AND store_id=$2::uuid AND order_id=$3::uuid
      AND state IN('created','pending','unknown','needs_review') LIMIT 1`,
      [tx.tenant.orgId, tx.tenant.storeId, input.order_id],
    );
    if (unresolved.rows.length > 0 || order.balance_cents <= 0 || order.balance_cents > 5_000_000)
      throw new MiniappError("INVARIANT_FAILED");
    const result = z
      .object({ payment_id: z.uuid(), balance_cents: z.number().int().nonnegative() })
      .parse(
        await execute(
          tx,
          authority,
          "member.balance.pay",
          { account_id: accountId, order_id: input.order_id, amount_cents: order.balance_cents },
          input.idempotency_key,
        ),
      );
    return MiniappBalancePaymentSchema.parse({
      order_id: input.order_id,
      paid_cents: order.balance_cents,
      payment_id: result.payment_id,
      balance_cents: result.balance_cents,
    });
  }
  if (action === "benefits/points") {
    const input = S["benefits/points"].parse(raw);
    const { id: accountId } = await ownedAccount(tx);
    await requireOwnedOrder(tx, input.order_id);
    await execute(
      tx,
      authority,
      "member.points.redeem",
      {
        account_id: accountId,
        points: input.points,
        reason: `顾客小程序本人兑换，订单 ${input.order_id}`,
      },
      input.idempotency_key,
    );
    return MiniappBenefitAppliedSchema.parse({ applied: true, entity_id: accountId });
  }
  const input = (action === "benefits/coupon" ? S["benefits/coupon"] : S["benefits/punch"]).parse(
    raw,
  );
  const { id: accountId } = await ownedAccount(tx);
  await requireOwnedOrder(tx, input.order_id);
  const table = action === "benefits/coupon" ? "coupon_grants" : "punch_cards";
  const owned = await tx.client.query(
    `SELECT 1 FROM ${table} WHERE org_id=$1::uuid AND id=$2::uuid AND account_id=$3::uuid`,
    [tx.tenant.orgId, input.asset_id, accountId],
  );
  if (owned.rows.length !== 1) throw new MiniappError("RESOURCE_UNAVAILABLE");
  const payload =
    "uses" in input
      ? {
          asset: { asset_kind: "punch", asset_id: input.asset_id, uses: input.uses },
          reason: `顾客小程序本人使用，订单 ${input.order_id}`,
        }
      : { asset: { asset_kind: "coupon", asset_id: input.asset_id, order_id: input.order_id } };
  await execute(tx, authority, "member.asset.consume", payload, input.idempotency_key);
  return MiniappBenefitAppliedSchema.parse({ applied: true, entity_id: input.asset_id });
}
