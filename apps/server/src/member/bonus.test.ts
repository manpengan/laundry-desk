import assert from "node:assert/strict";
import test from "node:test";

import { matchBonusRule, type BonusRule } from "./bonus.js";

const rule = (id: string, minTopupCents: number, bonusCents: number): BonusRule =>
  Object.freeze({ rule_id: id, min_topup_cents: minTopupCents, bonus_cents: bonusCents });

test("no rules means no bonus", () => {
  assert.deepEqual(matchBonusRule([], 100_000), { rule_id: null, bonus_cents: 0 });
});

test("a top-up below every threshold earns nothing", () => {
  const rules = [rule("a", 100_000, 10_000)];
  assert.deepEqual(matchBonusRule(rules, 99_999), { rule_id: null, bonus_cents: 0 });
});

test("the threshold is inclusive", () => {
  const rules = [rule("a", 100_000, 10_000)];
  assert.deepEqual(matchBonusRule(rules, 100_000), { rule_id: "a", bonus_cents: 10_000 });
});

test("the highest threshold at or below the amount wins, whatever the input order", () => {
  const rules = [
    rule("mid", 100_000, 10_000),
    rule("low", 50_000, 3_000),
    rule("high", 200_000, 30_000),
  ];

  assert.deepEqual(matchBonusRule(rules, 150_000), { rule_id: "mid", bonus_cents: 10_000 });
  assert.deepEqual(matchBonusRule(rules, 200_000), { rule_id: "high", bonus_cents: 30_000 });
  assert.deepEqual(matchBonusRule(rules, 50_000), { rule_id: "low", bonus_cents: 3_000 });
});

test("two rules on the same threshold resolve deterministically by rule id", () => {
  // Nothing stops an operator creating both; picking by chance would make the
  // same top-up grant different bonuses on different reads.
  const rules = [rule("b", 100_000, 20_000), rule("a", 100_000, 10_000)];

  assert.deepEqual(matchBonusRule(rules, 100_000), matchBonusRule([...rules].reverse(), 100_000));
});

test("a zero-bonus rule is honoured as a real match, not a miss", () => {
  // An operator can deliberately switch a tier off by setting it to 0 without
  // retiring it; the ledger should record which rule applied.
  const rules = [rule("off", 100_000, 0)];
  assert.deepEqual(matchBonusRule(rules, 100_000), { rule_id: "off", bonus_cents: 0 });
});

test("an unsafe or negative amount earns nothing rather than throwing", () => {
  const rules = [rule("a", 1, 10_000)];
  assert.deepEqual(matchBonusRule(rules, 0), { rule_id: null, bonus_cents: 0 });
  assert.deepEqual(matchBonusRule(rules, -100), { rule_id: null, bonus_cents: 0 });
  assert.deepEqual(matchBonusRule(rules, 1.5), { rule_id: null, bonus_cents: 0 });
});

test("a corrupt rule stops the match instead of granting a wrong bonus", () => {
  const corrupt = Object.freeze({
    rule_id: "x",
    min_topup_cents: 100_000,
    bonus_cents: 1.5,
  }) as BonusRule;

  assert.throws(() => matchBonusRule([corrupt], 100_000), RangeError);
});
