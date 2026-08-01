-- ADR-22 §1: record how money actually moved for a stored-value row, so cash
-- top-ups reach the day's expected cash.
--
-- ADR-18 §3 ruled that a balance settlement is NOT cash inflow because "the
-- money already arrived on the top-up day". Only the first half shipped: the
-- top-up method was accepted by the command and written to the audit trail, but
-- never to a business table, and stats/shift/reconciliation never read the
-- ledger. A customer topping up 1000 in cash left 1000 in the drawer that the
-- expected figure could not account for — an unexplained shift surplus on every
-- cash top-up. This column is the missing half.

ALTER TABLE member_ledger
  ADD COLUMN IF NOT EXISTS tender text;

-- Historical rows predate the column. They stay NULL and therefore stay out of
-- the cash figure: their tender is genuinely unknown, and guessing 'cash' would
-- retroactively move already-closed shifts.

-- A settlement moves no cash — the money arrived on the top-up day (ADR-18 §1).
-- Enforced here rather than in the handler so no future write path can quietly
-- attach a tender to a spend and double-count the same banknotes.
ALTER TABLE member_ledger
  ADD CONSTRAINT member_ledger_pay_tender_chk CHECK (
    kind <> 'pay' OR tender IS NULL
  );

-- Anything that is not a settlement moves real money, so when it carries a
-- tender that tender must be one the cash rollup understands. NULL stays legal
-- for the pre-0035 rows above.
ALTER TABLE member_ledger
  ADD CONSTRAINT member_ledger_tender_value_chk CHECK (
    tender IS NULL OR tender IN ('cash', 'wechat', 'alipay', 'other')
  );

-- The cash rollup filters by (org, store, business_date, tender); without this
-- the shift-close read degrades to a full ledger scan as history accumulates.
CREATE INDEX IF NOT EXISTS member_ledger_cash_day_idx
  ON member_ledger (org_id, store_id, business_date)
  WHERE tender = 'cash';
