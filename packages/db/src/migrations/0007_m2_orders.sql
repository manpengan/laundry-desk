-- Expand-only: M2 order skeleton (orders / order_lines / garments / ticket_counters).
-- Maps from runtime OrderRecord + GarmentRecord; no catalog/payments yet.
-- Composite tenant keys follow ADR-02/03 and packages/contracts tenant layouts.

-- ---------------------------------------------------------------------------
-- orders (store-scoped)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS orders (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  ticket_no text NOT NULL,
  status text NOT NULL,
  customer_phone text,
  customer_name text,
  note text,
  subtotal_cents integer NOT NULL,
  payable_cents integer NOT NULL,
  paid_cents integer NOT NULL,
  balance_cents integer NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  created_by_staff_id uuid NOT NULL,
  CONSTRAINT orders_store_fk
    FOREIGN KEY (org_id, store_id) REFERENCES stores (org_id, id),
  CONSTRAINT orders_created_by_staff_fk
    FOREIGN KEY (org_id, created_by_staff_id) REFERENCES staffs (org_id, id),
  CONSTRAINT orders_status_chk
    CHECK (status IN ('open', 'closed', 'cancelled')),
  CONSTRAINT orders_subtotal_cents_chk CHECK (subtotal_cents >= 0),
  CONSTRAINT orders_payable_cents_chk CHECK (payable_cents >= 0),
  CONSTRAINT orders_paid_cents_chk CHECK (paid_cents >= 0),
  CONSTRAINT orders_balance_cents_chk CHECK (balance_cents >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS orders_tenant_id_uidx
  ON orders (org_id, store_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS orders_ticket_no_uidx
  ON orders (org_id, store_id, ticket_no);
CREATE INDEX IF NOT EXISTS orders_store_status_created_idx
  ON orders (org_id, store_id, status, created_at);

ALTER TABLE "public"."orders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."orders" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "orders_store_scope" ON "public"."orders";
CREATE POLICY "orders_store_scope" ON "public"."orders"
  AS PERMISSIVE
  FOR ALL
  TO "laundry_app"
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid);

DROP POLICY IF EXISTS "orders_maintenance" ON "public"."orders";
CREATE POLICY "orders_maintenance" ON "public"."orders"
  AS PERMISSIVE
  FOR ALL
  TO "laundry_owner"
  USING (true)
  WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE orders TO laundry_app;

-- ---------------------------------------------------------------------------
-- order_lines (store-scoped; child of orders)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS order_lines (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  order_id uuid NOT NULL,
  line_index integer NOT NULL,
  service_code text NOT NULL,
  category_code text NOT NULL,
  unit_price_cents integer NOT NULL,
  qty integer NOT NULL,
  line_total_cents integer NOT NULL,
  color text,
  brand text,
  CONSTRAINT order_lines_order_fk
    FOREIGN KEY (org_id, store_id, order_id)
    REFERENCES orders (org_id, store_id, id),
  CONSTRAINT order_lines_line_index_chk CHECK (line_index >= 0),
  CONSTRAINT order_lines_unit_price_cents_chk CHECK (unit_price_cents >= 0),
  CONSTRAINT order_lines_qty_chk CHECK (qty > 0),
  CONSTRAINT order_lines_line_total_cents_chk CHECK (line_total_cents >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS order_lines_tenant_id_uidx
  ON order_lines (org_id, store_id, order_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS order_lines_line_index_uidx
  ON order_lines (org_id, store_id, order_id, line_index);
CREATE INDEX IF NOT EXISTS order_lines_order_idx
  ON order_lines (org_id, store_id, order_id);

ALTER TABLE "public"."order_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."order_lines" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "order_lines_store_scope" ON "public"."order_lines";
CREATE POLICY "order_lines_store_scope" ON "public"."order_lines"
  AS PERMISSIVE
  FOR ALL
  TO "laundry_app"
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid);

DROP POLICY IF EXISTS "order_lines_maintenance" ON "public"."order_lines";
CREATE POLICY "order_lines_maintenance" ON "public"."order_lines"
  AS PERMISSIVE
  FOR ALL
  TO "laundry_owner"
  USING (true)
  WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE order_lines TO laundry_app;

-- ---------------------------------------------------------------------------
-- garments (store-scoped; child of orders + order_lines; no qty)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS garments (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  order_id uuid NOT NULL,
  order_line_id uuid NOT NULL,
  seq integer NOT NULL,
  barcode text NOT NULL,
  service_code text NOT NULL,
  category_code text NOT NULL,
  unit_price_cents integer NOT NULL,
  color text,
  brand text,
  status text NOT NULL DEFAULT 'received',
  CONSTRAINT garments_order_fk
    FOREIGN KEY (org_id, store_id, order_id)
    REFERENCES orders (org_id, store_id, id),
  CONSTRAINT garments_order_line_fk
    FOREIGN KEY (org_id, store_id, order_id, order_line_id)
    REFERENCES order_lines (org_id, store_id, order_id, id),
  CONSTRAINT garments_status_chk
    CHECK (status IN (
      'received',
      'washing',
      'ready',
      'racked',
      'picked_up',
      'delivered',
      'reworked',
      'lost'
    )),
  CONSTRAINT garments_seq_chk CHECK (seq >= 1),
  CONSTRAINT garments_unit_price_cents_chk CHECK (unit_price_cents >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS garments_tenant_id_uidx
  ON garments (org_id, store_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS garments_barcode_uidx
  ON garments (org_id, store_id, barcode);
CREATE UNIQUE INDEX IF NOT EXISTS garments_line_seq_uidx
  ON garments (org_id, store_id, order_id, order_line_id, seq);
CREATE INDEX IF NOT EXISTS garments_order_idx
  ON garments (org_id, store_id, order_id);
CREATE INDEX IF NOT EXISTS garments_store_status_idx
  ON garments (org_id, store_id, status);

ALTER TABLE "public"."garments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."garments" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "garments_store_scope" ON "public"."garments";
CREATE POLICY "garments_store_scope" ON "public"."garments"
  AS PERMISSIVE
  FOR ALL
  TO "laundry_app"
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid);

DROP POLICY IF EXISTS "garments_maintenance" ON "public"."garments";
CREATE POLICY "garments_maintenance" ON "public"."garments"
  AS PERMISSIVE
  FOR ALL
  TO "laundry_owner"
  USING (true)
  WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE garments TO laundry_app;

-- ---------------------------------------------------------------------------
-- ticket_counters (store-scoped helper for nextTicketSeq; not in A3 matrix)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ticket_counters (
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  day_key text NOT NULL,
  last_seq integer NOT NULL DEFAULT 0,
  CONSTRAINT ticket_counters_pkey PRIMARY KEY (org_id, store_id, day_key),
  CONSTRAINT ticket_counters_store_fk
    FOREIGN KEY (org_id, store_id) REFERENCES stores (org_id, id),
  CONSTRAINT ticket_counters_last_seq_chk CHECK (last_seq >= 0)
);

ALTER TABLE "public"."ticket_counters" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."ticket_counters" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ticket_counters_store_scope" ON "public"."ticket_counters";
CREATE POLICY "ticket_counters_store_scope" ON "public"."ticket_counters"
  AS PERMISSIVE
  FOR ALL
  TO "laundry_app"
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid);

DROP POLICY IF EXISTS "ticket_counters_maintenance" ON "public"."ticket_counters";
CREATE POLICY "ticket_counters_maintenance" ON "public"."ticket_counters"
  AS PERMISSIVE
  FOR ALL
  TO "laundry_owner"
  USING (true)
  WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ticket_counters TO laundry_app;
