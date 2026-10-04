import { randomUUID } from "node:crypto";

import { createPgPool } from "../db/pg-pool.js";
import { withPoolClient } from "../db/pg-sql-client.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import type { TenantContext } from "../db/types.js";

/** A real funded ledger fixture for constraint and refund regressions. */
export async function seedRawMemberBalance(
  appUrl: string,
  tenant: TenantContext,
  accountId: string,
  principalCents: number,
  bonusCents: number,
): Promise<void> {
  const pool = createPgPool({ connectionString: appUrl });
  try {
    await withPoolClient(pool, async (client) =>
      withTenantTransaction(client, tenant, async (tx) => {
        const bonusRuleId = bonusCents > 0 ? randomUUID() : null;
        if (bonusRuleId !== null) {
          await tx.query(
            `INSERT INTO member_bonus_rules (
               id, org_id, min_topup_cents, bonus_cents, status,
               effective_from, updated_at, updated_by_staff_id, note
             ) VALUES (
               $1::uuid, $2::uuid, 1, 1, 'retired', now(), now(), $3::uuid, NULL
             )`,
            [bonusRuleId, tenant.orgId, tenant.staffId],
          );
        }
        await tx.query(
          `INSERT INTO member_ledger (
             id, org_id, store_id, account_id, kind,
             principal_delta_cents, bonus_delta_cents, order_id, tender,
             bonus_rule_id, staff_id, at, business_date, note
           ) VALUES (
             $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'topup',
             $5::bigint, $6::bigint, NULL, 'cash',
             $7::uuid, $8::uuid, now(), $9, NULL
           )`,
          [
            randomUUID(),
            tenant.orgId,
            tenant.storeId,
            accountId,
            principalCents,
            bonusCents,
            bonusRuleId,
            tenant.staffId,
            "2026-08-01",
          ],
        );
      }),
    );
  } finally {
    await pool.end();
  }
}
