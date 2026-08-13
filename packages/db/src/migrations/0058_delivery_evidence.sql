-- ADR-51: append-only delivery pickup/return evidence and private attachment metadata.
-- Coordinates and media linkage stay out of audit_log, domain events and AI projections.

CREATE TABLE IF NOT EXISTS public.delivery_evidence_attachments (
  id uuid NOT NULL,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  delivery_order_id uuid NOT NULL,
  delivery_task_id uuid NOT NULL,
  leg text NOT NULL,
  delivery_task_version integer NOT NULL,
  assignee_staff_id uuid NOT NULL,
  kind text NOT NULL,
  storage_key text NOT NULL,
  content_type text NOT NULL,
  content_sha256 char(64) NOT NULL,
  byte_size integer NOT NULL,
  captured_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  created_by_staff_id uuid NOT NULL,
  CONSTRAINT delivery_evidence_attachments_pkey PRIMARY KEY (id),
  CONSTRAINT delivery_evidence_attachments_tenant_id_uidx UNIQUE (org_id, store_id, id),
  CONSTRAINT delivery_evidence_attachments_storage_uidx UNIQUE (org_id, store_id, storage_key),
  CONSTRAINT delivery_evidence_attachments_store_fk
    FOREIGN KEY (org_id, store_id) REFERENCES public.stores (org_id, id),
  CONSTRAINT delivery_evidence_attachments_order_fk
    FOREIGN KEY (org_id, store_id, delivery_order_id)
    REFERENCES public.delivery_orders (org_id, store_id, id),
  CONSTRAINT delivery_evidence_attachments_task_fk
    FOREIGN KEY (org_id, store_id, delivery_task_id)
    REFERENCES public.delivery_tasks (org_id, store_id, id),
  CONSTRAINT delivery_evidence_attachments_staff_fk
    FOREIGN KEY (org_id, created_by_staff_id) REFERENCES public.staffs (org_id, id),
  CONSTRAINT delivery_evidence_attachments_leg_chk CHECK (leg IN ('pickup', 'return')),
  CONSTRAINT delivery_evidence_attachments_version_chk CHECK (delivery_task_version > 0),
  CONSTRAINT delivery_evidence_attachments_kind_chk CHECK (kind IN ('photo', 'signature')),
  CONSTRAINT delivery_evidence_attachments_content_type_chk
    CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  CONSTRAINT delivery_evidence_attachments_digest_chk
    CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT delivery_evidence_attachments_size_chk CHECK (byte_size BETWEEN 1 AND 10000000),
  CONSTRAINT delivery_evidence_attachments_storage_key_chk
    CHECK (storage_key ~ '^delivery-[0-9a-f-]{36}\.(jpg|png|webp)$'),
  CONSTRAINT delivery_evidence_attachments_time_chk
    CHECK (expires_at >= created_at AND captured_at <= created_at + interval '5 minutes')
);

CREATE TABLE IF NOT EXISTS public.delivery_evidence_events (
  id uuid NOT NULL,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  delivery_order_id uuid NOT NULL,
  delivery_task_id uuid NOT NULL,
  leg text NOT NULL,
  delivery_task_version integer NOT NULL,
  assignee_staff_id uuid NOT NULL,
  event_kind text NOT NULL,
  outcome text NOT NULL,
  exception_reason text,
  captured_at timestamptz NOT NULL,
  latitude_e7 integer,
  longitude_e7 integer,
  accuracy_mm integer,
  gps_captured_at timestamptz,
  recorded_at timestamptz NOT NULL,
  recorded_by_staff_id uuid NOT NULL,
  CONSTRAINT delivery_evidence_events_pkey PRIMARY KEY (id),
  CONSTRAINT delivery_evidence_events_tenant_id_uidx UNIQUE (org_id, store_id, id),
  CONSTRAINT delivery_evidence_events_store_fk
    FOREIGN KEY (org_id, store_id) REFERENCES public.stores (org_id, id),
  CONSTRAINT delivery_evidence_events_order_fk
    FOREIGN KEY (org_id, store_id, delivery_order_id)
    REFERENCES public.delivery_orders (org_id, store_id, id),
  CONSTRAINT delivery_evidence_events_task_fk
    FOREIGN KEY (org_id, store_id, delivery_task_id)
    REFERENCES public.delivery_tasks (org_id, store_id, id),
  CONSTRAINT delivery_evidence_events_staff_fk
    FOREIGN KEY (org_id, recorded_by_staff_id) REFERENCES public.staffs (org_id, id),
  CONSTRAINT delivery_evidence_events_leg_chk CHECK (leg IN ('pickup', 'return')),
  CONSTRAINT delivery_evidence_events_version_chk CHECK (delivery_task_version > 0),
  CONSTRAINT delivery_evidence_events_kind_chk CHECK (event_kind IN ('pickup', 'delivered', 'exception')),
  CONSTRAINT delivery_evidence_events_outcome_chk CHECK (outcome IN ('record_only', 'complete_leg')),
  CONSTRAINT delivery_evidence_events_reason_chk CHECK (
    exception_reason IS NULL OR exception_reason IN (
      'customer_unavailable', 'access_blocked', 'item_mismatch', 'unsafe_location',
      'weather', 'vehicle_issue', 'other'
    )
  ),
  CONSTRAINT delivery_evidence_events_shape_chk CHECK (
    ((event_kind = 'exception') = (exception_reason IS NOT NULL))
    AND NOT (event_kind = 'exception' AND outcome = 'complete_leg')
    AND (event_kind = 'exception' OR event_kind = CASE WHEN leg = 'pickup' THEN 'pickup' ELSE 'delivered' END)
  ),
  CONSTRAINT delivery_evidence_events_gps_shape_chk CHECK (
    (latitude_e7 IS NULL AND longitude_e7 IS NULL AND accuracy_mm IS NULL AND gps_captured_at IS NULL)
    OR (latitude_e7 BETWEEN -900000000 AND 900000000
      AND longitude_e7 BETWEEN -1800000000 AND 1800000000
      AND accuracy_mm BETWEEN 0 AND 100000000 AND gps_captured_at IS NOT NULL)
  ),
  CONSTRAINT delivery_evidence_events_time_chk
    CHECK (captured_at <= recorded_at + interval '5 minutes'
      AND (gps_captured_at IS NULL OR gps_captured_at <= recorded_at + interval '5 minutes'))
);

CREATE TABLE IF NOT EXISTS public.delivery_evidence_attachment_links (
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  delivery_evidence_id uuid NOT NULL,
  attachment_id uuid NOT NULL,
  linked_at timestamptz NOT NULL,
  linked_by_staff_id uuid NOT NULL,
  CONSTRAINT delivery_evidence_attachment_links_pkey
    PRIMARY KEY (org_id, store_id, delivery_evidence_id, attachment_id),
  CONSTRAINT delivery_evidence_attachment_links_attachment_uidx
    UNIQUE (org_id, store_id, attachment_id),
  CONSTRAINT delivery_evidence_attachment_links_evidence_fk
    FOREIGN KEY (org_id, store_id, delivery_evidence_id)
    REFERENCES public.delivery_evidence_events (org_id, store_id, id),
  CONSTRAINT delivery_evidence_attachment_links_attachment_fk
    FOREIGN KEY (org_id, store_id, attachment_id)
    REFERENCES public.delivery_evidence_attachments (org_id, store_id, id),
  CONSTRAINT delivery_evidence_attachment_links_staff_fk
    FOREIGN KEY (org_id, linked_by_staff_id) REFERENCES public.staffs (org_id, id)
);

CREATE OR REPLACE FUNCTION public.reject_delivery_evidence_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE insufficient_privilege USING MESSAGE = 'delivery evidence is append-only';
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_delivery_evidence_attachment_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  db_now timestamptz := statement_timestamp();
  actor_id uuid := NULLIF(current_setting('app.staff_id', true), '')::uuid;
  task_row public.delivery_tasks%ROWTYPE;
  order_status text;
BEGIN
  SELECT * INTO task_row FROM public.delivery_tasks
   WHERE org_id = NEW.org_id AND store_id = NEW.store_id AND id = NEW.delivery_task_id
   FOR SHARE;
  IF NOT FOUND OR task_row.delivery_order_id IS DISTINCT FROM NEW.delivery_order_id
     OR task_row.leg IS DISTINCT FROM NEW.leg OR task_row.status <> 'accepted'
     OR task_row.version IS DISTINCT FROM NEW.delivery_task_version
     OR task_row.assignee_staff_id IS DISTINCT FROM actor_id THEN
    RAISE insufficient_privilege USING MESSAGE = 'delivery evidence requires current accepted assignee';
  END IF;
  SELECT status INTO order_status FROM public.delivery_orders
   WHERE org_id = NEW.org_id AND store_id = NEW.store_id AND id = NEW.delivery_order_id
   FOR SHARE;
  IF (NEW.leg = 'pickup' AND order_status NOT IN ('pickup_scheduled', 'pickup_in_progress'))
     OR (NEW.leg = 'return' AND order_status NOT IN ('return_scheduled', 'return_in_progress')) THEN
    RAISE check_violation USING MESSAGE = 'delivery evidence order state is not active';
  END IF;
  IF NEW.captured_at > db_now + interval '5 minutes' THEN
    RAISE check_violation USING MESSAGE = 'delivery evidence capture time is in the future';
  END IF;
  NEW.assignee_staff_id := actor_id;
  NEW.created_by_staff_id := actor_id;
  NEW.created_at := db_now;
  NEW.expires_at := db_now + interval '1 day';
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_delivery_evidence_event_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  db_now timestamptz := statement_timestamp();
  actor_id uuid := NULLIF(current_setting('app.staff_id', true), '')::uuid;
  task_row public.delivery_tasks%ROWTYPE;
  order_status text;
BEGIN
  SELECT * INTO task_row FROM public.delivery_tasks
   WHERE org_id = NEW.org_id AND store_id = NEW.store_id AND id = NEW.delivery_task_id
   FOR SHARE;
  IF NOT FOUND OR task_row.delivery_order_id IS DISTINCT FROM NEW.delivery_order_id
     OR task_row.leg IS DISTINCT FROM NEW.leg OR task_row.status <> 'accepted'
     OR task_row.version IS DISTINCT FROM NEW.delivery_task_version
     OR task_row.assignee_staff_id IS DISTINCT FROM actor_id THEN
    RAISE insufficient_privilege USING MESSAGE = 'delivery evidence requires current accepted assignee';
  END IF;
  SELECT status INTO order_status FROM public.delivery_orders
   WHERE org_id = NEW.org_id AND store_id = NEW.store_id AND id = NEW.delivery_order_id
   FOR SHARE;
  IF (NEW.leg = 'pickup' AND order_status NOT IN ('pickup_scheduled', 'pickup_in_progress'))
     OR (NEW.leg = 'return' AND order_status NOT IN ('return_scheduled', 'return_in_progress'))
     OR (NEW.outcome = 'complete_leg' AND NEW.leg = 'pickup' AND order_status <> 'pickup_in_progress')
     OR (NEW.outcome = 'complete_leg' AND NEW.leg = 'return' AND order_status <> 'return_in_progress') THEN
    RAISE check_violation USING MESSAGE = 'delivery evidence order state is not active';
  END IF;
  IF NEW.captured_at > db_now + interval '5 minutes' THEN
    RAISE check_violation USING MESSAGE = 'delivery evidence capture time is in the future';
  END IF;
  NEW.assignee_staff_id := actor_id;
  NEW.recorded_by_staff_id := actor_id;
  NEW.recorded_at := db_now;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_delivery_evidence_link_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  db_now timestamptz := statement_timestamp();
  actor_id uuid := NULLIF(current_setting('app.staff_id', true), '')::uuid;
  evidence_row public.delivery_evidence_events%ROWTYPE;
  attachment_row public.delivery_evidence_attachments%ROWTYPE;
BEGIN
  SELECT * INTO evidence_row FROM public.delivery_evidence_events
   WHERE org_id = NEW.org_id AND store_id = NEW.store_id AND id = NEW.delivery_evidence_id
   FOR SHARE;
  SELECT * INTO attachment_row FROM public.delivery_evidence_attachments
   WHERE org_id = NEW.org_id AND store_id = NEW.store_id AND id = NEW.attachment_id
   FOR SHARE;
  IF evidence_row.id IS NULL OR attachment_row.id IS NULL
     OR evidence_row.delivery_order_id IS DISTINCT FROM attachment_row.delivery_order_id
     OR evidence_row.delivery_task_id IS DISTINCT FROM attachment_row.delivery_task_id
     OR evidence_row.leg IS DISTINCT FROM attachment_row.leg
     OR evidence_row.delivery_task_version IS DISTINCT FROM attachment_row.delivery_task_version
     OR evidence_row.assignee_staff_id IS DISTINCT FROM actor_id
     OR attachment_row.created_by_staff_id IS DISTINCT FROM actor_id
     OR attachment_row.expires_at < db_now THEN
    RAISE insufficient_privilege USING MESSAGE = 'delivery evidence attachment authority mismatch';
  END IF;
  NEW.linked_by_staff_id := actor_id;
  NEW.linked_at := db_now;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_delivery_evidence_commit_integrity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  photo_count integer;
  signature_count integer;
BEGIN
  SELECT
    count(*) FILTER (WHERE attachment.kind = 'photo'),
    count(*) FILTER (WHERE attachment.kind = 'signature')
  INTO photo_count, signature_count
  FROM public.delivery_evidence_attachment_links link
  JOIN public.delivery_evidence_attachments attachment
    ON attachment.org_id = link.org_id AND attachment.store_id = link.store_id
   AND attachment.id = link.attachment_id
  WHERE link.org_id = NEW.org_id AND link.store_id = NEW.store_id
    AND link.delivery_evidence_id = NEW.id;
  IF NEW.latitude_e7 IS NULL AND photo_count + signature_count = 0 THEN
    RAISE check_violation USING MESSAGE = 'delivery evidence requires GPS or an attachment';
  END IF;
  IF NEW.outcome = 'complete_leg' AND (
    NEW.latitude_e7 IS NULL OR photo_count < 1 OR (NEW.leg = 'return' AND signature_count < 1)
  ) THEN
    RAISE check_violation USING MESSAGE = 'delivery completion evidence is incomplete';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_delivery_order_completion_evidence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id uuid := NULLIF(current_setting('app.staff_id', true), '')::uuid;
  required_leg text;
  required_kind text;
BEGIN
  required_leg := CASE
    WHEN OLD.status = 'pickup_in_progress' AND NEW.status = 'picked_up' THEN 'pickup'
    WHEN OLD.status = 'return_in_progress' AND NEW.status = 'completed' THEN 'return'
    ELSE NULL
  END;
  IF required_leg IS NULL THEN RETURN NEW; END IF;
  required_kind := CASE WHEN required_leg = 'pickup' THEN 'pickup' ELSE 'delivered' END;
  PERFORM 1
    FROM public.delivery_evidence_events evidence
   WHERE evidence.org_id = OLD.org_id AND evidence.store_id = OLD.store_id
     AND evidence.delivery_order_id = OLD.id AND evidence.leg = required_leg
     AND evidence.event_kind = required_kind AND evidence.outcome = 'complete_leg'
     AND evidence.recorded_by_staff_id = actor_id AND evidence.latitude_e7 IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM public.delivery_evidence_attachment_links link
       JOIN public.delivery_evidence_attachments attachment
         ON attachment.org_id = link.org_id AND attachment.store_id = link.store_id
        AND attachment.id = link.attachment_id
       WHERE link.org_id = evidence.org_id AND link.store_id = evidence.store_id
         AND link.delivery_evidence_id = evidence.id AND attachment.kind = 'photo'
     )
     AND (required_leg = 'pickup' OR EXISTS (
       SELECT 1 FROM public.delivery_evidence_attachment_links link
       JOIN public.delivery_evidence_attachments attachment
         ON attachment.org_id = link.org_id AND attachment.store_id = link.store_id
        AND attachment.id = link.attachment_id
       WHERE link.org_id = evidence.org_id AND link.store_id = evidence.store_id
         AND link.delivery_evidence_id = evidence.id AND attachment.kind = 'signature'
     ));
  IF NOT FOUND THEN
    RAISE check_violation USING MESSAGE = 'delivery order completion requires current evidence';
  END IF;
  RETURN NEW;
END;
$$;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'delivery_evidence_attachments', 'delivery_evidence_events',
    'delivery_evidence_attachment_links'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.reject_delivery_evidence_mutation()',
      table_name || '_immutable_row_trg', table_name
    );
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.reject_delivery_evidence_mutation()',
      table_name || '_immutable_truncate_trg', table_name
    );
  END LOOP;
END
$$;

CREATE TRIGGER delivery_evidence_attachment_insert_guard_trg
  BEFORE INSERT ON public.delivery_evidence_attachments
  FOR EACH ROW EXECUTE FUNCTION public.guard_delivery_evidence_attachment_insert();
CREATE TRIGGER delivery_evidence_event_insert_guard_trg
  BEFORE INSERT ON public.delivery_evidence_events
  FOR EACH ROW EXECUTE FUNCTION public.guard_delivery_evidence_event_insert();
CREATE TRIGGER delivery_evidence_link_insert_guard_trg
  BEFORE INSERT ON public.delivery_evidence_attachment_links
  FOR EACH ROW EXECUTE FUNCTION public.guard_delivery_evidence_link_insert();
CREATE CONSTRAINT TRIGGER delivery_evidence_commit_integrity_trg
  AFTER INSERT ON public.delivery_evidence_events
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.guard_delivery_evidence_commit_integrity();
CREATE TRIGGER delivery_order_completion_evidence_guard_trg
  BEFORE UPDATE ON public.delivery_orders
  FOR EACH ROW EXECUTE FUNCTION public.guard_delivery_order_completion_evidence();

CREATE INDEX delivery_evidence_events_task_idx
  ON public.delivery_evidence_events (org_id, store_id, delivery_task_id, recorded_at DESC, id);
CREATE INDEX delivery_evidence_attachments_task_idx
  ON public.delivery_evidence_attachments (org_id, store_id, delivery_task_id, expires_at, id);

ALTER TABLE public.delivery_evidence_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.delivery_evidence_attachments FORCE ROW LEVEL SECURITY;
ALTER TABLE public.delivery_evidence_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.delivery_evidence_events FORCE ROW LEVEL SECURITY;
ALTER TABLE public.delivery_evidence_attachment_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.delivery_evidence_attachment_links FORCE ROW LEVEL SECURITY;

CREATE POLICY delivery_evidence_attachments_store_scope ON public.delivery_evidence_attachments
  AS PERMISSIVE FOR ALL TO laundry_app
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid);
CREATE POLICY delivery_evidence_events_store_scope ON public.delivery_evidence_events
  AS PERMISSIVE FOR ALL TO laundry_app
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid);
CREATE POLICY delivery_evidence_attachment_links_store_scope ON public.delivery_evidence_attachment_links
  AS PERMISSIVE FOR ALL TO laundry_app
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid);
CREATE POLICY delivery_evidence_attachments_maintenance ON public.delivery_evidence_attachments
  AS PERMISSIVE FOR ALL TO laundry_owner USING (true) WITH CHECK (true);
CREATE POLICY delivery_evidence_events_maintenance ON public.delivery_evidence_events
  AS PERMISSIVE FOR ALL TO laundry_owner USING (true) WITH CHECK (true);
CREATE POLICY delivery_evidence_attachment_links_maintenance ON public.delivery_evidence_attachment_links
  AS PERMISSIVE FOR ALL TO laundry_owner USING (true) WITH CHECK (true);

GRANT SELECT, INSERT ON TABLE public.delivery_evidence_attachments TO laundry_app;
GRANT SELECT, INSERT ON TABLE public.delivery_evidence_events TO laundry_app;
GRANT SELECT, INSERT ON TABLE public.delivery_evidence_attachment_links TO laundry_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.delivery_evidence_attachments FROM laundry_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.delivery_evidence_events FROM laundry_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.delivery_evidence_attachment_links FROM laundry_app;
REVOKE ALL ON FUNCTION public.reject_delivery_evidence_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_delivery_evidence_attachment_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_delivery_evidence_event_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_delivery_evidence_link_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_delivery_evidence_commit_integrity() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_delivery_order_completion_evidence() FROM PUBLIC;

CREATE UNIQUE INDEX ai_pending_delivery_evidence_idempotency_uidx
  ON public.ai_pending_actions (org_id, store_id, command, idempotency_key)
  WHERE command = 'delivery.evidence.record';

-- Privacy export exposes bounded counts and explicit retention decisions only; never media/GPS.
DO $$
BEGIN
  IF to_regprocedure('public.customer_privacy_export_v4_base(uuid,text,uuid,timestamptz)') IS NULL THEN
    ALTER FUNCTION public.customer_privacy_export(uuid, text, uuid, timestamptz)
      RENAME TO customer_privacy_export_v4_base;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.customer_delivery_evidence_privacy_export(requested_customer_id uuid)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT jsonb_build_object(
    'delivery_evidence_count', count(DISTINCT evidence.id),
    'delivery_attachment_count', count(DISTINCT link.attachment_id),
    'delivery_evidence_retention', 'retained_operational_evidence',
    'delivery_unlinked_upload_cleanup', 'private_file_purged_after_expiry_metadata_retained'
  )
  FROM public.delivery_orders delivery_order
  LEFT JOIN public.delivery_evidence_events evidence
    ON evidence.org_id = delivery_order.org_id AND evidence.store_id = delivery_order.store_id
   AND evidence.delivery_order_id = delivery_order.id
  LEFT JOIN public.delivery_evidence_attachment_links link
    ON link.org_id = evidence.org_id AND link.store_id = evidence.store_id
   AND link.delivery_evidence_id = evidence.id
  WHERE delivery_order.org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND delivery_order.customer_id = requested_customer_id
$$;

CREATE OR REPLACE FUNCTION public.customer_privacy_export(
  requested_customer_id uuid,
  requested_reason text,
  event_id uuid,
  requested_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE base_payload jsonb;
BEGIN
  base_payload := customer_privacy_export_v4_base(
    requested_customer_id, requested_reason, event_id, requested_at
  );
  IF base_payload IS NULL THEN RETURN NULL; END IF;
  RETURN base_payload || customer_delivery_evidence_privacy_export(requested_customer_id);
END;
$$;

REVOKE ALL ON FUNCTION public.customer_privacy_export_v4_base(uuid, text, uuid, timestamptz)
  FROM PUBLIC, laundry_app;
REVOKE ALL ON FUNCTION public.customer_delivery_evidence_privacy_export(uuid)
  FROM PUBLIC, laundry_app;
REVOKE ALL ON FUNCTION public.customer_privacy_export(uuid, text, uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.customer_privacy_export(uuid, text, uuid, timestamptz)
  TO laundry_app;
