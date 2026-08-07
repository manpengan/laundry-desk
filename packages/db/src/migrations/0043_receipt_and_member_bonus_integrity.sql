-- Orders age from formal receipt, not from an operator's uncommitted draft.
-- The application resets this value when draft -> open is promoted; retaining
-- the definition in PostgreSQL keeps reporting and notification reads aligned.
COMMENT ON COLUMN orders.created_at IS
  'Formal receipt/open instant; draft promotion resets this retention clock.';

-- Older releases kept the original draft timestamp when a hold became an open
-- order. The append-only order.receive audit is the best historical receipt
-- authority; rows predating that evidence use their latest known mutation as a
-- conservative lower bound so a stale draft age cannot create a false alert.
WITH receipt_audit AS (
  SELECT org_id, store_id, entity_id, MIN(at) AS received_at
  FROM audit_log
  WHERE command = 'order.receive'
    AND entity = 'order'
  GROUP BY org_id, store_id, entity_id
), receipt_clock AS (
  SELECT
    orders.id,
    orders.org_id,
    orders.store_id,
    COALESCE(receipt_audit.received_at, orders.updated_at) AS received_at
  FROM orders
  LEFT JOIN receipt_audit
    ON receipt_audit.org_id = orders.org_id
   AND receipt_audit.store_id = orders.store_id
   AND receipt_audit.entity_id = orders.id::text
  WHERE orders.status = 'open'
)
UPDATE orders
SET created_at = receipt_clock.received_at
FROM receipt_clock
WHERE orders.id = receipt_clock.id
  AND orders.org_id = receipt_clock.org_id
  AND orders.store_id = receipt_clock.store_id
  AND orders.created_at < receipt_clock.received_at;

-- A positive bonus is money granted by a frozen server-selected tier. Requiring
-- its origin at the database boundary prevents a future write path from
-- inventing bonus value while bypassing the confirmation/rule contract.
ALTER TABLE member_ledger
  ADD CONSTRAINT member_ledger_positive_bonus_origin_chk CHECK (
    kind <> 'topup' OR bonus_delta_cents <= 0 OR bonus_rule_id IS NOT NULL
  );
