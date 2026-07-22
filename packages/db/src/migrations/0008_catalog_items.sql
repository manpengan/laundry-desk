-- Expand-only: M2 catalog price list (store-scoped service × category rows).
-- Domain CatalogItem maps code/name/service_code/category_code/unit_price_cents/mnemonic.
-- App seeds demo rows on first list when empty (see createPgCatalogStore).

CREATE TABLE IF NOT EXISTS catalog_items (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  service_code text NOT NULL,
  category_code text NOT NULL,
  unit_price_cents integer NOT NULL,
  mnemonic text,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT catalog_items_store_fk
    FOREIGN KEY (org_id, store_id) REFERENCES stores (org_id, id),
  CONSTRAINT catalog_items_unit_price_cents_chk CHECK (unit_price_cents >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS catalog_items_tenant_id_uidx
  ON catalog_items (org_id, store_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS catalog_items_code_uidx
  ON catalog_items (org_id, store_id, code);
CREATE INDEX IF NOT EXISTS catalog_items_store_active_sort_idx
  ON catalog_items (org_id, store_id, is_active, sort_order);

ALTER TABLE "public"."catalog_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."catalog_items" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "catalog_items_store_scope" ON "public"."catalog_items";
CREATE POLICY "catalog_items_store_scope" ON "public"."catalog_items"
  AS PERMISSIVE
  FOR ALL
  TO "laundry_app"
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid);

DROP POLICY IF EXISTS "catalog_items_maintenance" ON "public"."catalog_items";
CREATE POLICY "catalog_items_maintenance" ON "public"."catalog_items"
  AS PERMISSIVE
  FOR ALL
  TO "laundry_owner"
  USING (true)
  WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE catalog_items TO laundry_app;
