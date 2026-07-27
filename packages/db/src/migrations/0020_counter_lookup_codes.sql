-- Expand-only: customer-facing pickup codes and bounded counter lookup indexes.

ALTER TABLE orders ADD COLUMN IF NOT EXISTS pickup_code text;

-- Existing received orders receive the same deterministic format as new orders.
-- Drafts intentionally remain NULL because no customer-facing ticket exists yet.
UPDATE orders
SET pickup_code = 'P' || replace(ticket_no, '-', '')
WHERE pickup_code IS NULL AND ticket_no IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS orders_pickup_code_uidx
  ON orders (org_id, store_id, pickup_code)
  WHERE pickup_code IS NOT NULL;

-- Prefix lookup is deliberate: it bounds surname/name searches and keeps an indexable plan.
CREATE INDEX IF NOT EXISTS orders_store_customer_name_prefix_idx
  ON orders (org_id, store_id, lower(customer_name) text_pattern_ops, created_at DESC)
  WHERE customer_name IS NOT NULL;
