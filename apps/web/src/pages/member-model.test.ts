import assert from "node:assert/strict";
import test from "node:test";

import {
  centsToYuanInput,
  parseMemberAccountView,
  parseMemberBonusRules,
  topupAmountToCents,
  yuanAmountToCents,
} from "./member-model.js";

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

test("yuanAmountToCents accepts a zero bonus without floating point", () => {
  assert.equal(yuanAmountToCents("0"), 0);
  assert.equal(yuanAmountToCents("8.29"), 829);
  assert.equal(centsToYuanInput(829), "8.29");
});

test("parseMemberBonusRules validates the complete authority response", () => {
  assert.deepEqual(
    parseMemberBonusRules({
      rules: [
        {
          rule_id: "r1",
          min_topup_cents: 100_000,
          bonus_cents: 10_000,
          status: "active",
          note: "台卡活动",
        },
      ],
    }),
    [
      {
        rule_id: "r1",
        min_topup_cents: 100_000,
        bonus_cents: 10_000,
        status: "active",
        note: "台卡活动",
      },
    ],
  );
  assert.equal(
    parseMemberBonusRules({
      rules: [{ rule_id: "r1", min_topup_cents: 0, bonus_cents: 10, status: "active" }],
    }),
    null,
  );
  assert.equal(
    parseMemberBonusRules({
      rules: [
        {
          rule_id: "r1",
          min_topup_cents: 100,
          bonus_cents: 10,
          status: "active",
          note: 42,
        },
      ],
    }),
    null,
  );
});

const CUSTOMER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_CUSTOMER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ACCOUNT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const STORE_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const LEDGER_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const account = Object.freeze({
  account_id: ACCOUNT_ID,
  customer_id: CUSTOMER_ID,
  status: "active",
  status_version: 1,
  status_changed_at: null,
  status_reason: null,
  principal_cents: 10_000,
  bonus_cents: 0,
  balance_cents: 10_000,
});

const row = Object.freeze({
  ledger_id: LEDGER_ID,
  kind: "topup",
  principal_delta_cents: 10_000,
  bonus_delta_cents: 0,
  order_id: null,
  store_id: STORE_ID,
  tender: "cash",
  bonus_rule_id: null,
  at: 1_754_000_000,
  business_date: "2026-08-01",
  note: null,
});

test("parseMemberAccountView parses a customer without an account", () => {
  assert.deepEqual(parseMemberAccountView({ account: null, recent: [] }, CUSTOMER_ID), {
    account: null,
    recent: [],
  });
});

test("parseMemberAccountView parses exact account and ledger projections", () => {
  const view = parseMemberAccountView({ account, recent: [row] }, CUSTOMER_ID);
  assert.equal(view?.account?.balance_cents, 10_000);
  assert.equal(view?.account?.status_version, 1);
  assert.equal(view?.recent[0]?.tender, "cash");
});

test("parseMemberAccountView refuses mismatched customer or extra authority fields", () => {
  assert.equal(parseMemberAccountView({ account, recent: [row] }, OTHER_CUSTOMER_ID), null);
  assert.equal(
    parseMemberAccountView({ account: { ...account, extra: true }, recent: [row] }, CUSTOMER_ID),
    null,
  );
  assert.equal(
    parseMemberAccountView({ account, recent: [{ ...row, extra: true }] }, CUSTOMER_ID),
    null,
  );
});

test("parseMemberAccountView refuses unknown account status and ledger kind", () => {
  assert.equal(
    parseMemberAccountView({ account: { ...account, status: "paused" }, recent: [] }, CUSTOMER_ID),
    null,
  );
  assert.equal(
    parseMemberAccountView({ account, recent: [{ ...row, kind: "mystery" }] }, CUSTOMER_ID),
    null,
  );
});

test("parseMemberAccountView refuses malformed account identity and lifecycle version", () => {
  assert.equal(
    parseMemberAccountView(
      { account: { ...account, account_id: "not-a-uuid" }, recent: [] },
      CUSTOMER_ID,
    ),
    null,
  );
  assert.equal(
    parseMemberAccountView({ account: { ...account, status_version: 0 }, recent: [] }, CUSTOMER_ID),
    null,
  );
  assert.equal(parseMemberAccountView({ account, recent: [] }, "not-a-customer-id"), null);
});

test("parseMemberAccountView requires status evidence fields to appear together", () => {
  assert.equal(
    parseMemberAccountView(
      {
        account: { ...account, status_changed_at: 1_754_000_100, status_reason: null },
        recent: [],
      },
      CUSTOMER_ID,
    ),
    null,
  );
  assert.equal(
    parseMemberAccountView(
      { account: { ...account, status_changed_at: null, status_reason: "顾客报失" }, recent: [] },
      CUSTOMER_ID,
    ),
    null,
  );
});

test("parseMemberAccountView refuses inconsistent, negative or unsafe balances", () => {
  for (const broken of [
    { ...account, bonus_cents: 500 },
    { ...account, principal_cents: -1, balance_cents: -1 },
    {
      ...account,
      principal_cents: Number.MAX_SAFE_INTEGER + 1,
      balance_cents: Number.MAX_SAFE_INTEGER + 1,
    },
  ]) {
    assert.equal(parseMemberAccountView({ account: broken, recent: [] }, CUSTOMER_ID), null);
  }
});

test("parseMemberAccountView accepts a zeroed closed account but refuses closed money", () => {
  const closed = {
    ...account,
    status: "closed",
    status_version: 4,
    status_changed_at: 1_754_000_100,
    status_reason: "顾客退卡",
    principal_cents: 0,
    balance_cents: 0,
  };
  assert.equal(
    parseMemberAccountView({ account: closed, recent: [] }, CUSTOMER_ID)?.account?.status,
    "closed",
  );
  assert.equal(
    parseMemberAccountView(
      { account: { ...closed, principal_cents: 1, balance_cents: 1 }, recent: [] },
      CUSTOMER_ID,
    ),
    null,
  );
});

test("parseMemberAccountView enforces ledger mechanical shapes", () => {
  const cases = [
    { ...row, kind: "topup", tender: null },
    { ...row, kind: "pay", tender: null, order_id: null, principal_delta_cents: -1 },
    { ...row, kind: "refund", order_id: null, principal_delta_cents: -1, tender: null },
    { ...row, kind: "refund", order_id: null, principal_delta_cents: -1, bonus_delta_cents: -1 },
    {
      ...row,
      kind: "bonus_forfeit",
      principal_delta_cents: -1,
      bonus_delta_cents: -1,
      tender: null,
    },
    {
      ...row,
      kind: "bonus_forfeit",
      principal_delta_cents: 0,
      bonus_delta_cents: -1,
      tender: "cash",
    },
    {
      ...row,
      principal_delta_cents: Number.MAX_SAFE_INTEGER,
      bonus_delta_cents: Number.MAX_SAFE_INTEGER,
    },
  ];
  for (const malformed of cases) {
    assert.equal(parseMemberAccountView({ account, recent: [malformed] }, CUSTOMER_ID), null);
  }
});

test("parseMemberAccountView accepts the frozen bonus forfeiture shape", () => {
  const forfeiture = {
    ...row,
    kind: "bonus_forfeit",
    principal_delta_cents: 0,
    bonus_delta_cents: -500,
    tender: null,
  };
  assert.equal(
    parseMemberAccountView({ account, recent: [forfeiture] }, CUSTOMER_ID)?.recent[0]?.kind,
    "bonus_forfeit",
  );
});

test("parseMemberAccountView refuses impossible recent collections", () => {
  assert.equal(parseMemberAccountView({ account: null, recent: [row] }, CUSTOMER_ID), null);
  assert.equal(parseMemberAccountView({ account, recent: [row, row] }, CUSTOMER_ID), null);
  assert.equal(
    parseMemberAccountView({ account, recent: Array.from({ length: 51 }, () => row) }, CUSTOMER_ID),
    null,
  );
});

test("parseMemberAccountView refuses malformed dates, epochs and objects", () => {
  assert.equal(
    parseMemberAccountView(
      { account, recent: [{ ...row, business_date: "2026-02-30" }] },
      CUSTOMER_ID,
    ),
    null,
  );
  assert.equal(parseMemberAccountView({ account, recent: [{ ...row, at: 0 }] }, CUSTOMER_ID), null);
  assert.equal(parseMemberAccountView(null, CUSTOMER_ID), null);
  assert.equal(parseMemberAccountView([], CUSTOMER_ID), null);
  assert.equal(parseMemberAccountView("x", CUSTOMER_ID), null);
});

test("parseMemberAccountView refuses malformed ledger evidence", () => {
  for (const malformed of [
    { ...row, store_id: "not-a-uuid" },
    { ...row, order_id: "not-a-uuid" },
    { ...row, tender: "card" },
    { ...row, bonus_rule_id: "not-a-uuid" },
    { ...row, note: "x".repeat(257) },
  ]) {
    assert.equal(parseMemberAccountView({ account, recent: [malformed] }, CUSTOMER_ID), null);
  }
});
