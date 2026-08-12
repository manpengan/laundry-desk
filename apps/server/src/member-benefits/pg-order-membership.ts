import type { SqlClient, TenantContext } from "../db/types.js";
import { benefitInteger } from "./pg-support.js";
import type { OrderMembershipPolicySnapshot } from "./types.js";

type OrderMembershipRow = Readonly<{
  version: number | string;
  tier_id: string | null;
  tier_code: string | null;
  tier_name: string | null;
  tier_level: number | string | null;
  tier_definition_version: number | string | null;
  tier_discount_bps: number | string | null;
  valid_until: Date | string | null;
}>;

function date(value: Date | string): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value.slice(0, 10);
}

export async function readPgOrderMembership(
  client: SqlClient,
  tenant: TenantContext,
  customerId: string,
  businessDate: string,
): Promise<OrderMembershipPolicySnapshot | null> {
  const result = await client.query<OrderMembershipRow>(
    `SELECT membership.version, membership.tier_id::text, membership.tier_code,
            membership.tier_name, membership.tier_level,
            membership.tier_definition_version, membership.tier_discount_bps,
            membership.valid_until
       FROM member_accounts account
       JOIN member_memberships membership
         ON membership.org_id = account.org_id AND membership.account_id = account.id
      WHERE account.org_id = $1::uuid AND account.customer_id = $2::uuid
        AND account.status = 'active'
      FOR SHARE OF account, membership`,
    [tenant.orgId, customerId],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  const activeTier =
    row.tier_id !== null && row.valid_until !== null && date(row.valid_until) >= businessDate;
  if (!activeTier) {
    return Object.freeze({
      version: benefitInteger(row.version, "membership version"),
      tier: null,
    });
  }
  if (
    row.tier_code === null ||
    row.tier_name === null ||
    row.tier_level === null ||
    row.tier_definition_version === null ||
    row.tier_discount_bps === null
  ) {
    throw new Error("Order membership snapshot is incomplete");
  }
  return Object.freeze({
    version: benefitInteger(row.version, "membership version"),
    tier: Object.freeze({
      definition_id: row.tier_id!,
      code: row.tier_code,
      name: row.tier_name,
      level: benefitInteger(row.tier_level, "tier level"),
      definition_version: benefitInteger(row.tier_definition_version, "tier version"),
      discount_bps: benefitInteger(row.tier_discount_bps, "tier discount"),
    }),
  });
}
