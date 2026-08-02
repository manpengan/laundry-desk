/**
 * PostgreSQL access for top-up bonus tiers (ADR-22 §2).
 *
 * Split from the account/ledger store because a tier is configuration, not a
 * money movement: tiers are updated in place, while the ledger is append-only
 * and locks the account row before every write. Keeping them in one file made
 * that difference easy to miss — and pushed the store past the 400-line gate.
 */

import type { BonusRule } from "./bonus.js";
import type { SqlClient, TenantContext } from "../db/types.js";
import type {
  MemberBonusRuleRecord,
  MemberBonusRuleUpsertInput,
  MemberOutcome,
  MemberRejectReason,
} from "./types.js";

type BonusRuleDbRow = Readonly<{
  id: string;
  min_topup_cents: number | string;
  bonus_cents: number | string;
  status: string;
  updated_at: Date | string;
  note: string | null;
}>;

const reject = <T>(reason: MemberRejectReason): MemberOutcome<T> =>
  Object.freeze({ ok: false as const, reason });

const toEpoch = (value: Date | string): number =>
  Math.floor((value instanceof Date ? value.getTime() : new Date(value).getTime()) / 1000);

function requireInt(value: number | string, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`member bonus rule ${label} is not a safe integer`);
  }
  return parsed;
}

function toBonusRule(row: BonusRuleDbRow): MemberBonusRuleRecord {
  return Object.freeze({
    rule_id: row.id,
    min_topup_cents: requireInt(row.min_topup_cents, "min_topup_cents"),
    bonus_cents: requireInt(row.bonus_cents, "bonus_cents"),
    status: row.status === "retired" ? ("retired" as const) : ("active" as const),
    updated_at: toEpoch(row.updated_at),
    note: row.note,
  });
}

/**
 * Active tiers, for the matcher.
 *
 * The caller runs this inside the top-up transaction *after* locking the account
 * row: a tier edited between an earlier read and the ledger insert would
 * otherwise be snapshotted stale, granting a bonus nobody had configured.
 */
export async function readActiveBonusRules(
  client: SqlClient,
  tenant: TenantContext,
): Promise<readonly BonusRule[]> {
  const rows = await client.query<
    Readonly<{ id: string; min: number | string; b: number | string }>
  >(
    `SELECT id, min_topup_cents AS min, bonus_cents AS b
       FROM member_bonus_rules
      WHERE org_id = $1::uuid AND status = 'active'`,
    [tenant.orgId],
  );
  return rows.rows.map((row) =>
    Object.freeze({
      rule_id: row.id,
      min_topup_cents: requireInt(row.min, "min_topup_cents"),
      bonus_cents: requireInt(row.b, "bonus_cents"),
    }),
  );
}

export async function listBonusRules(
  client: SqlClient,
  tenant: TenantContext,
  includeRetired: boolean,
): Promise<readonly MemberBonusRuleRecord[]> {
  const rows = await client.query<BonusRuleDbRow>(
    `SELECT id, min_topup_cents, bonus_cents, status, updated_at, note
       FROM member_bonus_rules
      WHERE org_id = $1::uuid AND ($2::boolean OR status = 'active')
      ORDER BY min_topup_cents DESC, id ASC`,
    [tenant.orgId, includeRetired],
  );
  return Object.freeze(rows.rows.map(toBonusRule));
}

/**
 * Create, reprice or retire one tier.
 *
 * A supplied `rule_id` must already exist: falling back to an INSERT would turn
 * a typo into a second tier on the same threshold rather than an error.
 */
export async function upsertBonusRule(
  client: SqlClient,
  tenant: TenantContext,
  newId: () => string,
  input: MemberBonusRuleUpsertInput,
): Promise<MemberOutcome<MemberBonusRuleRecord>> {
  if (!Number.isSafeInteger(input.min_topup_cents) || input.min_topup_cents <= 0) {
    return reject("invalid_amount");
  }
  if (!Number.isSafeInteger(input.bonus_cents) || input.bonus_cents < 0) {
    return reject("invalid_amount");
  }

  if (input.rule_id !== null) {
    const updated = await client.query<BonusRuleDbRow>(
      `UPDATE member_bonus_rules
          SET min_topup_cents = $3::integer, bonus_cents = $4::integer,
              status = $5, updated_at = to_timestamp($6),
              updated_by_staff_id = $7::uuid, note = $8
        WHERE org_id = $1::uuid AND id = $2::uuid
    RETURNING id, min_topup_cents, bonus_cents, status, updated_at, note`,
      [
        tenant.orgId,
        input.rule_id,
        input.min_topup_cents,
        input.bonus_cents,
        input.status,
        input.at,
        input.staff_id,
        input.note,
      ],
    );
    const row = updated.rows[0];
    if (row === undefined) return reject("bonus_rule_not_found");
    return Object.freeze({ ok: true as const, value: toBonusRule(row) });
  }

  const inserted = await client.query<BonusRuleDbRow>(
    `INSERT INTO member_bonus_rules (
       id, org_id, min_topup_cents, bonus_cents, status,
       effective_from, updated_at, updated_by_staff_id, note
     ) VALUES (
       $1::uuid, $2::uuid, $3::integer, $4::integer, $5,
       to_timestamp($6), to_timestamp($6), $7::uuid, $8
     )
  RETURNING id, min_topup_cents, bonus_cents, status, updated_at, note`,
    [
      newId(),
      tenant.orgId,
      input.min_topup_cents,
      input.bonus_cents,
      input.status,
      input.at,
      input.staff_id,
      input.note,
    ],
  );
  const row = inserted.rows[0];
  if (row === undefined) throw new Error("member bonus rule insert returned no row");
  return Object.freeze({ ok: true as const, value: toBonusRule(row) });
}
