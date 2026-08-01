import assert from "node:assert/strict";
import test from "node:test";

import { parseMemberAccountView, topupAmountToCents } from "./member-model.js";

test("topupAmountToCents converts whole yuan", () => {
  assert.equal(topupAmountToCents("100"), 10_000);
  assert.equal(topupAmountToCents(" 50 "), 5_000);
});

test("topupAmountToCents converts one and two decimal places", () => {
  assert.equal(topupAmountToCents("0.5"), 50);
  assert.equal(topupAmountToCents("0.05"), 5);
  assert.equal(topupAmountToCents("12.34"), 1_234);
});

test("topupAmountToCents does not lose a fen to floating point", () => {
  // Number("8.29") * 100 === 828.9999999999999 — the naive version truncates to
  // 828 and the store is one fen short on every such top-up.
  assert.equal(topupAmountToCents("8.29"), 829);
  assert.equal(topupAmountToCents("1.15"), 115);
  assert.equal(topupAmountToCents("35.41"), 3_541);
});

test("topupAmountToCents refuses zero, negative and non-numeric input", () => {
  for (const bad of ["", "0", "0.00", "-1", "abc", "1e3", "１００", "1.2.3", " "]) {
    assert.equal(topupAmountToCents(bad), null, bad);
  }
});

test("topupAmountToCents refuses more than two decimals", () => {
  assert.equal(topupAmountToCents("1.234"), null);
  assert.equal(topupAmountToCents("1.005"), null);
});

const rows = [
  {
    ledger_id: "l1",
    kind: "topup",
    principal_delta_cents: 10_000,
    bonus_delta_cents: 0,
    order_id: null,
    business_date: "2026-08-01",
  },
];

test("parseMemberAccountView parses a customer without an account", () => {
  assert.deepEqual(parseMemberAccountView({ account: null, recent: [] }), {
    account: null,
    recent: [],
  });
});

test("parseMemberAccountView parses an account with its ledger", () => {
  const view = parseMemberAccountView({
    account: {
      account_id: "a1",
      status: "active",
      principal_cents: 10_000,
      bonus_cents: 0,
      balance_cents: 10_000,
    },
    recent: rows,
  });

  assert.equal(view?.account?.balance_cents, 10_000);
  assert.equal(view?.recent.length, 1);
});

test("parseMemberAccountView refuses a payload whose parts do not add up", () => {
  const view = parseMemberAccountView({
    account: {
      account_id: "a1",
      status: "active",
      principal_cents: 10_000,
      bonus_cents: 500,
      // Deliberately inconsistent: rendering this would show a number the ledger
      // cannot justify.
      balance_cents: 10_000,
    },
    recent: [],
  });

  assert.equal(view, null);
});

test("parseMemberAccountView refuses a non-integer amount rather than rendering it", () => {
  const view = parseMemberAccountView({
    account: {
      account_id: "a1",
      status: "active",
      principal_cents: 10_000.5,
      bonus_cents: 0,
      balance_cents: 10_000.5,
    },
    recent: [],
  });

  assert.equal(view, null);
});

test("parseMemberAccountView refuses the whole view when a ledger row is malformed", () => {
  const view = parseMemberAccountView({
    account: {
      account_id: "a1",
      status: "active",
      principal_cents: 0,
      bonus_cents: 0,
      balance_cents: 0,
    },
    recent: [...rows, { ledger_id: "l2" }],
  });

  assert.equal(view, null);
});

test("parseMemberAccountView refuses a non-object payload", () => {
  assert.equal(parseMemberAccountView(null), null);
  assert.equal(parseMemberAccountView([]), null);
  assert.equal(parseMemberAccountView("x"), null);
});
