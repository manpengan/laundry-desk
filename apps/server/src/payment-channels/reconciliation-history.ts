import {
  ChannelReconcileViewSchema,
  ReconciliationHistoryInputSchema,
  ReconciliationHistoryViewSchema,
  ReconciliationDetailInputSchema,
  ReconciliationDetailViewSchema,
  ReconciliationReviewInputSchema,
  ReconciliationReviewViewSchema,
  type ReconciliationDifference,
} from "@laundry/contracts";
import type { SqlClient, TenantContext } from "../db/types.js";
import { channelAudit } from "./intent-store.js";
import { ChannelBusinessError } from "./settings.js";

type Batch = Readonly<{
  id: string;
  channel: "wechat" | "alipay";
  business_date: string;
  at: Date;
  source_sha256: string;
  matched_count: number;
  mismatch_count: number;
  mismatches_json: unknown;
}>;
const batchFields = `id,channel,business_date::text,at,source_sha256,matched_count,
  jsonb_array_length(mismatches_json)::int AS mismatch_count`;
const summary = (row: Batch) => ({
  reconciliation_id: row.id,
  channel: row.channel,
  business_date: row.business_date,
  created_at: row.at.toISOString(),
  source_sha256: row.source_sha256,
  matched_count: row.matched_count,
  mismatch_count: row.mismatch_count,
});

export async function listReconciliations(client: SqlClient, tenant: TenantContext, raw: unknown) {
  const input = ReconciliationHistoryInputSchema.parse(raw);
  const parameters = [
    tenant.orgId,
    tenant.storeId,
    input.channel ?? null,
    input.date_from ?? null,
    input.date_to ?? null,
  ];
  const where = `org_id=$1::uuid AND store_id=$2::uuid AND ($3::text IS NULL OR channel=$3)
    AND ($4::date IS NULL OR business_date >= $4::date) AND ($5::date IS NULL OR business_date <= $5::date)`;
  const count = await client.query<{ total: number }>(
    `SELECT count(*)::int AS total FROM payment_channel_reconciliations WHERE ${where}`,
    parameters,
  );
  const rows = await client.query<Batch>(
    `SELECT ${batchFields} FROM payment_channel_reconciliations WHERE ${where}
    ORDER BY business_date DESC,at DESC,id DESC LIMIT $6 OFFSET $7`,
    [...parameters, input.limit, input.offset],
  );
  return ReconciliationHistoryViewSchema.parse({
    rows: rows.rows.map(summary),
    total: count.rows[0]?.total ?? 0,
    offset: input.offset,
    limit: input.limit,
  });
}

export async function readReconciliation(client: SqlClient, tenant: TenantContext, raw: unknown) {
  const input = ReconciliationDetailInputSchema.parse(raw);
  const batch = (
    await client.query<Batch>(
      `SELECT ${batchFields},mismatches_json FROM payment_channel_reconciliations
    WHERE org_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid`,
      [tenant.orgId, tenant.storeId, input.reconciliation_id],
    )
  ).rows[0];
  if (!batch) throw new ChannelBusinessError("RESOURCE_UNAVAILABLE");
  const differences = ChannelReconcileViewSchema.shape.mismatches.parse(batch.mismatches_json);
  const slice = differences.slice(input.offset, input.offset + input.limit);
  const reviews = await client.query<{
    mismatch_index: number;
    state: "open" | "investigating" | "resolved";
    note: string;
    version: number;
    at: Date;
  }>(
    `SELECT mismatch_index,state,note,version,at FROM payment_channel_reconciliation_reviews
    WHERE org_id=$1::uuid AND store_id=$2::uuid AND reconciliation_id=$3::uuid AND mismatch_index >= $4 AND mismatch_index < $5`,
    [tenant.orgId, tenant.storeId, batch.id, input.offset, input.offset + input.limit],
  );
  const orders = await client.query<{ merchant_order: string; order_id: string | null }>(
    `SELECT merchant_order,order_id FROM payment_channel_intents
    WHERE org_id=$1::uuid AND store_id=$2::uuid AND channel=$3 AND merchant_order=ANY($4::text[])`,
    [tenant.orgId, tenant.storeId, batch.channel, slice.map((row) => row.merchant_order)],
  );
  const rows: ReconciliationDifference[] = slice.map((row, index) => {
    const review = reviews.rows.find((item) => item.mismatch_index === input.offset + index);
    return {
      ...row,
      index: input.offset + index,
      order_id:
        orders.rows.find((item) => item.merchant_order === row.merchant_order)?.order_id ?? null,
      review: review
        ? {
            state: review.state,
            note: review.note,
            version: review.version,
            reviewed_at: review.at.toISOString(),
          }
        : { state: "open", note: "", version: 0, reviewed_at: null },
    };
  });
  return ReconciliationDetailViewSchema.parse({
    summary: summary(batch),
    rows,
    offset: input.offset,
    limit: input.limit,
  });
}

/** The caller owns a transaction; the annotation and audit commit together. */
export async function reviewReconciliation(client: SqlClient, tenant: TenantContext, raw: unknown) {
  const input = ReconciliationReviewInputSchema.parse(raw);
  if (!tenant.staffId) throw new ChannelBusinessError("POLICY_DENIED");
  const batch = (
    await client.query<{ mismatch_count: number }>(
      `SELECT jsonb_array_length(mismatches_json)::int AS mismatch_count
    FROM payment_channel_reconciliations WHERE org_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid`,
      [tenant.orgId, tenant.storeId, input.reconciliation_id],
    )
  ).rows[0];
  if (!batch || input.index >= batch.mismatch_count)
    throw new ChannelBusinessError("RESOURCE_UNAVAILABLE");
  const parameters = [
    tenant.orgId,
    tenant.storeId,
    input.reconciliation_id,
    input.index,
    input.state,
    input.note,
    tenant.staffId,
  ];
  const saved =
    input.expected_version === 0
      ? await client.query<{ version: number; at: Date }>(
          `INSERT INTO payment_channel_reconciliation_reviews
        (org_id,store_id,reconciliation_id,mismatch_index,state,note,version,actor_id)
        VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,1,$7::uuid)
        ON CONFLICT(org_id,store_id,reconciliation_id,mismatch_index) DO NOTHING RETURNING version,at`,
          parameters,
        )
      : await client.query<{ version: number; at: Date }>(
          `UPDATE payment_channel_reconciliation_reviews
        SET state=$5,note=$6,version=version+1,actor_id=$7::uuid,at=statement_timestamp()
        WHERE org_id=$1::uuid AND store_id=$2::uuid AND reconciliation_id=$3::uuid AND mismatch_index=$4 AND version=$8
        RETURNING version,at`,
          [...parameters, input.expected_version],
        );
  const row = saved.rows[0];
  if (!row) throw new ChannelBusinessError("IDEMPOTENCY_CONFLICT");
  await channelAudit(
    client,
    tenant,
    "payment.channel.reconciliation.review",
    input.reconciliation_id,
    { mismatch_index: input.index, state: input.state, note: input.note, version: row.version },
    "payment_channel_reconciliation",
  );
  return ReconciliationReviewViewSchema.parse({
    reconciliation_id: input.reconciliation_id,
    index: input.index,
    review: {
      state: input.state,
      note: input.note,
      version: row.version,
      reviewed_at: row.at.toISOString(),
    },
  });
}
