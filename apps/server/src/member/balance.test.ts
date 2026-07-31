import assert from "node:assert/strict";
import test from "node:test";

import { allocateSpend, projectBalance, type MemberBalance } from "./balance.js";

const balance = (principal: number, bonus: number): MemberBalance =>
  Object.freeze({
    principal_cents: principal,
    bonus_cents: bonus,
    total_cents: principal + bonus,
  });

test("projectBalance sums an empty ledger to zero", () => {
  assert.deepEqual(projectBalance([]), {
    principal_cents: 0,
    bonus_cents: 0,
    total_cents: 0,
  });
});

test("projectBalance sums signed deltas without a stored balance column", () => {
  const rows = [
    { principal_delta_cents: 10_000, bonus_delta_cents: 0 },
    { principal_delta_cents: 5_000, bonus_delta_cents: 500 },
    { principal_delta_cents: -3_000, bonus_delta_cents: -500 },
  ];

  assert.deepEqual(projectBalance(rows), {
    principal_cents: 12_000,
    bonus_cents: 0,
    total_cents: 12_000,
  });
});

test("projectBalance lets a reversal cancel the row it reverses exactly", () => {
  const topup = { principal_delta_cents: 20_000, bonus_delta_cents: 0 };
  const reversal = { principal_delta_cents: -20_000, bonus_delta_cents: 0 };

  assert.equal(projectBalance([topup, reversal]).total_cents, 0);
});

test("projectBalance refuses a non-integer row rather than returning a plausible balance", () => {
  assert.throws(
    () => projectBalance([{ principal_delta_cents: 10.5, bonus_delta_cents: 0 }]),
    RangeError,
  );
});

test("projectBalance refuses a sum that leaves the safe integer range", () => {
  const rows = [
    { principal_delta_cents: Number.MAX_SAFE_INTEGER, bonus_delta_cents: 0 },
    { principal_delta_cents: Number.MAX_SAFE_INTEGER, bonus_delta_cents: 0 },
  ];

  assert.throws(() => projectBalance(rows), RangeError);
});

test("allocateSpend spends bonus before principal", () => {
  assert.deepEqual(allocateSpend(balance(10_000, 3_000), 5_000), {
    ok: true,
    allocation: { principal_delta_cents: -2_000, bonus_delta_cents: -3_000 },
  });
});

test("allocateSpend takes only principal when there is no bonus", () => {
  assert.deepEqual(allocateSpend(balance(10_000, 0), 4_200), {
    ok: true,
    allocation: { principal_delta_cents: -4_200, bonus_delta_cents: 0 },
  });
});

test("allocateSpend takes only bonus when bonus covers the spend", () => {
  assert.deepEqual(allocateSpend(balance(10_000, 8_000), 8_000), {
    ok: true,
    allocation: { principal_delta_cents: 0, bonus_delta_cents: -8_000 },
  });
});

test("allocateSpend allows spending the balance down to exactly zero", () => {
  assert.deepEqual(allocateSpend(balance(1_000, 500), 1_500), {
    ok: true,
    allocation: { principal_delta_cents: -1_000, bonus_delta_cents: -500 },
  });
});

test("allocateSpend refuses to overdraw by a single fen", () => {
  assert.deepEqual(allocateSpend(balance(1_000, 500), 1_501), {
    ok: false,
    reason: "insufficient_balance",
  });
});

test("allocateSpend refuses a zero or negative amount", () => {
  assert.deepEqual(allocateSpend(balance(10_000, 0), 0), {
    ok: false,
    reason: "invalid_amount",
  });
  assert.deepEqual(allocateSpend(balance(10_000, 0), -100), {
    ok: false,
    reason: "invalid_amount",
  });
});

test("allocateSpend refuses a fractional amount rather than rounding money", () => {
  assert.deepEqual(allocateSpend(balance(10_000, 0), 12.5), {
    ok: false,
    reason: "invalid_amount",
  });
});

test("allocateSpend refuses to let one component subsidise a negative other", () => {
  // Unreachable through the ledger CHECK constraints, but if it ever happens the
  // spend must stop rather than quietly net the two components out.
  assert.deepEqual(allocateSpend(balance(5_000, -1_000), 100), {
    ok: false,
    reason: "insufficient_balance",
  });
});

test("allocateSpend never allocates deltas that sum to something other than the spend", () => {
  for (const [principal, bonus, amount] of [
    [10_000, 0, 1],
    [10_000, 3_000, 3_000],
    [0, 700, 700],
    [250, 250, 500],
  ] as const) {
    const outcome = allocateSpend(balance(principal, bonus), amount);
    assert.equal(outcome.ok, true);
    if (!outcome.ok) continue;
    const { principal_delta_cents, bonus_delta_cents } = outcome.allocation;
    assert.equal(principal_delta_cents + bonus_delta_cents, -amount);
    assert.ok(principal_delta_cents <= 0);
    assert.ok(bonus_delta_cents <= 0);
  }
});
