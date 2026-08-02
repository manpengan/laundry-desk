/**
 * Pure top-up bonus matching (ADR-22 §2, §3).
 *
 * Tiers, not percentages: a tier is "top up 1000, get 100" — something that can
 * be printed on a counter card — and it is integer fen by construction, so no
 * rounding rule has to be invented and later argued about at reconciliation.
 *
 * The result is authoritative: the amount is never accepted from a client, or a
 * clerk could pair any top-up with any bonus and both sides of the books would
 * still look internally consistent (ADR-17 §6 refuses `method='balance'` for the
 * same reason).
 */

export type BonusRule = Readonly<{
  rule_id: string;
  min_topup_cents: number;
  bonus_cents: number;
}>;

/** Which rule applied and what it granted. `rule_id` is null when none did. */
export type BonusMatch = Readonly<{
  rule_id: string | null;
  bonus_cents: number;
}>;

const NO_BONUS: BonusMatch = Object.freeze({ rule_id: null, bonus_cents: 0 });

/**
 * Pick the highest threshold at or below `amountCents`.
 *
 * Ties break on `rule_id` so the same top-up always grants the same bonus:
 * nothing stops an operator creating two rules on one threshold, and resolving
 * that by input order would make the grant depend on row ordering.
 *
 * Throws on a corrupt rule rather than skipping it — a malformed tier means the
 * rule table is wrong, and granting the next-best bonus would quietly pay out a
 * number nobody configured.
 */
export function matchBonusRule(rules: readonly BonusRule[], amountCents: number): BonusMatch {
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) return NO_BONUS;

  let best: BonusRule | null = null;
  for (const rule of rules) {
    if (!Number.isSafeInteger(rule.min_topup_cents) || rule.min_topup_cents < 0) {
      throw new RangeError(`member bonus rule ${rule.rule_id} has an invalid threshold`);
    }
    if (!Number.isSafeInteger(rule.bonus_cents) || rule.bonus_cents < 0) {
      throw new RangeError(`member bonus rule ${rule.rule_id} has an invalid bonus`);
    }
    if (rule.min_topup_cents > amountCents) continue;
    if (best === null) {
      best = rule;
      continue;
    }
    if (rule.min_topup_cents > best.min_topup_cents) {
      best = rule;
      continue;
    }
    if (rule.min_topup_cents === best.min_topup_cents && rule.rule_id < best.rule_id) {
      best = rule;
    }
  }

  if (best === null) return NO_BONUS;
  return Object.freeze({ rule_id: best.rule_id, bonus_cents: best.bonus_cents });
}
