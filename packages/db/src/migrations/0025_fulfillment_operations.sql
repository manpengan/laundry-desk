-- Fulfillment operations: immutable garment status history and incident records.
-- Both tables are store-scoped, append-only for laundry_app and bound to the
-- exact garment/order tenant tuple.

CREATE TABLE IF NOT EXISTS garment_status_log (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  order_id uuid NOT NULL,
  garment_id uuid NOT NULL,
  from_status text NOT NULL,
  to_status text NOT NULL,
  reason text,
  staff_id uuid NOT NULL,
  at timestamptz NOT NULL,
  CONSTRAINT garment_status_log_tenant_id_uidx UNIQUE (org_id, store_id, id),
  CONSTRAINT garment_status_log_garment_fk
    FOREIGN KEY (org_id, store_id, order_id, garment_id)
    REFERENCES garments (org_id, store_id, order_id, id),
  CONSTRAINT garment_status_log_staff_fk
    FOREIGN KEY (org_id, staff_id) REFERENCES staffs (org_id, id),
  CONSTRAINT garment_status_log_from_status_chk CHECK (
    from_status IN ('received', 'washing', 'ready', 'racked', 'picked_up', 'delivered', 'reworked', 'lost')
  ),
  CONSTRAINT garment_status_log_to_status_chk CHECK (
    to_status IN ('received', 'washing', 'ready', 'racked', 'picked_up', 'delivered', 'reworked', 'lost')
  ),
  CONSTRAINT garment_status_log_change_chk CHECK (from_status <> to_status),
  CONSTRAINT garment_status_log_reason_chk CHECK (
    reason IS NULL OR char_length(reason) BETWEEN 1 AND 256
  )
);

CREATE INDEX IF NOT EXISTS garment_status_log_garment_at_idx
  ON garment_status_log (org_id, store_id, garment_id, at DESC);

ALTER TABLE garment_status_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE garment_status_log FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS garment_status_log_store_scope ON garment_status_log;
CREATE POLICY garment_status_log_store_scope ON garment_status_log
  AS PERMISSIVE FOR ALL TO laundry_app
  USING (
    org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid
  );

DROP POLICY IF EXISTS garment_status_log_maintenance ON garment_status_log;
CREATE POLICY garment_status_log_maintenance ON garment_status_log
  AS PERMISSIVE FOR ALL TO laundry_owner USING (true) WITH CHECK (true);

GRANT SELECT, INSERT ON TABLE garment_status_log TO laundry_app;

CREATE TABLE IF NOT EXISTS garment_incidents (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  order_id uuid NOT NULL,
  garment_id uuid NOT NULL,
  kind text NOT NULL,
  note text NOT NULL,
  compensation_cents integer NOT NULL DEFAULT 0,
  staff_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT garment_incidents_tenant_id_uidx UNIQUE (org_id, store_id, id),
  CONSTRAINT garment_incidents_garment_fk
    FOREIGN KEY (org_id, store_id, order_id, garment_id)
    REFERENCES garments (org_id, store_id, order_id, id),
  CONSTRAINT garment_incidents_staff_fk
    FOREIGN KEY (org_id, staff_id) REFERENCES staffs (org_id, id),
  CONSTRAINT garment_incidents_kind_chk CHECK (kind IN ('rework', 'damage', 'lost', 'other')),
  CONSTRAINT garment_incidents_note_chk CHECK (char_length(note) BETWEEN 1 AND 256),
  CONSTRAINT garment_incidents_compensation_chk CHECK (compensation_cents >= 0)
);

CREATE INDEX IF NOT EXISTS garment_incidents_garment_created_idx
  ON garment_incidents (org_id, store_id, garment_id, created_at DESC);

ALTER TABLE garment_incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE garment_incidents FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS garment_incidents_store_scope ON garment_incidents;
CREATE POLICY garment_incidents_store_scope ON garment_incidents
  AS PERMISSIVE FOR ALL TO laundry_app
  USING (
    org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid
  );

DROP POLICY IF EXISTS garment_incidents_maintenance ON garment_incidents;
CREATE POLICY garment_incidents_maintenance ON garment_incidents
  AS PERMISSIVE FOR ALL TO laundry_owner USING (true) WITH CHECK (true);

GRANT SELECT, INSERT ON TABLE garment_incidents TO laundry_app;
