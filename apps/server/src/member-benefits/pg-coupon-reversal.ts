import type { SqlClient, TenantContext } from "../db/types.js";
import type { CouponCancellationResult, CouponCancellationStoreInput } from "./types.js";

type ActiveRedemptionRow = Readonly<{
  redemption_id: string;
  asset_id: string;
}>;

export async function reversePgCouponForOrder(
  client: SqlClient,
  tenant: TenantContext,
  input: CouponCancellationStoreInput,
  newId: () => string,
): Promise<CouponCancellationResult> {
  const lockedOrder = await client.query<Readonly<{ id: string }>>(
    `SELECT id::text
       FROM orders
      WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
      FOR UPDATE`,
    [tenant.orgId, input.store_id, input.order_id],
  );
  if (lockedOrder.rows[0] === undefined) {
    return Object.freeze({ changed: false, asset_id: null, reversal_id: null });
  }
  const active = await client.query<ActiveRedemptionRow>(
    `SELECT redemption.id::text AS redemption_id, redemption.grant_id::text AS asset_id
       FROM coupon_redemptions redemption
       LEFT JOIN coupon_redemption_reversals reversal
         ON reversal.org_id = redemption.org_id
        AND reversal.redemption_id = redemption.id
      WHERE redemption.org_id = $1::uuid
        AND redemption.store_id = $2::uuid
        AND redemption.order_id = $3::uuid
        AND reversal.id IS NULL`,
    [tenant.orgId, input.store_id, input.order_id],
  );
  if (active.rows.length > 1) {
    throw new Error("Multiple active coupon redemptions exist for one order");
  }
  const redemption = active.rows[0];
  if (redemption === undefined) {
    return Object.freeze({ changed: false, asset_id: null, reversal_id: null });
  }
  const reversalId = newId();
  await client.query(
    `INSERT INTO coupon_redemption_reversals (
       id, org_id, store_id, redemption_id, grant_id, order_id,
       staff_id, at, reason
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
       $7::uuid, to_timestamp($8), $9
     )`,
    [
      reversalId,
      tenant.orgId,
      input.store_id,
      redemption.redemption_id,
      redemption.asset_id,
      input.order_id,
      input.staff_id,
      input.at,
      input.reason,
    ],
  );
  return Object.freeze({
    changed: true,
    asset_id: redemption.asset_id,
    reversal_id: reversalId,
  });
}
