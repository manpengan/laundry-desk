-- ADR-23: append-only evidence for manual pickup-reminder list generation.
-- This table never claims delivery and deliberately stores no phone, message
-- body or CSV. Hashes bind the generated artifact without retaining extra PII.

CREATE TABLE IF NOT EXISTS notification_log (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  order_id uuid NOT NULL,
  customer_id uuid,
  channel text NOT NULL,
  status text NOT NULL,
  grouping text NOT NULL,
  message_sha256 char(64) NOT NULL,
  export_sha256 char(64) NOT NULL,
  cost_cents integer NOT NULL DEFAULT 0,
  created_by_staff_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT notification_log_tenant_id_uidx UNIQUE (org_id, id),
  CONSTRAINT notification_log_batch_order_uidx UNIQUE (org_id, batch_id, order_id),
  CONSTRAINT notification_log_store_fk
    FOREIGN KEY (org_id, store_id) REFERENCES stores (org_id, id),
  CONSTRAINT notification_log_order_fk
    FOREIGN KEY (org_id, store_id, order_id) REFERENCES orders (org_id, store_id, id),
  CONSTRAINT notification_log_customer_fk
    FOREIGN KEY (org_id, customer_id) REFERENCES customers (org_id, id),
  CONSTRAINT notification_log_staff_fk
    FOREIGN KEY (org_id, created_by_staff_id) REFERENCES staffs (org_id, id),
  CONSTRAINT notification_log_channel_chk CHECK (channel = 'manual'),
  CONSTRAINT notification_log_status_chk CHECK (status = 'list_generated'),
  CONSTRAINT notification_log_grouping_chk CHECK (grouping IN ('order', 'customer')),
  CONSTRAINT notification_log_message_sha_chk CHECK (message_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT notification_log_export_sha_chk CHECK (export_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT notification_log_cost_chk CHECK (cost_cents = 0)
);

CREATE INDEX IF NOT EXISTS notification_log_store_created_idx
  ON notification_log (org_id, store_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notification_log_order_created_idx
  ON notification_log (org_id, store_id, order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notification_log_batch_idx
  ON notification_log (org_id, batch_id);

-- notification_log is organisation-scoped in the frozen A3 table matrix. Every
-- application query additionally filters store_id, but RLS itself remains the
-- exact org predicate required by that matrix.
ALTER TABLE notification_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_log FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS notification_log_org_scope ON notification_log;
CREATE POLICY notification_log_org_scope ON notification_log
  AS PERMISSIVE
  FOR ALL
  TO laundry_app
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

DROP POLICY IF EXISTS notification_log_maintenance ON notification_log;
CREATE POLICY notification_log_maintenance ON notification_log
  AS PERMISSIVE
  FOR ALL
  TO laundry_owner
  USING (true)
  WITH CHECK (true);

GRANT SELECT, INSERT ON TABLE notification_log TO laundry_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE notification_log FROM laundry_app;
