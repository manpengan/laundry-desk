-- ADR-74: source-bound, append-only import receipts and erasable legacy fields.
CREATE TABLE IF NOT EXISTS public.v1_import_batches (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  plan_sha256 text NOT NULL CHECK (plan_sha256 ~ '^[0-9a-f]{64}$'),
  mapping_version integer NOT NULL CHECK (mapping_version = 1),
  backup_point_id text NOT NULL CHECK (char_length(backup_point_id) BETWEEN 1 AND 256),
  totals jsonb NOT NULL CHECK (jsonb_typeof(totals) = 'object'),
  actor_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT v1_import_batches_tenant_uidx UNIQUE (org_id, store_id, id),
  CONSTRAINT v1_import_batches_source_uidx UNIQUE (org_id, store_id, source_sha256),
  CONSTRAINT v1_import_batches_store_fk FOREIGN KEY (org_id, store_id) REFERENCES stores(org_id, id),
  CONSTRAINT v1_import_batches_actor_fk FOREIGN KEY (org_id, actor_id) REFERENCES staffs(org_id, id)
);
CREATE TABLE IF NOT EXISTS public.v1_import_legacy_records (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  entity_type text NOT NULL CHECK (entity_type IN ('customer', 'order', 'line', 'photo', 'setting', 'legacy_staff', 'legacy_sms', 'legacy_audit')),
  entity_id uuid NOT NULL,
  customer_id uuid,
  metadata jsonb NOT NULL CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT v1_import_legacy_records_entity_uidx UNIQUE (org_id, store_id, batch_id, entity_type, entity_id),
  CONSTRAINT v1_import_legacy_records_batch_fk FOREIGN KEY (org_id, store_id, batch_id)
    REFERENCES v1_import_batches(org_id, store_id, id),
  CONSTRAINT v1_import_legacy_records_customer_fk FOREIGN KEY (org_id, customer_id) REFERENCES customers(org_id, id),
  CONSTRAINT v1_import_legacy_records_subject_chk CHECK (
    (entity_type IN ('customer','order','line','photo') AND customer_id IS NOT NULL)
    OR (entity_type IN ('setting','legacy_staff','legacy_audit') AND customer_id IS NULL)
    OR entity_type = 'legacy_sms')
);
CREATE INDEX IF NOT EXISTS v1_import_legacy_records_customer_idx
  ON public.v1_import_legacy_records(org_id, customer_id);
CREATE INDEX IF NOT EXISTS v1_import_batches_actor_idx ON public.v1_import_batches(org_id, actor_id);

ALTER TABLE public.v1_import_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.v1_import_batches FORCE ROW LEVEL SECURITY;
CREATE POLICY v1_import_batches_store_scope ON public.v1_import_batches FOR ALL TO laundry_app
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
     AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
     AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid);
CREATE POLICY v1_import_batches_maintenance ON public.v1_import_batches FOR ALL TO laundry_owner
  USING (true) WITH CHECK (true);
ALTER TABLE public.v1_import_legacy_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.v1_import_legacy_records FORCE ROW LEVEL SECURITY;
CREATE POLICY v1_import_legacy_records_store_scope ON public.v1_import_legacy_records FOR ALL TO laundry_app
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
     AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
     AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid);
CREATE POLICY v1_import_legacy_records_maintenance ON public.v1_import_legacy_records FOR ALL TO laundry_owner
  USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON public.v1_import_batches, public.v1_import_legacy_records TO laundry_app;

-- Customer privacy already updates every canonical-group member in one audited
-- transaction. Delete supplemental legacy notes in that same transaction.
CREATE OR REPLACE FUNCTION public.erase_v1_import_customer_metadata() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.anonymized_at IS NOT NULL AND OLD.anonymized_at IS NULL THEN
    DELETE FROM public.v1_import_legacy_records WHERE org_id = NEW.org_id AND
      (customer_id = NEW.id OR entity_type = 'legacy_audit' OR (entity_type = 'legacy_sms' AND customer_id IS NULL));
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.erase_v1_import_customer_metadata() OWNER TO laundry_owner;
REVOKE ALL ON FUNCTION public.erase_v1_import_customer_metadata() FROM PUBLIC, laundry_app;
CREATE TRIGGER erase_v1_import_customer_metadata_trg AFTER UPDATE OF anonymized_at ON public.customers
  FOR EACH ROW EXECUTE FUNCTION public.erase_v1_import_customer_metadata();

-- A live admin session authorizes one offline maintenance request; runtime owns
-- the file root. Neither the database receipt nor ticket contains source PII.
CREATE TABLE IF NOT EXISTS public.v1_import_requests (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  session_id uuid NOT NULL,
  session_version integer NOT NULL CHECK (session_version > 0),
  permission_version integer NOT NULL CHECK (permission_version > 0),
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  plan_sha256 text NOT NULL CHECK (plan_sha256 ~ '^[0-9a-f]{64}$'),
  photos_sha256 text NOT NULL CHECK (photos_sha256 ~ '^[0-9a-f]{64}$'),
  approved_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  materials_deleted_at timestamptz,
  CONSTRAINT v1_import_requests_expiry_chk CHECK (expires_at > approved_at AND expires_at <= approved_at + interval '10 minutes'),
  CONSTRAINT v1_import_requests_store_fk FOREIGN KEY (org_id, store_id) REFERENCES stores(org_id, id),
  CONSTRAINT v1_import_requests_actor_fk FOREIGN KEY (org_id, actor_id) REFERENCES staffs(org_id, id),
  CONSTRAINT v1_import_requests_session_fk FOREIGN KEY (org_id, store_id, session_id) REFERENCES sessions(org_id, store_id, id)
);
ALTER TABLE public.v1_import_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.v1_import_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY v1_import_requests_store_scope ON public.v1_import_requests FOR ALL TO laundry_app
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
     AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
     AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid);
CREATE POLICY v1_import_requests_maintenance ON public.v1_import_requests FOR ALL TO laundry_owner
  USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON public.v1_import_requests TO laundry_app;
GRANT UPDATE(consumed_at, materials_deleted_at) ON public.v1_import_requests TO laundry_app;
CREATE INDEX IF NOT EXISTS v1_import_requests_actor_idx ON public.v1_import_requests(org_id, actor_id);
CREATE INDEX IF NOT EXISTS v1_import_requests_session_idx ON public.v1_import_requests(org_id, store_id, session_id);
CREATE INDEX IF NOT EXISTS v1_import_requests_cleanup_idx ON public.v1_import_requests(org_id, store_id, expires_at, id)
  WHERE materials_deleted_at IS NULL;
