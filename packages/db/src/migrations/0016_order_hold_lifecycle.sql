-- M2 order hold marker. Contract v0.2 deliberately retains status='open';
-- the required reason is persisted for recovery/audit without inventing a draft state.

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS hold_reason text,
  ADD COLUMN IF NOT EXISTS held_at timestamptz,
  ADD COLUMN IF NOT EXISTS held_by_staff_id uuid;

ALTER TABLE orders
  ADD CONSTRAINT orders_hold_reason_length_chk
  CHECK (hold_reason IS NULL OR char_length(btrim(hold_reason)) BETWEEN 1 AND 256);

ALTER TABLE orders
  ADD CONSTRAINT orders_held_by_staff_fk
  FOREIGN KEY (org_id, held_by_staff_id) REFERENCES staffs (org_id, id);

CREATE INDEX IF NOT EXISTS orders_store_hold_created_idx
  ON orders (org_id, store_id, created_at DESC)
  WHERE hold_reason IS NOT NULL;
