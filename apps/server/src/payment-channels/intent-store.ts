import { createHash, randomUUID } from "node:crypto";
import { ChannelIntentViewSchema } from "@laundry/contracts";
import type { SqlClient, TenantContext } from "../db/types.js";
import { ChannelBusinessError, readChannelSettings } from "./settings.js";
import type { ChannelCheckoutResult, PaymentChannel } from "./types.js";

export type ChannelIntent = Readonly<{
  id: string;
  org_id: string;
  store_id: string;
  channel: PaymentChannel;
  purpose: "order" | "topup";
  order_id: string | null;
  account_id: string | null;
  customer_id: string | null;
  actor_id: string;
  customer_session_id: string | null;
  input_sha256: string;
  merchant_order: string;
  account_fingerprint: string;
  amount_cents: number;
  bonus_cents: number;
  bonus_rule_id: string | null;
  state: "created" | "pending" | "unknown" | "paid" | "closed" | "needs_review";
  checkout_json: ChannelCheckoutResult | null;
  provider_order: string | null;
  payment_id: string | null;
  member_ledger_id: string | null;
  created_at: Date;
  expires_at: Date;
  dispatched_at: Date | null;
  checked_at: Date | null;
  paid_at: Date | null;
  error_code: string | null;
}>;
export async function readIntent(
  client: SqlClient,
  tenant: TenantContext,
  id: string,
  lock = false,
): Promise<ChannelIntent | null> {
  return (
    (
      await client.query<ChannelIntent>(
        `SELECT * FROM payment_channel_intents WHERE org_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid${lock ? " FOR UPDATE" : ""}`,
        [tenant.orgId, tenant.storeId, id],
      )
    ).rows[0] ?? null
  );
}
export function channelIntentView(intent: ChannelIntent) {
  return ChannelIntentViewSchema.parse({
    intent_id: intent.id,
    order_id: intent.order_id,
    purpose: intent.purpose,
    channel: intent.channel,
    amount_cents: intent.amount_cents,
    state: intent.state,
    qr_url:
      intent.checkout_json?.kind === "qr" && intent.state === "pending"
        ? intent.checkout_json.value
        : null,
    payment_id: intent.payment_id,
    created_at: intent.created_at.toISOString(),
    expires_at: intent.expires_at.toISOString(),
    error_code: intent.error_code,
  });
}
type NewIntent = Readonly<{
  idempotencyKey: string;
  channel: PaymentChannel;
  purpose: "order" | "topup";
  orderId: string | null;
  accountId: string | null;
  customerId: string | null;
  customerSessionId?: string;
  amountCents?: number;
  bonusCents?: number;
  bonusRuleId?: string | null;
}>;
export async function insertIntent(
  client: SqlClient,
  tenant: TenantContext,
  input: NewIntent,
): Promise<ChannelIntent> {
  if (tenant.staffId === undefined) throw new ChannelBusinessError("POLICY_DENIED");
  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        channel: input.channel,
        purpose: input.purpose,
        order: input.orderId,
        account: input.accountId,
        customer: input.customerId,
        amount: input.amountCents ?? null,
      }),
    )
    .digest("hex");
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,85))", [
    `${tenant.orgId}:${tenant.storeId}:${input.idempotencyKey}`,
  ]);
  const prior = (
    await client.query<ChannelIntent>(
      `SELECT * FROM payment_channel_intents WHERE org_id=$1::uuid AND store_id=$2::uuid AND idempotency_key=$3::uuid FOR UPDATE`,
      [tenant.orgId, tenant.storeId, input.idempotencyKey],
    )
  ).rows[0];
  if (prior !== undefined) {
    if (
      prior.input_sha256 !== hash ||
      (input.customerId !== null && prior.customer_id !== input.customerId)
    )
      throw new ChannelBusinessError("IDEMPOTENCY_CONFLICT");
    return prior;
  }
  const settings = await readChannelSettings(client, tenant, input.channel, true);
  if (settings === null || !settings.enabled)
    throw new ChannelBusinessError("RESOURCE_UNAVAILABLE");
  let amount = input.amountCents;
  let customerId = input.customerId;
  if (input.purpose === "order") {
    const order = (
      await client.query<{ balance_cents: number; customer_id: string | null }>(
        `SELECT balance_cents,customer_id::text FROM orders
      WHERE org_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND status='open' AND customer_pii_purged_at IS NULL FOR UPDATE`,
        [tenant.orgId, tenant.storeId, input.orderId],
      )
    ).rows[0];
    if (order === undefined || order.balance_cents <= 0 || order.balance_cents > 5_000_000)
      throw new ChannelBusinessError("RESOURCE_UNAVAILABLE");
    if (input.customerId !== null && order.customer_id !== input.customerId)
      throw new ChannelBusinessError("POLICY_DENIED");
    amount = order.balance_cents;
    customerId = order.customer_id;
    const reserved = await client.query(
      `SELECT 1 FROM payment_channel_intents WHERE org_id=$1::uuid AND store_id=$2::uuid
      AND order_id=$3::uuid AND state IN ('created','pending','unknown','needs_review')`,
      [tenant.orgId, tenant.storeId, input.orderId],
    );
    if (reserved.rows.length > 0) throw new ChannelBusinessError("RESOURCE_UNAVAILABLE");
  }
  if (input.purpose === "topup") {
    const account = await client.query(
      `SELECT 1 FROM member_accounts WHERE org_id=$1::uuid AND id=$2::uuid AND customer_id=$3::uuid
       AND status='active' FOR UPDATE`,
      [tenant.orgId, input.accountId, input.customerId],
    );
    if (account.rows.length !== 1) throw new ChannelBusinessError("RESOURCE_UNAVAILABLE");
    const reserved = await client.query(
      `SELECT 1 FROM payment_channel_intents WHERE org_id=$1::uuid
      AND account_id=$2::uuid AND state IN ('created','pending','unknown','needs_review')`,
      [tenant.orgId, input.accountId],
    );
    if (reserved.rows.length > 0) throw new ChannelBusinessError("RESOURCE_UNAVAILABLE");
  }
  if (amount === undefined || !Number.isInteger(amount) || amount < 1 || amount > 5_000_000)
    throw new ChannelBusinessError("VALIDATION_FAILED");
  const id = randomUUID();
  const row = (
    await client.query<ChannelIntent>(
      `INSERT INTO payment_channel_intents(id,org_id,store_id,channel,purpose,order_id,account_id,customer_id,actor_id,
    customer_session_id,idempotency_key,input_sha256,account_fingerprint,merchant_order,amount_cents,bonus_cents,bonus_rule_id,expires_at)
    VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6::uuid,$7::uuid,$8::uuid,$9::uuid,$10::uuid,$11::uuid,$12,$13,$14,$15,$16,$17::uuid,
      statement_timestamp()+interval '15 minutes') RETURNING *`,
      [
        id,
        tenant.orgId,
        tenant.storeId,
        input.channel,
        input.purpose,
        input.orderId,
        input.accountId,
        customerId,
        tenant.staffId,
        input.customerSessionId ?? null,
        input.idempotencyKey,
        hash,
        settings.account_fingerprint,
        id.replaceAll("-", ""),
        amount,
        input.bonusCents ?? 0,
        input.bonusRuleId ?? null,
      ],
    )
  ).rows[0];
  if (row === undefined) throw new ChannelBusinessError("RESOURCE_UNAVAILABLE");
  await channelAudit(client, tenant, "payment.channel.create", id, {
    channel: input.channel,
    purpose: input.purpose,
    amount_cents: amount,
    customer_session_id: input.customerSessionId ?? null,
  });
  return row;
}
export async function channelAudit(
  client: SqlClient,
  tenant: TenantContext,
  command: string,
  entityId: string,
  result: Readonly<Record<string, unknown>>,
  entity: "payment_channel_intent" | "payment_channel_reconciliation" = "payment_channel_intent",
) {
  await client.query(
    `INSERT INTO audit_log(id,org_id,store_id,staff_id,via,command,dry_run,entity,entity_id,after_json,at)
    VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,'api',$5,false,$8,$6,$7,statement_timestamp())`,
    [
      randomUUID(),
      tenant.orgId,
      tenant.storeId,
      tenant.staffId ?? null,
      command,
      entityId,
      JSON.stringify(result),
      entity,
    ],
  );
}
