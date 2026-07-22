-- Expand-only: M2 payments append-only ledger (ADR-03 §7).
-- Business corrections are red冲 rows (kind=reversal + ref_payment_id), never UPDATE/DELETE.
-- laundry_app: SELECT, INSERT only (same posture as audit_log).

CREATE TABLE IF NOT EXISTS payments (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  order_id uuid NOT NULL,
  method text NOT NULL DEFAULT 'cash',
  amount_cents integer NOT NULL,
  kind text NOT NULL,
  ref_payment_id uuid,
  staff_id uuid NOT NULL,
  at timestamptz NOT NULL,
  note text,
  CONSTRAINT payments_tenant_id_uidx UNIQUE (org_id, store_id, id),
  CONSTRAINT payments_store_fk
    FOREIGN KEY (org_id, store_id) REFERENCES stores (org_id, id),
  CONSTRAINT payments_order_fk
    FOREIGN KEY (org_id, store_id, order_id)
    REFERENCES orders (org_id, store_id, id),
  CONSTRAINT payments_staff_fk
    FOREIGN KEY (org_id, staff_id) REFERENCES staffs (org_id, id),
  CONSTRAINT payments_ref_payment_fk
    FOREIGN KEY (org_id, store_id, ref_payment_id)
    REFERENCES payments (org_id, store_id, id),
  CONSTRAINT payments_method_chk
    CHECK (method IN ('cash', 'wechat', 'alipay', 'other')),
  CONSTRAINT payments_kind_chk
    CHECK (kind IN ('pay', 'repay', 'refund', 'storage_fee', 'reversal')),
  CONSTRAINT payments_amount_cents_chk CHECK (amount_cents > 0)
);

CREATE INDEX IF NOT EXISTS payments_order_at_idx
  ON payments (org_id, store_id, order_id, at);
CREATE INDEX IF NOT EXISTS payments_store_at_idx
  ON payments (org_id, store_id, at);

ALTER TABLE "public"."payments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."payments" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "payments_store_scope" ON "public"."payments";
CREATE POLICY "payments_store_scope" ON "public"."payments"
  AS PERMISSIVE
  FOR ALL
  TO "laundry_app"
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid);

DROP POLICY IF EXISTS "payments_maintenance" ON "public"."payments";
CREATE POLICY "payments_maintenance" ON "public"."payments"
  AS PERMISSIVE
  FOR ALL
  TO "laundry_owner"
  USING (true)
  WITH CHECK (true);

-- Append-only for app role: no UPDATE/DELETE (anti-tamper via privileges).
GRANT SELECT, INSERT ON TABLE payments TO laundry_app;
