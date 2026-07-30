-- Rack authority for scan-to-rack and pickup verification.
-- Existing racked rows remain readable as legacy data; the NOT VALID check is
-- enforced for every new/updated row without inventing a historic location.

ALTER TABLE garments
  ADD COLUMN IF NOT EXISTS rack_zone text,
  ADD COLUMN IF NOT EXISTS rack_slot text,
  ADD COLUMN IF NOT EXISTS racked_at timestamptz,
  ADD COLUMN IF NOT EXISTS racked_by_staff_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'garments_racked_by_staff_fk'
       AND conrelid = 'garments'::regclass
  ) THEN
    ALTER TABLE garments
      ADD CONSTRAINT garments_racked_by_staff_fk
      FOREIGN KEY (org_id, racked_by_staff_id) REFERENCES staffs (org_id, id);
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'garments_rack_fields_chk'
       AND conrelid = 'garments'::regclass
  ) THEN
    ALTER TABLE garments
      ADD CONSTRAINT garments_rack_fields_chk CHECK (
        (rack_zone IS NULL AND rack_slot IS NULL AND racked_at IS NULL AND racked_by_staff_id IS NULL)
        OR (
          rack_zone IS NOT NULL
          AND char_length(rack_zone) BETWEEN 1 AND 16
          AND rack_slot IS NOT NULL
          AND char_length(rack_slot) BETWEEN 1 AND 16
          AND racked_at IS NOT NULL
          AND racked_by_staff_id IS NOT NULL
        )
      ) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'garments_racked_location_chk'
       AND conrelid = 'garments'::regclass
  ) THEN
    ALTER TABLE garments
      ADD CONSTRAINT garments_racked_location_chk CHECK (
        status <> 'racked' OR (rack_zone IS NOT NULL AND rack_slot IS NOT NULL)
      ) NOT VALID;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS garments_store_rack_idx
  ON garments (org_id, store_id, rack_zone, rack_slot)
  WHERE rack_zone IS NOT NULL AND rack_slot IS NOT NULL;

CREATE TABLE IF NOT EXISTS garment_rack_log (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  order_id uuid NOT NULL,
  garment_id uuid NOT NULL,
  barcode text NOT NULL,
  rack_zone text NOT NULL,
  rack_slot text NOT NULL,
  staff_id uuid NOT NULL,
  at timestamptz NOT NULL,
  CONSTRAINT garment_rack_log_tenant_id_uidx UNIQUE (org_id, store_id, id),
  CONSTRAINT garment_rack_log_garment_fk
    FOREIGN KEY (org_id, store_id, order_id, garment_id)
    REFERENCES garments (org_id, store_id, order_id, id),
  CONSTRAINT garment_rack_log_staff_fk
    FOREIGN KEY (org_id, staff_id) REFERENCES staffs (org_id, id),
  CONSTRAINT garment_rack_log_barcode_chk CHECK (char_length(barcode) BETWEEN 1 AND 64),
  CONSTRAINT garment_rack_log_zone_chk CHECK (char_length(rack_zone) BETWEEN 1 AND 16),
  CONSTRAINT garment_rack_log_slot_chk CHECK (char_length(rack_slot) BETWEEN 1 AND 16)
);

CREATE INDEX IF NOT EXISTS garment_rack_log_garment_at_idx
  ON garment_rack_log (org_id, store_id, garment_id, at DESC);

ALTER TABLE garment_rack_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE garment_rack_log FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS garment_rack_log_store_scope ON garment_rack_log;
CREATE POLICY garment_rack_log_store_scope ON garment_rack_log
  AS PERMISSIVE FOR ALL TO laundry_app
  USING (
    org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid
  );

DROP POLICY IF EXISTS garment_rack_log_maintenance ON garment_rack_log;
CREATE POLICY garment_rack_log_maintenance ON garment_rack_log
  AS PERMISSIVE FOR ALL TO laundry_owner USING (true) WITH CHECK (true);

GRANT SELECT, INSERT ON TABLE garment_rack_log TO laundry_app;
