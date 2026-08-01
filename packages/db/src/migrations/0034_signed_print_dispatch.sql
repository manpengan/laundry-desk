-- Signed, real-order Edge print dispatch and device-receipt settlement.
--
-- New jobs persist one immutable server-derived snapshot before becoming
-- claimable. A claim binds exactly one paired device and one ticket nonce.
-- Printing rows are never reclaimed on timeout: only an explicit new
-- retry/reprint job may cause another physical submission.

ALTER TABLE print_jobs
  ADD COLUMN IF NOT EXISTS snapshot_json jsonb,
  ADD COLUMN IF NOT EXISTS snapshot_sha256 char(64),
  ADD COLUMN IF NOT EXISTS snapshot_purged_at timestamptz,
  ADD COLUMN IF NOT EXISTS printer_kind text GENERATED ALWAYS AS (kind) STORED,
  ADD COLUMN IF NOT EXISTS source_job_id uuid,
  ADD COLUMN IF NOT EXISTS dispatch_device_id uuid,
  ADD COLUMN IF NOT EXISTS dispatch_staff_id uuid,
  ADD COLUMN IF NOT EXISTS ticket_nonce uuid,
  ADD COLUMN IF NOT EXISTS capability_json jsonb,
  ADD COLUMN IF NOT EXISTS dispatch_issued_at timestamptz,
  ADD COLUMN IF NOT EXISTS dispatch_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS receipt_seq bigint,
  ADD COLUMN IF NOT EXISTS receipt_result text,
  ADD COLUMN IF NOT EXISTS cups_job_id text,
  ADD COLUMN IF NOT EXISTS receipt_at timestamptz,
  ADD COLUMN IF NOT EXISTS receipt_json jsonb,
  ADD COLUMN IF NOT EXISTS receipt_envelope_sha256 char(64),
  ADD COLUMN IF NOT EXISTS settled_at timestamptz;

ALTER TABLE print_jobs DROP CONSTRAINT IF EXISTS print_jobs_status_chk;
ALTER TABLE print_jobs ADD CONSTRAINT print_jobs_status_chk
  CHECK (status IN ('queued', 'printing', 'done', 'failed', 'uncertain'));

ALTER TABLE print_jobs ADD CONSTRAINT print_jobs_signed_snapshot_chk CHECK (
  (snapshot_json IS NULL AND snapshot_sha256 IS NULL AND snapshot_purged_at IS NULL)
  OR (
    snapshot_json IS NOT NULL
    AND snapshot_sha256 IS NOT NULL
    AND snapshot_purged_at IS NULL
    AND jsonb_typeof(snapshot_json) = 'object'
    AND snapshot_sha256 ~ '^[0-9a-f]{64}$'
  )
  OR (
    snapshot_json IS NULL
    AND snapshot_sha256 IS NOT NULL
    AND snapshot_purged_at IS NOT NULL
    AND snapshot_sha256 ~ '^[0-9a-f]{64}$'
    AND status IN ('done', 'failed', 'uncertain')
  )
);

ALTER TABLE print_jobs ADD CONSTRAINT print_jobs_source_fk
  FOREIGN KEY (org_id, store_id, source_job_id)
  REFERENCES print_jobs (org_id, store_id, id)
  NOT VALID;

ALTER TABLE print_jobs ADD CONSTRAINT print_jobs_dispatch_device_fk
  FOREIGN KEY (org_id, store_id, dispatch_device_id)
  REFERENCES edge_devices (org_id, store_id, device_id)
  NOT VALID;

ALTER TABLE print_jobs ADD CONSTRAINT print_jobs_dispatch_staff_fk
  FOREIGN KEY (org_id, dispatch_staff_id)
  REFERENCES staffs (org_id, id)
  NOT VALID;

ALTER TABLE print_jobs ADD CONSTRAINT print_jobs_dispatch_shape_chk CHECK (
  (
    dispatch_device_id IS NULL
    AND dispatch_staff_id IS NULL
    AND ticket_nonce IS NULL
    AND capability_json IS NULL
    AND dispatch_issued_at IS NULL
    AND dispatch_expires_at IS NULL
    AND (
      (snapshot_json IS NULL AND snapshot_sha256 IS NULL AND snapshot_purged_at IS NULL)
      OR (
        snapshot_json IS NOT NULL
        AND snapshot_sha256 IS NOT NULL
        AND snapshot_purged_at IS NULL
        AND status = 'queued'
      )
    )
  )
  OR (
    dispatch_device_id IS NOT NULL
    AND dispatch_staff_id IS NOT NULL
    AND ticket_nonce IS NOT NULL
    AND capability_json IS NOT NULL
    AND jsonb_typeof(capability_json) = 'object'
    AND dispatch_issued_at IS NOT NULL
    AND dispatch_expires_at IS NOT NULL
    AND dispatch_expires_at > dispatch_issued_at
    AND snapshot_sha256 IS NOT NULL
    AND (
      (snapshot_json IS NOT NULL AND snapshot_purged_at IS NULL)
      OR (snapshot_json IS NULL AND snapshot_purged_at IS NOT NULL
          AND status IN ('done', 'failed', 'uncertain'))
    )
    AND status IN ('printing', 'done', 'failed', 'uncertain')
  )
);

ALTER TABLE print_jobs ADD CONSTRAINT print_jobs_receipt_shape_chk CHECK (
  (
    receipt_seq IS NULL
    AND receipt_result IS NULL
    AND cups_job_id IS NULL
    AND receipt_at IS NULL
    AND receipt_json IS NULL
    AND receipt_envelope_sha256 IS NULL
    AND settled_at IS NULL
    AND (
      snapshot_sha256 IS NULL
      OR (
        snapshot_json IS NOT NULL
        AND snapshot_purged_at IS NULL
        AND status IN ('queued', 'printing')
      )
    )
  )
  OR (
    receipt_seq IS NOT NULL
    AND receipt_seq > 0
    AND receipt_result IS NOT NULL
    AND receipt_result IN ('succeeded', 'failed', 'uncertain')
    AND receipt_at IS NOT NULL
    AND receipt_json IS NOT NULL
    AND jsonb_typeof(receipt_json) = 'object'
    AND receipt_envelope_sha256 IS NOT NULL
    AND receipt_envelope_sha256 ~ '^[0-9a-f]{64}$'
    AND settled_at IS NOT NULL
    AND (
      (receipt_result = 'succeeded' AND status = 'done' AND cups_job_id IS NOT NULL)
      OR (receipt_result = 'failed' AND status = 'failed' AND cups_job_id IS NULL)
      OR (receipt_result = 'uncertain' AND status = 'uncertain')
    )
  )
);

ALTER TABLE print_jobs ADD CONSTRAINT print_jobs_cups_job_id_chk CHECK (
  cups_job_id IS NULL OR cups_job_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}-[1-9][0-9]{0,9}$'
);

CREATE UNIQUE INDEX IF NOT EXISTS print_jobs_ticket_nonce_uidx
  ON print_jobs (org_id, store_id, ticket_nonce)
  WHERE ticket_nonce IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS print_jobs_device_receipt_seq_uidx
  ON print_jobs (org_id, store_id, dispatch_device_id, receipt_seq)
  WHERE receipt_seq IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS print_jobs_device_unsettled_uidx
  ON print_jobs (org_id, store_id, dispatch_device_id)
  WHERE status = 'printing' AND dispatch_device_id IS NOT NULL AND receipt_seq IS NULL;
CREATE INDEX IF NOT EXISTS print_jobs_source_job_fk_idx
  ON print_jobs (org_id, store_id, source_job_id)
  WHERE source_job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS print_jobs_dispatch_device_fk_idx
  ON print_jobs (org_id, store_id, dispatch_device_id)
  WHERE dispatch_device_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS print_jobs_dispatch_staff_fk_idx
  ON print_jobs (org_id, dispatch_staff_id)
  WHERE dispatch_staff_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS print_jobs_order_privacy_idx
  ON print_jobs (org_id, store_id, order_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS print_jobs_signed_dispatch_claim_idx
  ON print_jobs (org_id, store_id, status, created_at, id)
  WHERE status = 'queued' AND snapshot_json IS NOT NULL;

CREATE TABLE IF NOT EXISTS print_device_receipt_heads (
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  device_id uuid NOT NULL,
  last_seq bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (org_id, store_id, device_id),
  CONSTRAINT print_device_receipt_heads_device_fk
    FOREIGN KEY (org_id, store_id, device_id)
    REFERENCES edge_devices (org_id, store_id, device_id),
  CONSTRAINT print_device_receipt_heads_seq_chk CHECK (last_seq >= 0)
);

CREATE OR REPLACE FUNCTION guard_print_job_dispatch_immutability()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  purging_terminal_snapshot boolean;
BEGIN
  purging_terminal_snapshot := COALESCE((
    OLD.status IN ('done', 'failed', 'uncertain')
    AND NEW.status = OLD.status
    AND OLD.snapshot_json IS NOT NULL
    AND NEW.snapshot_json IS NULL
    AND NEW.snapshot_sha256 IS NOT DISTINCT FROM OLD.snapshot_sha256
    AND OLD.snapshot_purged_at IS NULL
    AND NEW.snapshot_purged_at IS NOT NULL
    AND OLD.receipt_envelope_sha256 IS NOT NULL
    AND NEW.receipt_envelope_sha256 IS NOT DISTINCT FROM OLD.receipt_envelope_sha256
  ), false);

  IF (
    NEW.snapshot_json IS DISTINCT FROM OLD.snapshot_json
    OR NEW.snapshot_sha256 IS DISTINCT FROM OLD.snapshot_sha256
    OR NEW.snapshot_purged_at IS DISTINCT FROM OLD.snapshot_purged_at
  ) AND NOT purging_terminal_snapshot THEN
    RAISE EXCEPTION 'print snapshot is immutable except for terminal privacy purge'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.dispatch_device_id IS NOT NULL AND (
    NEW.dispatch_device_id IS DISTINCT FROM OLD.dispatch_device_id
    OR NEW.dispatch_staff_id IS DISTINCT FROM OLD.dispatch_staff_id
    OR NEW.ticket_nonce IS DISTINCT FROM OLD.ticket_nonce
    OR NEW.order_id IS DISTINCT FROM OLD.order_id
    OR NEW.ticket_no IS DISTINCT FROM OLD.ticket_no
    OR NEW.kind IS DISTINCT FROM OLD.kind
  ) THEN
    RAISE EXCEPTION 'print dispatch binding is immutable' USING ERRCODE = '23514';
  END IF;

  IF OLD.receipt_envelope_sha256 IS NOT NULL AND (
    NEW.status IS DISTINCT FROM OLD.status
    OR NEW.receipt_seq IS DISTINCT FROM OLD.receipt_seq
    OR NEW.receipt_result IS DISTINCT FROM OLD.receipt_result
    OR NEW.cups_job_id IS DISTINCT FROM OLD.cups_job_id
    OR NEW.receipt_at IS DISTINCT FROM OLD.receipt_at
    OR NEW.receipt_json IS DISTINCT FROM OLD.receipt_json
    OR NEW.receipt_envelope_sha256 IS DISTINCT FROM OLD.receipt_envelope_sha256
    OR NEW.settled_at IS DISTINCT FROM OLD.settled_at
  ) THEN
    RAISE EXCEPTION 'print receipt settlement is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS print_jobs_dispatch_immutability ON print_jobs;
CREATE TRIGGER print_jobs_dispatch_immutability
BEFORE UPDATE ON print_jobs
FOR EACH ROW EXECUTE FUNCTION guard_print_job_dispatch_immutability();

CREATE OR REPLACE FUNCTION guard_print_receipt_head_monotonicity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.last_seq <> 0 THEN
      RAISE EXCEPTION 'print receipt head must start at zero' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.store_id IS DISTINCT FROM OLD.store_id
     OR NEW.device_id IS DISTINCT FROM OLD.device_id
     OR NEW.last_seq <> OLD.last_seq + 1 THEN
    RAISE EXCEPTION 'print receipt head must advance monotonically' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS print_device_receipt_heads_monotonicity ON print_device_receipt_heads;
CREATE TRIGGER print_device_receipt_heads_monotonicity
BEFORE INSERT OR UPDATE ON print_device_receipt_heads
FOR EACH ROW EXECUTE FUNCTION guard_print_receipt_head_monotonicity();

ALTER TABLE print_device_receipt_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE print_device_receipt_heads FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS print_device_receipt_heads_store_scope ON print_device_receipt_heads;
CREATE POLICY print_device_receipt_heads_store_scope ON print_device_receipt_heads
  AS PERMISSIVE FOR ALL TO laundry_app
  USING (
    org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid
  );

DROP POLICY IF EXISTS print_device_receipt_heads_maintenance ON print_device_receipt_heads;
CREATE POLICY print_device_receipt_heads_maintenance ON print_device_receipt_heads
  AS PERMISSIVE FOR ALL TO laundry_owner USING (true) WITH CHECK (true);

REVOKE ALL ON TABLE print_device_receipt_heads FROM PUBLIC, laundry_app;
GRANT SELECT, INSERT ON TABLE print_device_receipt_heads TO laundry_app;
GRANT UPDATE (last_seq, updated_at) ON TABLE print_device_receipt_heads TO laundry_app;

REVOKE ALL ON FUNCTION guard_print_job_dispatch_immutability() FROM PUBLIC;
REVOKE ALL ON FUNCTION guard_print_receipt_head_monotonicity() FROM PUBLIC;

-- Immutable order/snapshot/device bindings cannot be rewritten by the app
-- role. Grant only columns used by the legacy explicit diagnostic worker and
-- the signed dispatch/receipt state machine.
REVOKE UPDATE ON TABLE print_jobs FROM laundry_app;
GRANT UPDATE (
  status, error, payload_bytes, updated_at,
  attempt_count, claimed_at, lease_until, worker_id,
  artifact_path, artifact_sha256, artifact_bytes, completed_at,
  dispatch_device_id, dispatch_staff_id, ticket_nonce, capability_json,
  dispatch_issued_at, dispatch_expires_at,
  receipt_seq, receipt_result, cups_job_id, receipt_at, receipt_json,
  receipt_envelope_sha256, settled_at
) ON TABLE print_jobs TO laundry_app;

-- A signed print snapshot is another direct-PII copy owned by the customer
-- privacy lifecycle. Queued/printing rows block anonymization so a receipt
-- cannot be printed after the customer was reported anonymous. Once every
-- related job is terminal, anonymization purges the JSON in one direction but
-- retains its SHA-256, capability and device receipt as opaque audit evidence.
CREATE OR REPLACE FUNCTION customer_privacy_status(requested_customer_id uuid)
RETURNS TABLE (
  active_order_count bigint,
  retained_order_count bigint,
  photo_count bigint,
  latest_order_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  authority record;
BEGIN
  SELECT * INTO authority FROM assert_customer_privacy_authority();
  IF NOT EXISTS (
    SELECT 1
      FROM customers customer_row
     WHERE customer_row.org_id = authority.org_id
       AND customer_row.id = requested_customer_id
       AND customer_row.merged_into_id IS NULL
       AND customer_row.anonymized_at IS NULL
  ) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    count(*) FILTER (
      WHERE order_row.status IN ('draft', 'open')
         OR EXISTS (
           SELECT 1
             FROM print_jobs print_job
            WHERE print_job.org_id = order_row.org_id
              AND print_job.store_id = order_row.store_id
              AND print_job.order_id = order_row.id
              AND print_job.status IN ('queued', 'printing')
              AND print_job.snapshot_json IS NOT NULL
         )
    ),
    count(*) FILTER (WHERE order_row.status IN ('closed', 'cancelled')),
    (
      SELECT count(*)
        FROM garment_photos photo
        JOIN orders linked_order
          ON linked_order.org_id = photo.org_id
         AND linked_order.store_id = photo.store_id
         AND linked_order.id = photo.order_id
       WHERE linked_order.org_id = authority.org_id
         AND linked_order.customer_id = requested_customer_id
    ),
    max(order_row.created_at)
  FROM orders order_row
  WHERE order_row.org_id = authority.org_id
    AND order_row.customer_id = requested_customer_id;
END;
$$;

CREATE OR REPLACE FUNCTION customer_privacy_export(
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
DECLARE
  authority record;
  customer_row record;
  order_rows jsonb;
  order_count integer;
BEGIN
  SELECT * INTO authority FROM assert_customer_privacy_authority();
  IF NOT EXISTS (
    SELECT 1 FROM staff_store_roles role_row
     WHERE role_row.org_id = authority.org_id
       AND role_row.store_id = authority.store_id
       AND role_row.staff_id = authority.staff_id
       AND role_row.is_active
       AND role_row.is_privacy_admin
  ) THEN
    RAISE insufficient_privilege USING MESSAGE = 'customer privacy authority unavailable';
  END IF;
  IF char_length(btrim(requested_reason)) NOT BETWEEN 1 AND 256 THEN
    RAISE invalid_parameter_value USING MESSAGE = 'invalid privacy reason';
  END IF;
  SELECT id, phone, name, note, created_at, updated_at
    INTO customer_row
    FROM customers
   WHERE org_id = authority.org_id
     AND id = requested_customer_id
     AND merged_into_id IS NULL
     AND anonymized_at IS NULL
   FOR UPDATE;
  IF customer_row.id IS NULL THEN RETURN NULL; END IF;

  SELECT count(*)::integer INTO order_count
    FROM orders
   WHERE org_id = authority.org_id AND customer_id = customer_row.id;
  SELECT COALESCE(jsonb_agg(to_jsonb(bounded) ORDER BY bounded.created_at DESC), '[]'::jsonb)
    INTO order_rows
    FROM (
      SELECT order_row.id AS order_id, order_row.store_id, order_row.ticket_no,
             order_row.status, order_row.customer_phone, order_row.customer_name,
             order_row.note, order_row.payable_cents, order_row.paid_cents,
             order_row.balance_cents, order_row.business_date, order_row.created_at,
             (
               SELECT COALESCE(
                 jsonb_agg(to_jsonb(print_bounded) ORDER BY print_bounded.created_at DESC),
                 '[]'::jsonb
               )
                 FROM (
                   SELECT print_job.id AS job_id, print_job.kind, print_job.status,
                          print_job.snapshot_json, print_job.snapshot_sha256,
                          print_job.snapshot_purged_at, print_job.created_at,
                          print_job.receipt_at, print_job.settled_at
                     FROM print_jobs print_job
                    WHERE print_job.org_id = order_row.org_id
                      AND print_job.store_id = order_row.store_id
                      AND print_job.order_id = order_row.id
                    ORDER BY print_job.created_at DESC, print_job.id DESC
                    LIMIT 1000
                 ) print_bounded
             ) AS print_jobs,
             (
               SELECT count(*)
                 FROM print_jobs print_job
                WHERE print_job.org_id = order_row.org_id
                  AND print_job.store_id = order_row.store_id
                  AND print_job.order_id = order_row.id
             ) AS print_job_count,
             (
               SELECT count(*) > 1000
                 FROM print_jobs print_job
                WHERE print_job.org_id = order_row.org_id
                  AND print_job.store_id = order_row.store_id
                  AND print_job.order_id = order_row.id
             ) AS print_jobs_truncated
        FROM orders order_row
       WHERE order_row.org_id = authority.org_id
         AND order_row.customer_id = customer_row.id
       ORDER BY order_row.created_at DESC
       LIMIT 1000
    ) bounded;

  INSERT INTO customer_privacy_events (
    id, org_id, origin_store_id, customer_id, staff_id, action, reason,
    affected_order_count, created_at
  ) VALUES (
    event_id, authority.org_id, authority.store_id, customer_row.id, authority.staff_id,
    'exported', btrim(requested_reason), order_count, requested_at
  );

  RETURN jsonb_build_object(
    'format_version', 1,
    'exported_at', extract(epoch FROM requested_at)::bigint,
    'customer', jsonb_build_object(
      'customer_id', customer_row.id,
      'phone', customer_row.phone,
      'name', customer_row.name,
      'note', customer_row.note,
      'created_at', extract(epoch FROM customer_row.created_at)::bigint,
      'updated_at', extract(epoch FROM customer_row.updated_at)::bigint
    ),
    'orders', order_rows,
    'order_count', order_count,
    'truncated', order_count > 1000
  );
END;
$$;

CREATE OR REPLACE FUNCTION customer_privacy_anonymize(
  requested_customer_id uuid,
  requested_reason text,
  event_id uuid,
  requested_at timestamptz
)
RETURNS TABLE (anonymized boolean, affected_order_count integer, blocked_active_order_count integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  authority record;
  customer_row record;
  active_count integer;
  changed_count integer;
BEGIN
  SELECT * INTO authority FROM assert_customer_privacy_authority();
  IF NOT EXISTS (
    SELECT 1 FROM staff_store_roles role_row
     WHERE role_row.org_id = authority.org_id
       AND role_row.store_id = authority.store_id
       AND role_row.staff_id = authority.staff_id
       AND role_row.is_active
       AND role_row.is_privacy_admin
  ) THEN
    RAISE insufficient_privilege USING MESSAGE = 'customer privacy authority unavailable';
  END IF;
  IF char_length(btrim(requested_reason)) NOT BETWEEN 1 AND 256 THEN
    RAISE invalid_parameter_value USING MESSAGE = 'invalid privacy reason';
  END IF;
  SELECT id, phone INTO customer_row
    FROM customers
   WHERE org_id = authority.org_id
     AND id = requested_customer_id
     AND merged_into_id IS NULL
     AND anonymized_at IS NULL
   FOR UPDATE;
  IF customer_row.id IS NULL THEN RETURN; END IF;

  -- Match the reprint lock order (source print row before order) to avoid a
  -- privacy/reprint deadlock. A following READ COMMITTED count observes any
  -- queued row committed while these locks were acquired.
  PERFORM print_job.id
    FROM print_jobs print_job
    JOIN orders linked_order
      ON linked_order.org_id = print_job.org_id
     AND linked_order.store_id = print_job.store_id
     AND linked_order.id = print_job.order_id
   WHERE linked_order.org_id = authority.org_id
     AND linked_order.customer_id = customer_row.id
     AND print_job.snapshot_json IS NOT NULL
   FOR UPDATE OF print_job;
  PERFORM order_row.id
    FROM orders order_row
   WHERE order_row.org_id = authority.org_id
     AND order_row.customer_id = customer_row.id
   FOR UPDATE;

  SELECT count(*)::integer INTO active_count
    FROM orders order_row
   WHERE order_row.org_id = authority.org_id
     AND order_row.customer_id = customer_row.id
     AND (
       order_row.status IN ('draft', 'open')
       OR EXISTS (
         SELECT 1
           FROM print_jobs print_job
          WHERE print_job.org_id = order_row.org_id
            AND print_job.store_id = order_row.store_id
            AND print_job.order_id = order_row.id
            AND print_job.status IN ('queued', 'printing')
            AND print_job.snapshot_json IS NOT NULL
       )
     );
  IF active_count > 0 THEN
    RETURN QUERY SELECT false, 0, active_count;
    RETURN;
  END IF;

  UPDATE orders
     SET customer_phone = NULL, customer_name = NULL, note = NULL, updated_at = requested_at
   WHERE org_id = authority.org_id
     AND customer_id = customer_row.id
     AND status IN ('closed', 'cancelled');
  GET DIAGNOSTICS changed_count = ROW_COUNT;

  UPDATE print_jobs print_job
     SET snapshot_json = NULL,
         snapshot_purged_at = requested_at,
         updated_at = requested_at
    FROM orders linked_order
   WHERE linked_order.org_id = authority.org_id
     AND linked_order.customer_id = customer_row.id
     AND print_job.org_id = linked_order.org_id
     AND print_job.store_id = linked_order.store_id
     AND print_job.order_id = linked_order.id
     AND print_job.status IN ('done', 'failed', 'uncertain')
     AND print_job.receipt_envelope_sha256 IS NOT NULL
     AND print_job.snapshot_json IS NOT NULL;

  UPDATE customers
     SET phone = 'anon-' || replace(id::text, '-', ''),
         name = NULL,
         note = NULL,
         anonymized_at = requested_at,
         anonymized_by_staff_id = authority.staff_id,
         updated_at = requested_at
   WHERE org_id = authority.org_id AND id = customer_row.id;

  INSERT INTO customer_privacy_events (
    id, org_id, origin_store_id, customer_id, staff_id, action, reason,
    affected_order_count, created_at
  ) VALUES (
    event_id, authority.org_id, authority.store_id, customer_row.id, authority.staff_id,
    'anonymized', btrim(requested_reason), changed_count, requested_at
  );
  RETURN QUERY SELECT true, changed_count, 0;
END;
$$;

REVOKE ALL ON FUNCTION customer_privacy_status(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION customer_privacy_export(uuid, text, uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION customer_privacy_anonymize(uuid, text, uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION customer_privacy_status(uuid) TO laundry_app;
GRANT EXECUTE ON FUNCTION customer_privacy_export(uuid, text, uuid, timestamptz) TO laundry_app;
GRANT EXECUTE ON FUNCTION customer_privacy_anonymize(uuid, text, uuid, timestamptz) TO laundry_app;
