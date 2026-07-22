-- Expand-only: M2 print_jobs queue (store-scoped ticket print lifecycle).
-- Status: queued → printing → done | failed.
-- No FK to orders (enqueue may race seed / offline order ids); documented soft bind via order_id.
-- laundry_app: SELECT, INSERT, UPDATE (status transitions); no DELETE.

CREATE TABLE IF NOT EXISTS print_jobs (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  order_id uuid NOT NULL,
  ticket_no text NOT NULL,
  kind text NOT NULL,
  status text NOT NULL,
  error text,
  payload_bytes integer,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT print_jobs_tenant_id_uidx UNIQUE (org_id, store_id, id),
  CONSTRAINT print_jobs_store_fk
    FOREIGN KEY (org_id, store_id) REFERENCES stores (org_id, id),
  CONSTRAINT print_jobs_kind_chk
    CHECK (kind IN ('xp58', 'dl206', 'gp3120')),
  CONSTRAINT print_jobs_status_chk
    CHECK (status IN ('queued', 'printing', 'done', 'failed')),
  CONSTRAINT print_jobs_payload_bytes_chk
    CHECK (payload_bytes IS NULL OR payload_bytes >= 0)
);

CREATE INDEX IF NOT EXISTS print_jobs_store_created_idx
  ON print_jobs (org_id, store_id, created_at DESC);
CREATE INDEX IF NOT EXISTS print_jobs_store_status_idx
  ON print_jobs (org_id, store_id, status);

ALTER TABLE "public"."print_jobs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."print_jobs" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "print_jobs_store_scope" ON "public"."print_jobs";
CREATE POLICY "print_jobs_store_scope" ON "public"."print_jobs"
  AS PERMISSIVE
  FOR ALL
  TO "laundry_app"
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid);

DROP POLICY IF EXISTS "print_jobs_maintenance" ON "public"."print_jobs";
CREATE POLICY "print_jobs_maintenance" ON "public"."print_jobs"
  AS PERMISSIVE
  FOR ALL
  TO "laundry_owner"
  USING (true)
  WITH CHECK (true);

-- Status transitions need UPDATE; jobs are not deleted by app role.
GRANT SELECT, INSERT, UPDATE ON TABLE print_jobs TO laundry_app;
