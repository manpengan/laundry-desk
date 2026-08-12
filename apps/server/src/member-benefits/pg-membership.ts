import type { SqlClient, TenantContext } from "../db/types.js";
import { lockActiveBenefitAccount, rejectPgBenefit } from "./pg-support.js";
import { readPgMemberBenefits } from "./pg-view.js";
import type {
  BenefitMutationResult,
  MemberBenefitOutcome,
  MembershipSetStoreInput,
} from "./types.js";

type TierRow = Readonly<{
  id: string;
  code: string;
  name: string;
  level: number | string;
  version: number | string;
  discount_bps: number | string;
  status: string;
}>;

export async function setPgMembership(
  client: SqlClient,
  tenant: TenantContext,
  input: MembershipSetStoreInput,
): Promise<MemberBenefitOutcome<BenefitMutationResult>> {
  const account = await lockActiveBenefitAccount(client, tenant, input.account_id);
  if (!account.ok) return account;
  if (input.valid_until !== null && input.valid_until < input.business_date) {
    return rejectPgBenefit("past_expiry");
  }
  const current = await client.query<Readonly<{ version: number | string }>>(
    `SELECT version FROM member_memberships
      WHERE org_id = $1::uuid AND account_id = $2::uuid`,
    [tenant.orgId, input.account_id],
  );
  const currentVersion = Number(current.rows[0]?.version ?? 0);
  if (!Number.isSafeInteger(currentVersion) || currentVersion !== input.expected_version) {
    return rejectPgBenefit("membership_version_conflict");
  }

  let tier: TierRow | null = null;
  if (input.tier_id !== null) {
    const tierResult = await client.query<TierRow>(
      `SELECT id::text, code, name, level, version, discount_bps, status
         FROM member_tiers
        WHERE org_id = $1::uuid AND id = $2::uuid
        FOR SHARE`,
      [tenant.orgId, input.tier_id],
    );
    tier = tierResult.rows[0] ?? null;
    if (tier === null) return rejectPgBenefit("definition_not_found");
    if (tier.status !== "active") return rejectPgBenefit("definition_retired");
  }

  const nextVersion = currentVersion + 1;
  if (currentVersion === 0) {
    await client.query(
      `INSERT INTO member_memberships (
         org_id, account_id, tier_id, tier_code, tier_name, tier_level,
         tier_definition_version, tier_discount_bps,
         valid_until, version, updated_at, updated_store_id,
         updated_by_staff_id, reason
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4, $5, $6,
         $7, $8, $9::date, $10, to_timestamp($11), $12::uuid, $13::uuid, $14
       )`,
      [
        tenant.orgId,
        input.account_id,
        tier?.id ?? null,
        tier?.code ?? null,
        tier?.name ?? null,
        tier?.level ?? null,
        tier?.version ?? null,
        tier?.discount_bps ?? null,
        input.valid_until,
        nextVersion,
        input.at,
        input.store_id,
        input.staff_id,
        input.reason,
      ],
    );
  } else {
    const updated = await client.query(
      `UPDATE member_memberships
          SET tier_id = $3::uuid, tier_code = $4, tier_name = $5, tier_level = $6,
              tier_definition_version = $7, tier_discount_bps = $8,
              valid_until = $9::date, version = version + 1,
              updated_at = to_timestamp($11), updated_store_id = $12::uuid,
              updated_by_staff_id = $13::uuid, reason = $14
        WHERE org_id = $1::uuid AND account_id = $2::uuid AND version = $10`,
      [
        tenant.orgId,
        input.account_id,
        tier?.id ?? null,
        tier?.code ?? null,
        tier?.name ?? null,
        tier?.level ?? null,
        tier?.version ?? null,
        tier?.discount_bps ?? null,
        input.valid_until,
        currentVersion,
        input.at,
        input.store_id,
        input.staff_id,
        input.reason,
      ],
    );
    if (updated.rowCount !== 1) return rejectPgBenefit("membership_version_conflict");
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
      entity_id: input.account_id,
      changed: true,
    }),
  });
}
