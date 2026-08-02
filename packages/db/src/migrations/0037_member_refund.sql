-- ADR-22 §5: stored-value refunds.
--
-- Refundable is exactly the projected principal, with no retrospective
-- arithmetic: spending always eats bonus first (ADR-17 §5), so whatever
-- principal remains is precisely the part the customer never consumed.

-- Broadening an enum-like CHECK requires replacing it. This accepts strictly
-- more values and removes no row; the (table, constraint) pair is registered in
-- migration-guard.ts so the expand-only gate stays exact.
ALTER TABLE member_ledger DROP CONSTRAINT IF EXISTS member_ledger_kind_chk;
ALTER TABLE member_ledger
  ADD CONSTRAINT member_ledger_kind_chk
    CHECK (kind IN ('topup', 'pay', 'reversal', 'refund'));

-- The bonus is never refundable — it is a book grant the customer never paid
-- for. Enforced here rather than in the handler so ADR-22 §4.1 cannot be undone
-- by one wrong write path: member_ledger grants the app role only SELECT and
-- INSERT, so every future writer meets this CHECK.
ALTER TABLE member_ledger
  ADD CONSTRAINT member_ledger_refund_sign_chk CHECK (
    kind <> 'refund'
      OR (principal_delta_cents < 0 AND bonus_delta_cents = 0)
  );

-- A refund settles no order: it returns money the customer prepaid, which is not
-- attached to any ticket.
ALTER TABLE member_ledger
  ADD CONSTRAINT member_ledger_refund_order_chk CHECK (
    kind <> 'refund' OR order_id IS NULL
  );
