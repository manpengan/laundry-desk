import type {
  MarketingGroupBuyRedemption,
  MarketingGroupBuyRedemptionAuthority,
} from "@laundry/contracts";

import type { SqlClient, TenantContext } from "../db/types.js";
import { sameGroupBuyRedemptionAuthority } from "./extension-authority.js";
import type {
  MarketingExtensionRejectReason,
  MarketingExtensionStore,
  MarketingGroupBuyRedemptionAuthorityResult,
  MarketingGroupBuyRedemptionResult,
} from "./extension-types.js";
import { marketingInteger, marketingTimestamp } from "./pg-extension-support.js";

type VoucherRow = Readonly<{
  voucher_id: string;
  provider: "meituan" | "douyin" | "wechat" | "other";
  external_order_ref: string;
  code_digest: string;
  code_last4: string;
  label: string;
  face_value_cents: number | string;
  expires_at: Date | string;
  registered_at: Date | string;
}>;
type OrderRow = Readonly<{
  id: string;
  customer_id: string | null;
  status: string;
  original_cents: number | string;
  discount_cents: number | string;
  payable_cents: number | string;
  paid_cents: number | string;
}>;
type RedemptionRow = Readonly<{
  redemption_id: string;
  voucher_id: string;
  order_id: string;
  order_original_cents: number | string;
  order_payable_before_cents: number | string;
  applied_discount_cents: number | string;
  reason: string;
  redeemed_at: Date | string;
}>;

const failure = (reason: MarketingExtensionRejectReason) => Object.freeze({ ok: false, reason });

async function voucherByDigest(
  client: SqlClient,
  tenant: TenantContext,
  digest: string,
  lock: boolean,
): Promise<VoucherRow | null> {
  if (lock) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `marketing-group-buy:${tenant.orgId}:${tenant.storeId}:${digest}`,
    ]);
  }
  const result = await client.query<VoucherRow>(
    `SELECT id::text AS voucher_id, provider, external_order_ref, code_digest,
            code_last4, label, face_value_cents, expires_at, registered_at
       FROM group_buy_vouchers
      WHERE org_id=$1::uuid AND store_id=$2::uuid AND code_digest=$3`,
    [tenant.orgId, tenant.storeId, digest],
  );
  return result.rows[0] ?? null;
}

async function existingRedemption(
  client: SqlClient,
  tenant: TenantContext,
  voucherId: string,
): Promise<RedemptionRow | null> {
  const result = await client.query<RedemptionRow>(
    `SELECT id::text AS redemption_id, voucher_id::text, order_id::text,
            order_original_cents, order_payable_before_cents, applied_discount_cents, reason,
            redeemed_at
       FROM group_buy_redemptions
      WHERE org_id=$1::uuid AND store_id=$2::uuid AND voucher_id=$3::uuid`,
    [tenant.orgId, tenant.storeId, voucherId],
  );
  return result.rows[0] ?? null;
}

function redemptionAuthorityFrom(
  voucher: VoucherRow,
  orderId: string,
  originalCents: number,
  payableBeforeCents: number,
  appliedCents: number,
  reason: string,
): MarketingGroupBuyRedemptionAuthority {
  return Object.freeze({
    kind: "marketing_group_buy_redemption",
    voucher_id: voucher.voucher_id,
    code_digest: voucher.code_digest,
    code_last4: voucher.code_last4,
    provider: voucher.provider,
    external_order_ref: voucher.external_order_ref,
    label: voucher.label,
    face_value_cents: marketingInteger(voucher.face_value_cents, "voucher face value"),
    expires_at: marketingTimestamp(voucher.expires_at, "voucher expiry"),
    order_id: orderId,
    order_original_cents: originalCents,
    order_payable_before_cents: payableBeforeCents,
    applied_discount_cents: appliedCents,
    reason,
  });
}

async function resolveRedemptionAuthority(
  client: SqlClient,
  tenant: TenantContext,
  input: Parameters<MarketingExtensionStore["previewGroupBuyRedemption"]>[2],
  lock: boolean,
): Promise<MarketingGroupBuyRedemptionAuthorityResult> {
  const voucher = await voucherByDigest(client, tenant, input.voucher_code_digest, lock);
  if (voucher === null) return failure("missing");
  const prior = await existingRedemption(client, tenant, voucher.voucher_id);
  if (prior !== null) {
    if (prior.order_id !== input.order_id || prior.reason !== input.reason) {
      return failure("voucher_redeemed");
    }
    return Object.freeze({
      ok: true,
      authority: redemptionAuthorityFrom(
        voucher,
        prior.order_id,
        marketingInteger(prior.order_original_cents, "order original"),
        marketingInteger(prior.order_payable_before_cents, "order payable before"),
        marketingInteger(prior.applied_discount_cents, "group-buy discount"),
        input.reason,
      ),
    });
  }
  if (new Date(voucher.expires_at) <= input.at) return failure("voucher_expired");
  const orderResult = await client.query<OrderRow>(
    `SELECT id::text, customer_id::text, status, original_cents, discount_cents,
            payable_cents, paid_cents
       FROM orders WHERE org_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
      ${lock ? "FOR UPDATE" : ""}`,
    [tenant.orgId, tenant.storeId, input.order_id],
  );
  const order = orderResult.rows[0];
  if (
    order === undefined ||
    order.customer_id === null ||
    order.status !== "open" ||
    marketingInteger(order.paid_cents, "order paid") !== 0 ||
    marketingInteger(order.discount_cents, "order discount") !== 0
  ) {
    return failure("order_invalid");
  }
  const original = marketingInteger(order.original_cents, "order original");
  const payable = marketingInteger(order.payable_cents, "order payable");
  const applied = Math.min(
    marketingInteger(voucher.face_value_cents, "voucher face value"),
    original,
  );
  if (applied <= 0 || applied > payable) return failure("order_invalid");
  return Object.freeze({
    ok: true,
    authority: redemptionAuthorityFrom(voucher, order.id, original, payable, applied, input.reason),
  });
}

function wireRedemption(
  voucher: VoucherRow,
  row: RedemptionRow,
  replayed: boolean,
): MarketingGroupBuyRedemption {
  return Object.freeze({
    redemption_id: row.redemption_id,
    voucher_id: row.voucher_id,
    provider: voucher.provider,
    external_order_ref: voucher.external_order_ref,
    code_last4: voucher.code_last4,
    order_id: row.order_id,
    face_value_cents: marketingInteger(voucher.face_value_cents, "voucher face value"),
    applied_discount_cents: marketingInteger(row.applied_discount_cents, "group-buy discount"),
    redeemed_at: marketingTimestamp(row.redeemed_at, "group-buy redemption"),
    replayed,
  });
}

async function redeemVoucher(
  client: SqlClient,
  tenant: TenantContext,
  input: Parameters<MarketingExtensionStore["redeemGroupBuyVoucher"]>[2],
  newId: () => string,
): Promise<MarketingGroupBuyRedemptionResult> {
  const resolved = await resolveRedemptionAuthority(client, tenant, input, true);
  if (!resolved.ok) return resolved;
  const voucher = await voucherByDigest(client, tenant, resolved.authority.code_digest, true);
  if (voucher === null) return failure("missing");
  const prior = await existingRedemption(client, tenant, voucher.voucher_id);
  if (prior !== null) {
    if (!sameGroupBuyRedemptionAuthority(resolved.authority, input.frozenAuthority)) {
      return failure("authority_drift");
    }
    return Object.freeze({ ok: true, redemption: wireRedemption(voucher, prior, true) });
  }
  if (!sameGroupBuyRedemptionAuthority(resolved.authority, input.frozenAuthority)) {
    return failure("authority_drift");
  }
  const updated = await client.query(
    `UPDATE orders SET discount_cents=$4, discount_source='manual',
            payable_cents=payable_cents-$4, balance_cents=balance_cents-$4,
            updated_at=$5::timestamptz
      WHERE org_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
        AND status='open' AND paid_cents=0 AND discount_cents=0
        AND original_cents=$6 AND payable_cents=$7 AND balance_cents=payable_cents
        AND payable_cents >= $4`,
    [
      tenant.orgId,
      tenant.storeId,
      input.order_id,
      resolved.authority.applied_discount_cents,
      input.at.toISOString(),
      resolved.authority.order_original_cents,
      resolved.authority.order_payable_before_cents,
    ],
  );
  if (updated.rowCount !== 1) return failure("order_invalid");
  const inserted = await client.query<RedemptionRow>(
    `INSERT INTO group_buy_redemptions
       (id, org_id, store_id, voucher_id, order_id, order_original_cents,
        order_payable_before_cents, applied_discount_cents, reason,
        redeemed_by_staff_id, redeemed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING id::text AS redemption_id, voucher_id::text, order_id::text,
       order_original_cents, order_payable_before_cents, applied_discount_cents, reason,
       redeemed_at`,
    [
      newId(),
      tenant.orgId,
      tenant.storeId,
      voucher.voucher_id,
      input.order_id,
      resolved.authority.order_original_cents,
      resolved.authority.order_payable_before_cents,
      resolved.authority.applied_discount_cents,
      input.reason,
      tenant.staffId,
      input.at.toISOString(),
    ],
  );
  const row = inserted.rows[0];
  if (row === undefined) throw new Error("group-buy redemption insert returned no row");
  return Object.freeze({ ok: true, redemption: wireRedemption(voucher, row, false) });
}

export function createPgMarketingGroupBuyRedemptionOperations(
  newId: () => string,
): Pick<MarketingExtensionStore, "previewGroupBuyRedemption" | "redeemGroupBuyVoucher"> {
  return Object.freeze({
    previewGroupBuyRedemption: (client, tenant, input) =>
      resolveRedemptionAuthority(client, tenant, input, false),
    redeemGroupBuyVoucher: (client, tenant, input) => redeemVoucher(client, tenant, input, newId),
  });
}
