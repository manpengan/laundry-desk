-- Expand-only: durable PIN lockouts (A5 / design §3.4 — 15-minute staff×device lock).
-- Store-scoped like pin_challenges; natural key is (org, store, staff, device).

CREATE TABLE IF NOT EXISTS pin_lockouts (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  staff_id uuid NOT NULL,
  device_id uuid NOT NULL,
  locked_until timestamptz NOT NULL,
  failed_attempts integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL,
  CONSTRAINT pin_lockouts_store_fk
    FOREIGN KEY (org_id, store_id) REFERENCES stores (org_id, id),
  CONSTRAINT pin_lockouts_staff_fk
    FOREIGN KEY (org_id, staff_id) REFERENCES staffs (org_id, id),
  CONSTRAINT pin_lockouts_failed_attempts_chk CHECK (failed_attempts >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS pin_lockouts_tenant_id_uidx
  ON pin_lockouts (org_id, store_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS pin_lockouts_staff_device_uidx
  ON pin_lockouts (org_id, store_id, staff_id, device_id);

ALTER TABLE "public"."pin_lockouts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."pin_lockouts" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "pin_lockouts_store_scope" ON "public"."pin_lockouts";
CREATE POLICY "pin_lockouts_store_scope" ON "public"."pin_lockouts"
  AS PERMISSIVE
  FOR ALL
  TO "laundry_app"
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid);

DROP POLICY IF EXISTS "pin_lockouts_maintenance" ON "public"."pin_lockouts";
CREATE POLICY "pin_lockouts_maintenance" ON "public"."pin_lockouts"
  AS PERMISSIVE
  FOR ALL
  TO "laundry_owner"
  USING (true)
  WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE pin_lockouts TO laundry_app;
