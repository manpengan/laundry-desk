import type { MemberTopupConfirmationSummary, MemberTopupMatchedRule } from "./types.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expected.length &&
    keys.every((key) => typeof key === "string" && expected.includes(key))
  );
}

function isCents(value: unknown, allowZero: boolean): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && (allowZero ? value >= 0 : value > 0)
  );
}

function readMatchedRule(
  value: unknown,
  principalCents: number,
  bonusCents: number,
): MemberTopupMatchedRule | null | undefined {
  if (value === null) return bonusCents === 0 ? null : undefined;
  if (!isRecord(value) || !hasExactKeys(value, ["rule_id", "min_topup_cents", "bonus_cents"])) {
    return undefined;
  }
  if (
    typeof value.rule_id !== "string" ||
    !UUID.test(value.rule_id) ||
    !isCents(value.min_topup_cents, false) ||
    value.min_topup_cents > principalCents ||
    !isCents(value.bonus_cents, true) ||
    value.bonus_cents !== bonusCents
  ) {
    return undefined;
  }
  return Object.freeze({
    rule_id: value.rule_id,
    min_topup_cents: value.min_topup_cents,
    bonus_cents: value.bonus_cents,
  });
}

/** Strict browser/desktop boundary parser for the money-only R3 summary. */
export function readMemberTopupConfirmationSummary(
  value: unknown,
): MemberTopupConfirmationSummary | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "kind",
      "principal_cents",
      "bonus_cents",
      "credited_cents",
      "matched_rule",
    ]) ||
    value.kind !== "member_topup" ||
    !isCents(value.principal_cents, false) ||
    !isCents(value.bonus_cents, true) ||
    !isCents(value.credited_cents, false) ||
    value.credited_cents !== value.principal_cents + value.bonus_cents
  ) {
    return null;
  }
  const matchedRule = readMatchedRule(value.matched_rule, value.principal_cents, value.bonus_cents);
  if (matchedRule === undefined) return null;
  return Object.freeze({
    kind: "member_topup",
    principal_cents: value.principal_cents,
    bonus_cents: value.bonus_cents,
    credited_cents: value.credited_cents,
    matched_rule: matchedRule,
  });
}
