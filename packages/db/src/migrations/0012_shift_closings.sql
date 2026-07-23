-- Expand-only: M2 shift_closings (日结签字 skeleton).
-- One close per store per business_date; append-only (no UPDATE/DELETE for laundry_app).
-- signature_name is a display-name skeleton, not a cryptographic signature.

CREATE TABLE IF NOT EXISTS shift_closings (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  business_date text NOT NULL,
  closed_by_staff_id uuid NOT NULL,
  note text,
  order_count integer NOT NULL DEFAULT 0,
  payable_cents integer NOT NULL DEFAULT 0,
  paid_cents integer NOT NULL DEFAULT 0,
  payment_cents integer NOT NULL DEFAULT 0,
  signature_name text NOT NULL,
  closed_at timestamptz NOT NULL,
  CONSTRAINT shift_closings_tenant_id_uidx UNIQUE (org_id, store_id, id),
  CONSTRAINT shift_closings_store_date_uidx UNIQUE (org_id, store_id, business_date),
  CONSTRAINT shift_closings_store_fk
    FOREIGN KEY (org_id, store_id) REFERENCES stores (org_id, id),
  CONSTRAINT shift_closings_staff_fk
    FOREIGN KEY (org_id, closed_by_staff_id) REFERENCES staffs (org_id, id),
  CONSTRAINT shift_closings_business_date_chk
    CHECK (business_date ~ '^\d{4}-\d{2}-\d{2}$'),
  CONSTRAINT shift_closings_order_count_chk CHECK (order_count >= 0),
  CONSTRAINT shift_closings_payable_cents_chk CHECK (payable_cents >= 0),
  CONSTRAINT shift_closings_paid_cents_chk CHECK (paid_cents >= 0),
  CONSTRAINT shift_closings_payment_cents_chk CHECK (payment_cents >= 0),
  CONSTRAINT shift_closings_signature_name_chk
    CHECK (char_length(signature_name) >= 1 AND char_length(signature_name) <= 64)
);

CREATE INDEX IF NOT EXISTS shift_closings_store_closed_at_idx
  ON shift_closings (org_id, store_id, closed_at DESC);

ALTER TABLE "public"."shift_closings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."shift_closings" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "shift_closings_store_scope" ON "public"."shift_closings";
CREATE POLICY "shift_closings_store_scope" ON "public"."shift_closings"
  AS PERMISSIVE
  FOR ALL
  TO "laundry_app"
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid);

DROP POLICY IF EXISTS "shift_closings_maintenance" ON "public"."shift_closings";
CREATE POLICY "shift_closings_maintenance" ON "public"."shift_closings"
  AS PERMISSIVE
  FOR ALL
  TO "laundry_owner"
  USING (true)
  WITH CHECK (true);

-- Append-only for app role: no UPDATE/DELETE (anti-tamper via privileges).
GRANT SELECT, INSERT ON TABLE shift_closings TO laundry_app;
