import { createHash, randomUUID } from "node:crypto";
import { ChannelReconcileInputSchema, ChannelReconcileViewSchema } from "@laundry/contracts";
import type { SqlClient, TenantContext } from "../db/types.js";
import { channelAudit } from "./intent-store.js";
import { ChannelBusinessError } from "./settings.js";
export async function reconcileChannelBill(client: SqlClient, tenant: TenantContext, raw: unknown) {
  const input = ChannelReconcileInputSchema.parse(raw);
  if (
    tenant.staffId === undefined ||
    new Date(`${input.business_date}T00:00:00Z`).toISOString().slice(0, 10) !== input.business_date
  )
    throw new ChannelBusinessError("VALIDATION_FAILED");
  const sourceHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  const local = await client.query<{
    merchant_order: string;
    merchant_refund: string | null;
    provider_order: string | null;
    amount_cents: number;
    state: string;
  }>(
    `
 SELECT i.merchant_order,NULL::text AS merchant_refund,i.provider_order,i.amount_cents,i.state
 FROM payment_channel_intents i LEFT JOIN payments p ON p.org_id=i.org_id AND p.store_id=i.store_id AND p.id=i.payment_id
 LEFT JOIN member_ledger l ON l.org_id=i.org_id AND l.id=i.member_ledger_id
 WHERE i.org_id=$1::uuid AND i.store_id=$2::uuid AND i.channel=$3 AND (COALESCE(p.business_date,l.business_date)=$4::text OR i.merchant_order=ANY($5::text[]))
 UNION ALL SELECT i.merchant_order,r.merchant_refund,i.provider_order,r.amount_cents,r.state
 FROM payment_channel_refunds r JOIN payment_channel_intents i ON i.org_id=r.org_id AND i.store_id=r.store_id AND i.id=r.intent_id
 LEFT JOIN payments p ON p.org_id=r.org_id AND p.store_id=r.store_id AND p.id=r.payment_id
 LEFT JOIN member_ledger l ON l.org_id=r.org_id AND l.id=r.member_ledger_id
 WHERE r.org_id=$1::uuid AND r.store_id=$2::uuid AND i.channel=$3 AND (COALESCE(p.business_date,l.business_date)=$4::text OR r.merchant_refund=ANY($6::text[])) LIMIT 10001`,
    [
      tenant.orgId,
      tenant.storeId,
      input.channel,
      input.business_date,
      input.rows.filter((r) => r.kind === "payment").map((r) => r.merchant_order),
      input.rows.flatMap((r) => (r.merchant_refund === null ? [] : [r.merchant_refund])),
    ],
  );
  if (local.rows.length > 10000) throw new ChannelBusinessError("RESOURCE_UNAVAILABLE");
  const key = (order: string, refund: string | null) => `${order}:${refund ?? ""}`;
  const entries = new Map(
    local.rows.map((row) => [key(row.merchant_order, row.merchant_refund), row]),
  );
  const seen = new Set<string>();
  const mismatches: Array<{
    merchant_order: string;
    merchant_refund: string | null;
    reason:
      | "missing_local"
      | "missing_provider"
      | "amount_mismatch"
      | "state_mismatch"
      | "reference_mismatch"
      | "duplicate_provider";
  }> = [];
  let matched = 0;
  for (const row of input.rows) {
    if ((row.kind === "payment") !== (row.merchant_refund === null))
      throw new ChannelBusinessError("VALIDATION_FAILED");
    const identity = key(row.merchant_order, row.merchant_refund);
    const expected = entries.get(identity);
    const reason = seen.has(identity)
      ? "duplicate_provider"
      : expected === undefined
        ? "missing_local"
        : expected.amount_cents !== row.amount_cents
          ? "amount_mismatch"
          : expected.provider_order !== row.provider_order
            ? "reference_mismatch"
            : expected.state !== (row.kind === "payment" ? "paid" : "refunded")
              ? "state_mismatch"
              : null;
    seen.add(identity);
    if (reason === null) matched++;
    else
      mismatches.push({
        merchant_order: row.merchant_order,
        merchant_refund: row.merchant_refund,
        reason,
      });
  }
  for (const [identity, row] of entries)
    if (!seen.has(identity))
      mismatches.push({
        merchant_order: row.merchant_order,
        merchant_refund: row.merchant_refund,
        reason: "missing_provider",
      });
  if (mismatches.length > 10000) throw new ChannelBusinessError("RESOURCE_UNAVAILABLE");
  const id = randomUUID();
  await client.query(
    `INSERT INTO payment_channel_reconciliations(id,org_id,store_id,channel,business_date,actor_id,source_sha256,matched_count,mismatches_json) VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5::date,$6::uuid,$7,$8,$9::jsonb)`,
    [
      id,
      tenant.orgId,
      tenant.storeId,
      input.channel,
      input.business_date,
      tenant.staffId,
      sourceHash,
      matched,
      JSON.stringify(mismatches),
    ],
  );
  await channelAudit(
    client,
    tenant,
    "payment.channel.reconcile",
    id,
    {
      channel: input.channel,
      business_date: input.business_date,
      source_sha256: sourceHash,
      matched_count: matched,
      mismatch_count: mismatches.length,
    },
    "payment_channel_reconciliation",
  );
  return ChannelReconcileViewSchema.parse({
    reconciliation_id: id,
    source_sha256: sourceHash,
    matched_count: matched,
    mismatches,
  });
}
