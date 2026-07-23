-- Expand-only: M3 garment_photos metadata skeleton (store-scoped).
-- Metadata only — storage_key is opaque (S3/path later); no blob columns.
-- Soft-binds garment_id / order_id (no garments/orders FK — seed / offline race).
-- laundry_app: SELECT, INSERT only (no DELETE; soft-delete later if needed).

CREATE TABLE IF NOT EXISTS garment_photos (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  garment_id uuid NOT NULL,
  order_id uuid NOT NULL,
  kind text NOT NULL,
  storage_key text NOT NULL,
  content_type text NOT NULL DEFAULT 'image/jpeg',
  byte_size integer NOT NULL,
  taken_at timestamptz NOT NULL,
  created_by_staff_id uuid NOT NULL,
  CONSTRAINT garment_photos_tenant_id_uidx UNIQUE (org_id, store_id, id),
  CONSTRAINT garment_photos_store_fk
    FOREIGN KEY (org_id, store_id) REFERENCES stores (org_id, id),
  CONSTRAINT garment_photos_staff_fk
    FOREIGN KEY (org_id, created_by_staff_id) REFERENCES staffs (org_id, id),
  CONSTRAINT garment_photos_kind_chk
    CHECK (kind IN ('receive', 'defect', 'ready', 'other')),
  CONSTRAINT garment_photos_byte_size_chk CHECK (byte_size > 0),
  CONSTRAINT garment_photos_storage_key_chk
    CHECK (char_length(storage_key) >= 1 AND char_length(storage_key) <= 512),
  CONSTRAINT garment_photos_content_type_chk
    CHECK (char_length(content_type) >= 1 AND char_length(content_type) <= 128)
);

CREATE INDEX IF NOT EXISTS garment_photos_order_idx
  ON garment_photos (org_id, store_id, order_id, taken_at DESC);
CREATE INDEX IF NOT EXISTS garment_photos_garment_idx
  ON garment_photos (org_id, store_id, garment_id, taken_at DESC);

ALTER TABLE "public"."garment_photos" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."garment_photos" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "garment_photos_store_scope" ON "public"."garment_photos";
CREATE POLICY "garment_photos_store_scope" ON "public"."garment_photos"
  AS PERMISSIVE
  FOR ALL
  TO "laundry_app"
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid);

DROP POLICY IF EXISTS "garment_photos_maintenance" ON "public"."garment_photos";
CREATE POLICY "garment_photos_maintenance" ON "public"."garment_photos"
  AS PERMISSIVE
  FOR ALL
  TO "laundry_owner"
  USING (true)
  WITH CHECK (true);

-- Append-only metadata for app role: no UPDATE/DELETE.
GRANT SELECT, INSERT ON TABLE garment_photos TO laundry_app;
