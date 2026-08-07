import assert from "node:assert/strict";
import test from "node:test";

import { toAccount, toLedgerRow, type AccountRow, type LedgerDbRow } from "./pg-store-support.js";

const ACCOUNT: AccountRow = Object.freeze({
  id: "a1111111-1111-4111-8111-111111111111",
  customer_id: "c1111111-1111-4111-8111-111111111111",
  status: "active",
  status_version: 1,
  status_changed_at: null,
  status_reason: null,
  opened_at: "2026-08-07T00:00:00.000Z",
});

const LEDGER: LedgerDbRow = Object.freeze({
  id: "11111111-1111-4111-8111-111111111111",
  kind: "topup",
  principal_delta_cents: 1_000,
  bonus_delta_cents: 100,
  order_id: null,
  store_id: "22222222-2222-4222-8222-222222222222",
  tender: "cash",
  bonus_rule_id: null,
  at: "2026-08-07T00:00:00.000Z",
  business_date: "2026-08-07",
  note: null,
});

test("PostgreSQL account mapping fails closed on an unknown status", () => {
  assert.throws(() => toAccount({ ...ACCOUNT, status: "paused" }), /status is not recognised/);
});

test("PostgreSQL account mapping refuses partial lifecycle evidence", () => {
  assert.throws(
    () =>
      toAccount({
        ...ACCOUNT,
        status: "frozen",
        status_version: 2,
        status_changed_at: "2026-08-07T01:00:00.000Z",
      }),
    /evidence is incomplete/,
  );
  assert.throws(
    () => toAccount({ ...ACCOUNT, status: "frozen", status_version: 2, status_reason: "lost" }),
    /evidence is incomplete/,
  );
});

test("PostgreSQL ledger mapping fails closed on unknown kinds and tenders", () => {
  assert.throws(() => toLedgerRow({ ...LEDGER, kind: "expire" }), /kind is not recognised/);
  assert.throws(() => toLedgerRow({ ...LEDGER, tender: "card" }), /tender is not recognised/);
});
