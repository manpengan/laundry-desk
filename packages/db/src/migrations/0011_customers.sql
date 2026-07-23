-- Expand-only: M2 customers archive (org-scoped, one profile per phone per org).
-- Architecture A3 matrix: customers scope = org (app.org_id only).
-- laundry_app: SELECT, INSERT, UPDATE (no DELETE).

CREATE TABLE IF NOT EXISTS customers (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  phone text NOT NULL,
  name text,
  note text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT customers_tenant_id_uidx UNIQUE (org_id, id),
  CONSTRAINT customers_org_phone_uidx UNIQUE (org_id, phone),
  CONSTRAINT customers_org_fk
    FOREIGN KEY (org_id) REFERENCES orgs (id)
);

CREATE INDEX IF NOT EXISTS customers_org_phone_idx
  ON customers (org_id, phone);
CREATE INDEX IF NOT EXISTS customers_org_updated_idx
  ON customers (org_id, updated_at DESC);

ALTER TABLE "public"."customers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."customers" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "customers_org_scope" ON "public"."customers";
CREATE POLICY "customers_org_scope" ON "public"."customers"
  AS PERMISSIVE
  FOR ALL
  TO "laundry_app"
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

DROP POLICY IF EXISTS "customers_maintenance" ON "public"."customers";
CREATE POLICY "customers_maintenance" ON "public"."customers"
  AS PERMISSIVE
  FOR ALL
  TO "laundry_owner"
  USING (true)
  WITH CHECK (true);

-- Profile edits need UPDATE; soft-delete not in M2 skeleton.
GRANT SELECT, INSERT, UPDATE ON TABLE customers TO laundry_app;
