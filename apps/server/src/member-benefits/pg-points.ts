import { randomUUID } from "node:crypto";

import type { SqlClient, TenantContext } from "../db/types.js";
import { addCalendarDays } from "./date.js";
import { benefitInteger, lockActiveBenefitAccount, rejectPgBenefit } from "./pg-support.js";
import { readPgMemberBenefits } from "./pg-view.js";
import type {
  BenefitMutationResult,
  MemberBenefitOutcome,
  PointsEarnStoreInput,
  PointsRedeemStoreInput,
} from "./types.js";

type OrderRow = Readonly<{
  customer_id: string | null;
  status: string;
  paid_cents: number | string;
  balance_cents: number | string;
}>;
type PolicyRow = Readonly<{
  id: string;
  unit_cents: number | string;
  points_per_unit: number | string;
  valid_days: number | string;
}>;

function computePoints(paidCents: number, unitCents: number, pointsPerUnit: number): number | null {
  const computed = (BigInt(paidCents) / BigInt(unitCents)) * BigInt(pointsPerUnit);
  return computed > 0n && computed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(computed) : null;
}

export async function earnPgPoints(
  client: SqlClient,
  tenant: TenantContext,
  input: PointsEarnStoreInput,
  newId: () => string = randomUUID,
): Promise<MemberBenefitOutcome<BenefitMutationResult>> {
  const account = await lockActiveBenefitAccount(client, tenant, input.account_id);
  if (!account.ok) return account;
  const existing = await client.query<Readonly<{ id: string; account_id: string }>>(
    `SELECT id::text, account_id::text FROM points_ledger
      WHERE org_id = $1::uuid AND order_id = $2::uuid AND kind = 'earn'`,
    [tenant.orgId, input.order_id],
  );
  if (existing.rows[0] !== undefined) {
    if (existing.rows[0].account_id !== input.account_id) {
      return rejectPgBenefit("order_customer_mismatch");
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
        entity_id: existing.rows[0].id,
        changed: false,
      }),
    });
  }

  const orderResult = await client.query<OrderRow>(
    `SELECT customer_id::text, status, paid_cents, balance_cents
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
  const paid = benefitInteger(order.paid_cents, "settled order paid cents");
  if (
    order.status !== "closed" ||
    benefitInteger(order.balance_cents, "settled order balance") !== 0 ||
    paid <= 0
  ) {
    return rejectPgBenefit("order_not_settled");
  }
  const policyResult = await client.query<PolicyRow>(
    `SELECT id::text, unit_cents, points_per_unit, valid_days
       FROM member_points_policies
      WHERE org_id = $1::uuid AND status = 'active'
      FOR SHARE`,
    [tenant.orgId],
  );
  const policy = policyResult.rows[0];
  if (policy === undefined) return rejectPgBenefit("points_policy_missing");
  const unit = benefitInteger(policy.unit_cents, "points unit");
  const rate = benefitInteger(policy.points_per_unit, "points rate");
  const points = computePoints(paid, unit, rate);
  if (points === null) return rejectPgBenefit("points_zero");
  const ledgerId = newId();
  await client.query(
    `INSERT INTO points_ledger (
       id, org_id, store_id, account_id, kind, points_delta, order_id,
       policy_id, source_paid_cents, policy_unit_cents,
       policy_points_per_unit, expires_on, staff_id, at, note
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'earn', $5::bigint, $6::uuid,
       $7::uuid, $8, $9, $10, $11::date, $12::uuid, to_timestamp($13), NULL
     )`,
    [
      ledgerId,
      tenant.orgId,
      input.store_id,
      input.account_id,
      points,
      input.order_id,
      policy.id,
      paid,
      unit,
      rate,
      addCalendarDays(input.business_date, benefitInteger(policy.valid_days, "points days")),
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
      entity_id: ledgerId,
      changed: true,
    }),
  });
}

export async function redeemPgPoints(
  client: SqlClient,
  tenant: TenantContext,
  input: PointsRedeemStoreInput,
  newId: () => string = randomUUID,
): Promise<MemberBenefitOutcome<BenefitMutationResult>> {
  const account = await lockActiveBenefitAccount(client, tenant, input.account_id);
  if (!account.ok) return account;
  const availableResult = await client.query<Readonly<{ available: number | string }>>(
    `SELECT COALESCE(SUM(GREATEST(earn.points_delta - COALESCE(used.points, 0), 0)), 0)::bigint AS available
       FROM points_ledger earn
       LEFT JOIN (
         SELECT earn_ledger_id, SUM(points)::bigint AS points
           FROM points_allocations WHERE org_id = $1::uuid GROUP BY earn_ledger_id
       ) used ON used.earn_ledger_id = earn.id
      WHERE earn.org_id = $1::uuid AND earn.account_id = $2::uuid
        AND earn.kind = 'earn' AND earn.expires_on >= $3::date`,
    [tenant.orgId, input.account_id, input.business_date],
  );
  const available = benefitInteger(availableResult.rows[0]?.available ?? 0, "available points");
  if (available < input.points) return rejectPgBenefit("insufficient_points");

  const redeemId = newId();
  await client.query(
    `INSERT INTO points_ledger (
       id, org_id, store_id, account_id, kind, points_delta,
       order_id, policy_id, source_paid_cents, policy_unit_cents,
       policy_points_per_unit, expires_on, staff_id, at, note
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'redeem', -$5::bigint,
       NULL, NULL, NULL, NULL, NULL, NULL, $6::uuid, to_timestamp($7), $8
     )`,
    [
      redeemId,
      tenant.orgId,
      input.store_id,
      input.account_id,
      input.points,
      input.staff_id,
      input.at,
      input.reason,
    ],
  );
  const allocations = await client.query<Readonly<{ points: number | string }>>(
    `WITH credits AS (
       SELECT earn.id,
              GREATEST(earn.points_delta - COALESCE(used.points, 0), 0)::bigint AS remaining,
              earn.expires_on,
              earn.at
         FROM points_ledger earn
         LEFT JOIN (
           SELECT earn_ledger_id, SUM(points)::bigint AS points
             FROM points_allocations WHERE org_id = $1::uuid GROUP BY earn_ledger_id
         ) used ON used.earn_ledger_id = earn.id
        WHERE earn.org_id = $1::uuid AND earn.account_id = $2::uuid
          AND earn.kind = 'earn' AND earn.expires_on >= $3::date
     ), running AS (
       SELECT id, remaining,
              COALESCE(SUM(remaining) OVER (
                ORDER BY expires_on ASC, at ASC, id ASC
                ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
              ), 0)::bigint AS prior
         FROM credits WHERE remaining > 0
     )
     INSERT INTO points_allocations (id, org_id, redeem_ledger_id, earn_ledger_id, points)
     SELECT md5($4::text || id::text)::uuid, $1::uuid, $4::uuid, id,
            LEAST(remaining, $5::bigint - prior)::integer
       FROM running
      WHERE prior < $5::bigint
      RETURNING points`,
    [tenant.orgId, input.account_id, input.business_date, redeemId, input.points],
  );
  const allocated = allocations.rows.reduce(
    (sum, row) => sum + benefitInteger(row.points, "point allocation"),
    0,
  );
  if (allocated !== input.points)
    throw new Error("Point allocation total changed under account lock");
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
      entity_id: redeemId,
      changed: true,
    }),
  });
}
