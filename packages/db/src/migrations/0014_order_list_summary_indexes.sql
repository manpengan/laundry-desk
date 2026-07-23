-- Expand-only: support order.list newest-first and customer-history reads.
-- 0013 is already garment_photos on main; do not renumber or replace it.

CREATE INDEX IF NOT EXISTS orders_store_created_ticket_idx
  ON orders (org_id, store_id, created_at DESC, ticket_no DESC);

CREATE INDEX IF NOT EXISTS orders_store_customer_created_ticket_idx
  ON orders (org_id, store_id, customer_phone, created_at DESC, ticket_no DESC);
