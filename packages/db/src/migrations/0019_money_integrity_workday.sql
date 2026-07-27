-- Local-first Money Integrity + Workday Commands.
--
-- This migration is expand-only: it makes the ledger-derived counter flow
-- durable without deleting or rewriting historical ledger rows.

-- ---------------------------------------------------------------------------
-- Orders: immutable price snapshot components, draft support and business day.
-- ---------------------------------------------------------------------------

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS original_cents integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS discount_cents integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS addon_cents integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS urgent_cents integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS freight_cents integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS business_date text;

UPDATE orders
SET original_cents = subtotal_cents
WHERE original_cents = 0 AND subtotal_cents > 0;

UPDATE orders AS order_row
SET business_date = to_char(order_row.created_at AT TIME ZONE store.timezone, 'YYYY-MM-DD')
FROM stores AS store
WHERE order_row.business_date IS NULL
  AND store.org_id = order_row.org_id
  AND store.id = order_row.store_id;

ALTER TABLE orders
  ALTER COLUMN business_date SET NOT NULL,
  ALTER COLUMN ticket_no DROP NOT NULL;

-- PostgreSQL has no ALTER CHECK expression. This narrow replacement only adds
-- `draft`; the migration guard allows this exact non-data-loss statement.
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_chk;
ALTER TABLE orders ADD CONSTRAINT orders_status_chk
  CHECK (status IN ('draft', 'open', 'closed', 'cancelled'));
ALTER TABLE orders ADD CONSTRAINT orders_original_cents_chk CHECK (original_cents >= 0);
ALTER TABLE orders ADD CONSTRAINT orders_discount_cents_chk
  CHECK (discount_cents >= 0 AND discount_cents <= original_cents);
ALTER TABLE orders ADD CONSTRAINT orders_addon_cents_chk CHECK (addon_cents >= 0);
ALTER TABLE orders ADD CONSTRAINT orders_urgent_cents_chk CHECK (urgent_cents >= 0);
ALTER TABLE orders ADD CONSTRAINT orders_freight_cents_chk CHECK (freight_cents >= 0);
ALTER TABLE orders ADD CONSTRAINT orders_business_date_chk
  CHECK (business_date ~ '^\\d{4}-\\d{2}-\\d{2}$');

CREATE INDEX IF NOT EXISTS orders_store_business_date_idx
  ON orders (org_id, store_id, business_date, created_at DESC);

-- ---------------------------------------------------------------------------
-- Payments: every ledger row belongs to the server-derived business day.
-- ---------------------------------------------------------------------------

ALTER TABLE payments ADD COLUMN IF NOT EXISTS business_date text;

UPDATE payments AS payment
SET business_date = to_char(payment.at AT TIME ZONE store.timezone, 'YYYY-MM-DD')
FROM stores AS store
WHERE payment.business_date IS NULL
  AND store.org_id = payment.org_id
  AND store.id = payment.store_id;

ALTER TABLE payments ALTER COLUMN business_date SET NOT NULL;
ALTER TABLE payments ADD CONSTRAINT payments_business_date_chk
  CHECK (business_date ~ '^\\d{4}-\\d{2}-\\d{2}$');
CREATE INDEX IF NOT EXISTS payments_store_business_date_idx
  ON payments (org_id, store_id, business_date, at DESC);

-- ---------------------------------------------------------------------------
-- Shift snapshots: cash reconciliation is immutable and recordable.
-- ---------------------------------------------------------------------------

ALTER TABLE shift_closings
  ADD COLUMN IF NOT EXISTS opening_float_cents integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS counted_cash_cents integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS retained_float_cents integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS expected_cash_cents integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cash_difference_cents integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS period_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS period_ended_at timestamptz;

UPDATE shift_closings
SET period_started_at = closed_at,
    period_ended_at = closed_at
WHERE period_started_at IS NULL OR period_ended_at IS NULL;

ALTER TABLE shift_closings
  ALTER COLUMN period_started_at SET NOT NULL,
  ALTER COLUMN period_ended_at SET NOT NULL;

ALTER TABLE shift_closings ADD CONSTRAINT shift_closings_opening_float_cents_chk
  CHECK (opening_float_cents >= 0);
ALTER TABLE shift_closings ADD CONSTRAINT shift_closings_counted_cash_cents_chk
  CHECK (counted_cash_cents >= 0);
ALTER TABLE shift_closings ADD CONSTRAINT shift_closings_retained_float_cents_chk
  CHECK (retained_float_cents >= 0);
ALTER TABLE shift_closings ADD CONSTRAINT shift_closings_period_chk
  CHECK (period_ended_at >= period_started_at);

-- ---------------------------------------------------------------------------
-- Command idempotency: transaction-local claims make retries durable.
-- The response is written in the same transaction as the business mutation and
-- audit record; failed transactions leave no stale in-progress claim behind.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS command_idempotency (
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  command text NOT NULL,
  idempotency_key uuid NOT NULL,
  request_hash text NOT NULL,
  status text NOT NULL DEFAULT 'in_progress',
  result_json jsonb,
  completed_at timestamptz,
  CONSTRAINT command_idempotency_pkey PRIMARY KEY (org_id, store_id, command, idempotency_key),
  CONSTRAINT command_idempotency_store_fk
    FOREIGN KEY (org_id, store_id) REFERENCES stores (org_id, id),
  CONSTRAINT command_idempotency_status_chk CHECK (status IN ('in_progress', 'completed')),
  CONSTRAINT command_idempotency_result_chk CHECK (
    (status = 'in_progress' AND result_json IS NULL AND completed_at IS NULL)
    OR (status = 'completed' AND jsonb_typeof(result_json) = 'object' AND completed_at IS NOT NULL)
  )
);

ALTER TABLE "public"."command_idempotency" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."command_idempotency" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "command_idempotency_store_scope" ON "public"."command_idempotency";
CREATE POLICY "command_idempotency_store_scope" ON "public"."command_idempotency"
  AS PERMISSIVE
  FOR ALL
  TO "laundry_app"
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid);

DROP POLICY IF EXISTS "command_idempotency_maintenance" ON "public"."command_idempotency";
CREATE POLICY "command_idempotency_maintenance" ON "public"."command_idempotency"
  AS PERMISSIVE
  FOR ALL
  TO "laundry_owner"
  USING (true)
  WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE ON TABLE command_idempotency TO laundry_app;
