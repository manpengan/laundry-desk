/**
 * Pure stored-value arithmetic (ADR-17 §3, §5).
 *
 * The balance is a projection of the append-only ledger, so it is computed here
 * from rows rather than read from any stored column. Everything is integer fen.
 */

export type LedgerDelta = Readonly<{
  principal_delta_cents: number;
  bonus_delta_cents: number;
}>;

export type MemberBalance = Readonly<{
  principal_cents: number;
  bonus_cents: number;
  total_cents: number;
}>;

/** Deltas a spend writes to the ledger. Both are <= 0 and sum to -amount. */
export type SpendAllocation = Readonly<{
  principal_delta_cents: number;
  bonus_delta_cents: number;
}>;

export type SpendOutcome =
  | Readonly<{ ok: true; allocation: SpendAllocation }>
  | Readonly<{ ok: false; reason: "invalid_amount" | "insufficient_balance" }>;

function isSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value);
}

/**
 * Negate without producing `-0`.
 *
 * A plain `-0` compares unequal to `0` under `Object.is` and `assert.deepEqual`,
 * so letting it into a money field makes downstream equality checks fail for a
 * reason that has nothing to do with the amount.
 */
function negate(value: number): number {
  return value === 0 ? 0 : -value;
}

/**
 * Sum signed deltas into a balance.
 *
 * Throws on a non-integer or unsafe row rather than returning a plausible-looking
 * balance: a corrupt ledger row must stop the operation, not silently move money.
 */
export function projectBalance(rows: readonly LedgerDelta[]): MemberBalance {
  let principal = 0;
  let bonus = 0;
  for (const row of rows) {
    if (!isSafeInteger(row.principal_delta_cents) || !isSafeInteger(row.bonus_delta_cents)) {
      throw new RangeError("member ledger row is not a safe integer");
    }
    principal += row.principal_delta_cents;
    bonus += row.bonus_delta_cents;
  }
  if (!isSafeInteger(principal) || !isSafeInteger(bonus)) {
    throw new RangeError("member balance overflowed the safe integer range");
  }
  return Object.freeze({
    principal_cents: principal,
    bonus_cents: bonus,
    total_cents: principal + bonus,
  });
}

/**
 * Split a spend across bonus first, then principal (ADR-17 §5).
 *
 * Bonus is consumed first because it is the component a customer is least likely
 * to be entitled to withdraw, so spending it first leaves the refundable part
 * intact for longer. In the first slice bonus is always 0, which makes this
 * equivalent to spending principal only — the ordering exists so the ledger is
 * already correct when top-up bonuses arrive.
 */
export function allocateSpend(balance: MemberBalance, amountCents: number): SpendOutcome {
  if (!isSafeInteger(amountCents) || amountCents <= 0) {
    return Object.freeze({ ok: false, reason: "invalid_amount" as const });
  }
  // A negative component would mean the ledger already went below zero; refuse
  // to spend rather than let one component subsidise the other.
  if (balance.principal_cents < 0 || balance.bonus_cents < 0) {
    return Object.freeze({ ok: false, reason: "insufficient_balance" as const });
  }
  if (amountCents > balance.total_cents) {
    return Object.freeze({ ok: false, reason: "insufficient_balance" as const });
  }
  const fromBonus = Math.min(balance.bonus_cents, amountCents);
  const fromPrincipal = amountCents - fromBonus;
  return Object.freeze({
    ok: true as const,
    allocation: Object.freeze({
      principal_delta_cents: negate(fromPrincipal),
      bonus_delta_cents: negate(fromBonus),
    }),
  });
}
