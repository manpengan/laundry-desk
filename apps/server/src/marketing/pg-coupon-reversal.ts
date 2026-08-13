import type { SqlClient, TenantContext } from "../db/types.js";
import { sameCouponReversalAuthority } from "./coupon-authority.js";
import type {
  MarketingCouponReversalPreviewResult,
  MarketingCouponReversalResult,
  MarketingCouponReversalStoreInput,
} from "./types.js";

type RedemptionRow = Readonly<{
  redemption_id: string;
  grant_id: string;
  order_id: string;
  discount_cents: number | string;
  campaign_grant_id: string | null;
  reversal_id: string | null;
  reversal_at: Date | string | null;
  order_status: string;
  paid_cents: number | string;
  order_discount_cents: number | string;
}>;

function integer(value: number | string, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} must be a safe integer`);
  return parsed;
}

function timestamp(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error("invalid coupon reversal timestamp");
  return parsed.toISOString();
}

async function readRedemption(
  client: SqlClient,
  tenant: TenantContext,
  redemptionId: string,
): Promise<RedemptionRow | null> {
  const result = await client.query<RedemptionRow>(
    `SELECT redemption.id::text AS redemption_id, redemption.grant_id::text,
            redemption.order_id::text, redemption.discount_cents,
            campaign_grant.id::text AS campaign_grant_id,
            reversal.id::text AS reversal_id, reversal.at AS reversal_at,
            order_row.status AS order_status, order_row.paid_cents,
            order_row.discount_cents AS order_discount_cents
       FROM coupon_redemptions redemption
       JOIN orders order_row ON order_row.org_id=redemption.org_id
        AND order_row.store_id=redemption.store_id AND order_row.id=redemption.order_id
       LEFT JOIN campaign_coupon_grants campaign_grant
         ON campaign_grant.org_id=redemption.org_id
        AND campaign_grant.store_id=redemption.store_id
        AND campaign_grant.coupon_grant_id=redemption.grant_id
       LEFT JOIN coupon_redemption_reversals reversal
         ON reversal.org_id=redemption.org_id AND reversal.redemption_id=redemption.id
      WHERE redemption.org_id=$1::uuid AND redemption.store_id=$2::uuid
        AND redemption.id=$3::uuid`,
    [tenant.orgId, tenant.storeId, redemptionId],
  );
  return result.rows[0] ?? null;
}

function previewFrom(row: RedemptionRow | null): MarketingCouponReversalPreviewResult {
  if (row === null) return Object.freeze({ ok: false, reason: "redemption_missing" });
  if (row.campaign_grant_id === null) {
    return Object.freeze({ ok: false, reason: "not_campaign_coupon" });
  }
  const discount = integer(row.discount_cents, "redemption discount");
  if (
    row.reversal_id === null &&
    (row.order_status !== "open" ||
      integer(row.paid_cents, "order paid") !== 0 ||
      integer(row.order_discount_cents, "order discount") !== discount)
  ) {
    return Object.freeze({ ok: false, reason: "order_invalid" });
  }
  return Object.freeze({
    ok: true,
    preview: Object.freeze({
      redemptionId: row.redemption_id,
      grantId: row.grant_id,
      orderId: row.order_id,
      discountCents: discount,
      alreadyReversed: row.reversal_id !== null,
    }),
  });
}

export async function previewPgMarketingCouponRedemption(
  client: SqlClient,
  tenant: TenantContext,
  redemptionId: string,
): Promise<MarketingCouponReversalPreviewResult> {
  return previewFrom(await readRedemption(client, tenant, redemptionId));
}

export async function reversePgMarketingCouponRedemption(
  client: SqlClient,
  tenant: TenantContext,
  input: MarketingCouponReversalStoreInput,
  newId: () => string,
): Promise<MarketingCouponReversalResult> {
  const locked = await client.query<Readonly<{ id: string }>>(
    `SELECT order_row.id::text
       FROM coupon_redemptions redemption
       JOIN orders order_row ON order_row.org_id=redemption.org_id
        AND order_row.store_id=redemption.store_id AND order_row.id=redemption.order_id
      WHERE redemption.org_id=$1::uuid AND redemption.store_id=$2::uuid
        AND redemption.id=$3::uuid FOR UPDATE OF order_row`,
    [tenant.orgId, tenant.storeId, input.redemptionId],
  );
  if (locked.rows[0] === undefined) {
    return Object.freeze({ ok: false, reason: "redemption_missing" });
  }
  const row = await readRedemption(client, tenant, input.redemptionId);
  const current = previewFrom(row);
  if (!current.ok) return current;
  if (!sameCouponReversalAuthority(input, current.preview, input.frozenAuthority)) {
    return Object.freeze({ ok: false, reason: "authority_drift" });
  }
  if (row === null) throw new Error("validated coupon redemption disappeared");
  const discount = current.preview.discountCents;
  if (row.reversal_id !== null) {
    return Object.freeze({
      ok: true,
      reversal: Object.freeze({
        reversal_id: row.reversal_id,
        redemption_id: row.redemption_id,
        grant_id: row.grant_id,
        order_id: row.order_id,
        reversed_discount_cents: discount,
        changed: false,
        at: timestamp(row.reversal_at ?? input.at),
      }),
    });
  }
  const updated = await client.query(
    `UPDATE orders SET discount_cents=0, payable_cents=payable_cents+$4,
            balance_cents=balance_cents+$4, updated_at=$5::timestamptz
      WHERE org_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
        AND status='open' AND paid_cents=0 AND discount_cents=$4`,
    [tenant.orgId, tenant.storeId, row.order_id, discount, input.at.toISOString()],
  );
  if (updated.rowCount !== 1) return Object.freeze({ ok: false, reason: "order_invalid" });
  const reversalId = newId();
  const inserted = await client.query<Readonly<{ at: Date | string }>>(
    `INSERT INTO coupon_redemption_reversals
       (id, org_id, store_id, redemption_id, grant_id, order_id, staff_id, at, reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING at`,
    [
      reversalId,
      tenant.orgId,
      tenant.storeId,
      row.redemption_id,
      row.grant_id,
      row.order_id,
      tenant.staffId,
      input.at.toISOString(),
      input.reason,
    ],
  );
  return Object.freeze({
    ok: true,
    reversal: Object.freeze({
      reversal_id: reversalId,
      redemption_id: row.redemption_id,
      grant_id: row.grant_id,
      order_id: row.order_id,
      reversed_discount_cents: discount,
      changed: true,
      at: timestamp(inserted.rows[0]?.at ?? input.at),
    }),
  });
}
