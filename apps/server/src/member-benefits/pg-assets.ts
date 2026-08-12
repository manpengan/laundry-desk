import { randomUUID } from "node:crypto";

import type { SqlClient, TenantContext } from "../db/types.js";
import { addCalendarDays, isExpiredOn } from "./date.js";
import {
  benefitDate,
  benefitInteger,
  lockActiveBenefitAccount,
  rejectPgBenefit,
} from "./pg-support.js";
import { readPgMemberBenefits } from "./pg-view.js";
import type {
  AssetGrantStoreInput,
  BenefitMutationResult,
  CouponConsumeStoreInput,
  MemberBenefitOutcome,
  PunchConsumeStoreInput,
} from "./types.js";

type PunchDefinitionRow = Readonly<{
  id: string;
  code: string;
  name: string;
  total_uses: number | string;
  valid_days: number | string;
  status: string;
}>;
type CouponDefinitionRow = Readonly<{
  id: string;
  code: string;
  name: string;
  discount_cents: number | string;
  min_order_cents: number | string;
  valid_days: number | string;
  status: string;
}>;
type PunchCardRow = Readonly<{
  account_id: string;
  total_uses: number | string;
  expires_on: Date | string;
}>;
type CouponGrantRow = Readonly<{
  account_id: string;
  discount_cents: number | string;
  min_order_cents: number | string;
  expires_on: Date | string;
}>;

export async function grantPgAsset(
  client: SqlClient,
  tenant: TenantContext,
  input: AssetGrantStoreInput,
  newId: () => string = randomUUID,
): Promise<MemberBenefitOutcome<BenefitMutationResult>> {
  const account = await lockActiveBenefitAccount(client, tenant, input.account_id);
  if (!account.ok) return account;
  const assetId = newId();
  if (input.asset_kind === "punch") {
    const definitionResult = await client.query<PunchDefinitionRow>(
      `SELECT id::text, code, name, total_uses, valid_days, status
         FROM member_punch_types
        WHERE org_id = $1::uuid AND id = $2::uuid
        FOR SHARE`,
      [tenant.orgId, input.definition_id],
    );
    const definition = definitionResult.rows[0];
    if (definition === undefined) return rejectPgBenefit("definition_not_found");
    if (definition.status !== "active") return rejectPgBenefit("definition_retired");
    await client.query(
      `INSERT INTO punch_cards (
         id, org_id, account_id, definition_id, code, name, total_uses,
         issued_on, expires_on, issued_at, issued_store_id,
         issued_by_staff_id, reason
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7,
         $8::date, $9::date, to_timestamp($10), $11::uuid, $12::uuid, $13
       )`,
      [
        assetId,
        tenant.orgId,
        input.account_id,
        definition.id,
        definition.code,
        definition.name,
        benefitInteger(definition.total_uses, "punch uses"),
        input.business_date,
        addCalendarDays(input.business_date, benefitInteger(definition.valid_days, "punch days")),
        input.at,
        input.store_id,
        input.staff_id,
        input.reason,
      ],
    );
  } else {
    const definitionResult = await client.query<CouponDefinitionRow>(
      `SELECT id::text, code, name, discount_cents, min_order_cents, valid_days, status
         FROM coupons
        WHERE org_id = $1::uuid AND id = $2::uuid
        FOR SHARE`,
      [tenant.orgId, input.definition_id],
    );
    const definition = definitionResult.rows[0];
    if (definition === undefined) return rejectPgBenefit("definition_not_found");
    if (definition.status !== "active") return rejectPgBenefit("definition_retired");
    await client.query(
      `INSERT INTO coupon_grants (
         id, org_id, account_id, definition_id, code, name,
         discount_cents, min_order_cents, granted_on, expires_on,
         granted_at, granted_store_id, granted_by_staff_id, reason
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6,
         $7, $8, $9::date, $10::date,
         to_timestamp($11), $12::uuid, $13::uuid, $14
       )`,
      [
        assetId,
        tenant.orgId,
        input.account_id,
        definition.id,
        definition.code,
        definition.name,
        benefitInteger(definition.discount_cents, "coupon discount"),
        benefitInteger(definition.min_order_cents, "coupon minimum"),
        input.business_date,
        addCalendarDays(input.business_date, benefitInteger(definition.valid_days, "coupon days")),
        input.at,
        input.store_id,
        input.staff_id,
        input.reason,
      ],
    );
  }
  return Object.freeze({
    ok: true as const,
    value: Object.freeze({
      benefits: await readPgMemberBenefits(
        client,
        tenant,
        account.value,
        input.business_date,
        true,
      ),
      entity_id: assetId,
      changed: true,
    }),
  });
}

export async function consumePgPunch(
  client: SqlClient,
  tenant: TenantContext,
  input: PunchConsumeStoreInput,
  newId: () => string = randomUUID,
): Promise<MemberBenefitOutcome<BenefitMutationResult>> {
  const owner = await client.query<Readonly<{ account_id: string }>>(
    `SELECT account_id::text FROM punch_cards
      WHERE org_id = $1::uuid AND id = $2::uuid`,
    [tenant.orgId, input.asset_id],
  );
  if (owner.rows[0] === undefined) return rejectPgBenefit("asset_not_found");
  const account = await lockActiveBenefitAccount(client, tenant, owner.rows[0].account_id);
  if (!account.ok) return account;
  // The account row is the serialization anchor for every asset on this
  // account. Issued cards stay physically append-only, so they need no UPDATE
  // grant merely to obtain a second row lock.
  const cardResult = await client.query<PunchCardRow>(
    `SELECT account_id::text, total_uses, expires_on
       FROM punch_cards
      WHERE org_id = $1::uuid AND id = $2::uuid`,
    [tenant.orgId, input.asset_id],
  );
  const card = cardResult.rows[0];
  if (card === undefined) return rejectPgBenefit("asset_not_found");
  if (isExpiredOn(benefitDate(card.expires_on, "punch expiry"), input.business_date)) {
    return rejectPgBenefit("asset_expired");
  }
  const usedResult = await client.query<Readonly<{ used: number | string }>>(
    `SELECT COALESCE(SUM(uses), 0)::bigint AS used
       FROM punch_card_ledger
      WHERE org_id = $1::uuid AND card_id = $2::uuid`,
    [tenant.orgId, input.asset_id],
  );
  const used = benefitInteger(usedResult.rows[0]?.used ?? 0, "punch used");
  if (used + input.uses > benefitInteger(card.total_uses, "punch total")) {
    return rejectPgBenefit("insufficient_uses");
  }
  const ledgerId = newId();
  await client.query(
    `INSERT INTO punch_card_ledger (
       id, org_id, store_id, card_id, account_id, uses, staff_id, at, reason
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7::uuid, to_timestamp($8), $9
     )`,
    [
      ledgerId,
      tenant.orgId,
      input.store_id,
      input.asset_id,
      account.value.account_id,
      input.uses,
      input.staff_id,
      input.at,
      input.reason,
    ],
  );
  return Object.freeze({
    ok: true as const,
    value: Object.freeze({
      benefits: await readPgMemberBenefits(
        client,
        tenant,
        account.value,
        input.business_date,
        true,
      ),
      entity_id: ledgerId,
      changed: true,
    }),
  });
}

type CouponOrderRow = Readonly<{
  customer_id: string | null;
  status: string;
  original_cents: number | string;
  discount_cents: number | string;
  payable_cents: number | string;
  paid_cents: number | string;
}>;

export async function consumePgCoupon(
  client: SqlClient,
  tenant: TenantContext,
  input: CouponConsumeStoreInput,
  newId: () => string = randomUUID,
): Promise<MemberBenefitOutcome<BenefitMutationResult>> {
  const owner = await client.query<Readonly<{ account_id: string }>>(
    `SELECT account_id::text FROM coupon_grants
      WHERE org_id = $1::uuid AND id = $2::uuid`,
    [tenant.orgId, input.asset_id],
  );
  if (owner.rows[0] === undefined) return rejectPgBenefit("asset_not_found");
  const account = await lockActiveBenefitAccount(client, tenant, owner.rows[0].account_id);
  if (!account.ok) return account;
  // The account lock above serializes concurrent redemption. The immutable
  // grant remains SELECT-only; the order itself is locked before it changes.
  const grantResult = await client.query<CouponGrantRow>(
    `SELECT account_id::text, discount_cents, min_order_cents, expires_on
       FROM coupon_grants
      WHERE org_id = $1::uuid AND id = $2::uuid`,
    [tenant.orgId, input.asset_id],
  );
  const grant = grantResult.rows[0];
  if (grant === undefined) return rejectPgBenefit("asset_not_found");
  if (isExpiredOn(benefitDate(grant.expires_on, "coupon expiry"), input.business_date)) {
    return rejectPgBenefit("asset_expired");
  }
  const redeemed = await client.query(
    `SELECT 1
       FROM coupon_redemptions redemption
       LEFT JOIN coupon_redemption_reversals reversal
         ON reversal.org_id = redemption.org_id
        AND reversal.redemption_id = redemption.id
      WHERE redemption.org_id = $1::uuid
        AND redemption.grant_id = $2::uuid
        AND reversal.id IS NULL`,
    [tenant.orgId, input.asset_id],
  );
  if (redeemed.rows.length > 0) return rejectPgBenefit("coupon_already_redeemed");
  const orderResult = await client.query<CouponOrderRow>(
    `SELECT customer_id::text, status, original_cents, discount_cents,
            payable_cents, paid_cents
       FROM orders
      WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
      FOR UPDATE`,
    [tenant.orgId, input.store_id, input.order_id],
  );
  const order = orderResult.rows[0];
  if (order === undefined) return rejectPgBenefit("order_not_found");
  if (order.customer_id !== account.value.customer_id) {
    return rejectPgBenefit("order_customer_mismatch");
  }
  if (benefitInteger(order.discount_cents, "order discount") !== 0) {
    return rejectPgBenefit("coupon_order_already_discounted");
  }
  const original = benefitInteger(order.original_cents, "order original amount");
  if (
    order.status !== "open" ||
    benefitInteger(order.paid_cents, "order paid amount") !== 0 ||
    original < benefitInteger(grant.min_order_cents, "coupon minimum")
  ) {
    return rejectPgBenefit("coupon_order_invalid");
  }
  const discount = Math.min(benefitInteger(grant.discount_cents, "coupon discount"), original);
  if (discount <= 0 || discount > benefitInteger(order.payable_cents, "order payable")) {
    return rejectPgBenefit("coupon_order_invalid");
  }
  const updated = await client.query(
    `UPDATE orders
        SET discount_cents = $4,
            payable_cents = payable_cents - $4,
            balance_cents = balance_cents - $4,
            updated_at = to_timestamp($5)
      WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
        AND status = 'open' AND paid_cents = 0 AND discount_cents = 0
        AND customer_id = $6::uuid AND original_cents >= $7`,
    [
      tenant.orgId,
      input.store_id,
      input.order_id,
      discount,
      input.at,
      account.value.customer_id,
      benefitInteger(grant.min_order_cents, "coupon minimum"),
    ],
  );
  if (updated.rowCount !== 1) return rejectPgBenefit("coupon_order_invalid");
  const redemptionId = newId();
  await client.query(
    `INSERT INTO coupon_redemptions (
       id, org_id, store_id, grant_id, account_id, order_id,
       discount_cents, staff_id, at
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
       $7, $8::uuid, to_timestamp($9)
     )`,
    [
      redemptionId,
      tenant.orgId,
      input.store_id,
      input.asset_id,
      account.value.account_id,
      input.order_id,
      discount,
      input.staff_id,
      input.at,
    ],
  );
  return Object.freeze({
    ok: true as const,
    value: Object.freeze({
      benefits: await readPgMemberBenefits(
        client,
        tenant,
        account.value,
        input.business_date,
        true,
      ),
      entity_id: redemptionId,
      changed: true,
    }),
  });
}
