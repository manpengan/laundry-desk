import type { SqlClient, TenantContext } from "../db/types.js";
import { benefitDate, benefitEpoch, benefitInteger, type BenefitAccount } from "./pg-support.js";
import type { MemberBenefitsView } from "./types.js";

type MembershipRow = Readonly<{
  version: number | string;
  tier_id: string | null;
  tier_code: string | null;
  tier_name: string | null;
  tier_level: number | string | null;
  tier_discount_bps: number | string | null;
  valid_until: Date | string | null;
}>;
type PointsRow = Readonly<{
  id: string;
  kind: string;
  points_delta: number | string;
  order_id: string | null;
  expires_on: Date | string | null;
  at: Date | string;
  note: string | null;
}>;
type PunchRow = Readonly<{
  id: string;
  definition_id: string;
  code: string;
  name: string;
  total_uses: number | string;
  used_uses: number | string;
  issued_on: Date | string;
  expires_on: Date | string;
}>;
type CouponRow = Readonly<{
  id: string;
  definition_id: string;
  code: string;
  name: string;
  discount_cents: number | string;
  min_order_cents: number | string;
  granted_on: Date | string;
  expires_on: Date | string;
  redeemed_order_id: string | null;
}>;

function membershipView(row: MembershipRow | undefined, businessDate: string) {
  if (row === undefined || row.tier_id === null) {
    return Object.freeze({
      version: row === undefined ? 0 : benefitInteger(row.version, "membership version"),
      tier: null,
      valid_until: null,
      status: "unassigned" as const,
    });
  }
  if (
    row.tier_code === null ||
    row.tier_name === null ||
    row.tier_level === null ||
    row.tier_discount_bps === null ||
    row.valid_until === null
  ) {
    throw new Error("Membership tier snapshot is incomplete");
  }
  const validUntil = benefitDate(row.valid_until, "membership validity");
  return Object.freeze({
    version: benefitInteger(row.version, "membership version"),
    tier: Object.freeze({
      definition_id: row.tier_id,
      code: row.tier_code,
      name: row.tier_name,
      level: benefitInteger(row.tier_level, "membership tier level"),
      discount_bps: benefitInteger(row.tier_discount_bps, "membership tier discount"),
    }),
    valid_until: validUntil,
    status: validUntil < businessDate ? ("expired" as const) : ("active" as const),
  });
}

export async function readPgMemberBenefits(
  client: SqlClient,
  tenant: TenantContext,
  account: BenefitAccount,
  businessDate: string,
  includeExpired: boolean,
): Promise<MemberBenefitsView> {
  const membership = await client.query<MembershipRow>(
    `SELECT version, tier_id::text, tier_code, tier_name, tier_level,
            tier_discount_bps, valid_until
       FROM member_memberships
      WHERE org_id = $1::uuid AND account_id = $2::uuid`,
    [tenant.orgId, account.account_id],
  );
  const pointTotals = await client.query<
    Readonly<{ available: number | string; lifetime: number | string }>
  >(
    `SELECT
       COALESCE(SUM(
         CASE WHEN earn.expires_on >= $3::date
           THEN GREATEST(earn.points_delta - COALESCE(allocated.points, 0), 0)
           ELSE 0 END
       ), 0)::bigint AS available,
       COALESCE(SUM(earn.points_delta), 0)::bigint AS lifetime
     FROM points_ledger earn
     LEFT JOIN (
       SELECT earn_ledger_id, SUM(points)::bigint AS points
         FROM points_allocations
        WHERE org_id = $1::uuid
        GROUP BY earn_ledger_id
     ) allocated ON allocated.earn_ledger_id = earn.id
     WHERE earn.org_id = $1::uuid AND earn.account_id = $2::uuid AND earn.kind = 'earn'`,
    [tenant.orgId, account.account_id, businessDate],
  );
  const recentPoints = await client.query<PointsRow>(
    `SELECT id::text, kind, points_delta, order_id::text,
            expires_on, at, note
       FROM points_ledger
      WHERE org_id = $1::uuid AND account_id = $2::uuid
      ORDER BY at DESC, id DESC
      LIMIT 50`,
    [tenant.orgId, account.account_id],
  );
  const punches = await client.query<PunchRow>(
    `SELECT card.id::text, card.definition_id::text, card.code, card.name,
            card.total_uses, COALESCE(SUM(usage.uses), 0)::bigint AS used_uses,
            card.issued_on, card.expires_on
       FROM punch_cards card
       LEFT JOIN punch_card_ledger usage
         ON usage.org_id = card.org_id AND usage.card_id = card.id
      WHERE card.org_id = $1::uuid AND card.account_id = $2::uuid
      GROUP BY card.id
      HAVING $4::boolean
        OR (card.expires_on >= $3::date AND COALESCE(SUM(usage.uses), 0) < card.total_uses)
      ORDER BY card.expires_on ASC, card.issued_at DESC
      LIMIT 50`,
    [tenant.orgId, account.account_id, businessDate, includeExpired],
  );
  const coupons = await client.query<CouponRow>(
    `SELECT grant_row.id::text, grant_row.definition_id::text,
            grant_row.code, grant_row.name, grant_row.discount_cents,
            grant_row.min_order_cents, grant_row.granted_on, grant_row.expires_on,
            redemption.order_id::text AS redeemed_order_id
       FROM coupon_grants grant_row
       LEFT JOIN coupon_redemptions redemption
         ON redemption.org_id = grant_row.org_id
        AND redemption.grant_id = grant_row.id
        AND NOT EXISTS (
          SELECT 1 FROM coupon_redemption_reversals reversal
           WHERE reversal.org_id = redemption.org_id
             AND reversal.redemption_id = redemption.id
        )
      WHERE grant_row.org_id = $1::uuid AND grant_row.account_id = $2::uuid
        AND ($4::boolean OR (grant_row.expires_on >= $3::date AND redemption.id IS NULL))
      ORDER BY grant_row.expires_on ASC, grant_row.granted_at DESC
      LIMIT 50`,
    [tenant.orgId, account.account_id, businessDate, includeExpired],
  );

  const totals = pointTotals.rows[0] ?? { available: 0, lifetime: 0 };
  return Object.freeze({
    account_id: account.account_id,
    customer_id: account.customer_id,
    account_status: account.status,
    membership: membershipView(membership.rows[0], businessDate),
    points: Object.freeze({
      available_points: benefitInteger(totals.available, "available points"),
      lifetime_earned_points: benefitInteger(totals.lifetime, "lifetime points"),
      recent: Object.freeze(
        recentPoints.rows.map((row) => {
          if (row.kind !== "earn" && row.kind !== "redeem")
            throw new Error(`Unknown points kind: ${row.kind}`);
          return Object.freeze({
            ledger_id: row.id,
            kind: row.kind,
            points_delta: benefitInteger(row.points_delta, "points delta"),
            order_id: row.order_id,
            expires_on:
              row.expires_on === null ? null : benefitDate(row.expires_on, "points expiry"),
            at: benefitEpoch(row.at, "points timestamp"),
            note: row.note,
          });
        }),
      ),
    }),
    punch_cards: Object.freeze(
      punches.rows.map((row) => {
        const total = benefitInteger(row.total_uses, "punch total");
        const used = benefitInteger(row.used_uses, "punch used");
        const expires = benefitDate(row.expires_on, "punch expiry");
        const remaining = total - used;
        return Object.freeze({
          asset_id: row.id,
          definition_id: row.definition_id,
          code: row.code,
          name: row.name,
          total_uses: total,
          used_uses: used,
          remaining_uses: remaining,
          issued_on: benefitDate(row.issued_on, "punch issue date"),
          expires_on: expires,
          status:
            remaining === 0
              ? ("exhausted" as const)
              : expires < businessDate
                ? ("expired" as const)
                : ("active" as const),
        });
      }),
    ),
    coupons: Object.freeze(
      coupons.rows.map((row) => {
        const expires = benefitDate(row.expires_on, "coupon expiry");
        return Object.freeze({
          asset_id: row.id,
          definition_id: row.definition_id,
          code: row.code,
          name: row.name,
          discount_cents: benefitInteger(row.discount_cents, "coupon discount"),
          min_order_cents: benefitInteger(row.min_order_cents, "coupon minimum"),
          granted_on: benefitDate(row.granted_on, "coupon grant date"),
          expires_on: expires,
          status:
            row.redeemed_order_id !== null
              ? ("redeemed" as const)
              : expires < businessDate
                ? ("expired" as const)
                : ("active" as const),
          redeemed_order_id: row.redeemed_order_id,
        });
      }),
    ),
  });
}
