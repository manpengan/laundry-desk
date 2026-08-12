-- ADR-45: store-scoped factory handoff manifests and quality evidence.
-- Garment lifecycle status remains the customer-facing state authority. The
-- custody columns below are an independent physical-handoff projection.

ALTER TABLE public.garments
  ADD COLUMN IF NOT EXISTS custody_state text NOT NULL DEFAULT 'store';
ALTER TABLE public.garments
  ADD COLUMN IF NOT EXISTS active_production_batch_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conname = 'garments_custody_state_chk'
       AND conrelid = 'public.garments'::regclass
  ) THEN
    ALTER TABLE public.garments
      ADD CONSTRAINT garments_custody_state_chk CHECK (
        custody_state IN ('store', 'to_factory', 'factory', 'to_store', 'exception')
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conname = 'garments_custody_anchor_chk'
       AND conrelid = 'public.garments'::regclass
  ) THEN
    ALTER TABLE public.garments
      ADD CONSTRAINT garments_custody_anchor_chk CHECK (
        active_production_batch_id IS NOT NULL
        OR custody_state = 'store'
        OR (custody_state = 'exception' AND status = 'lost')
      );
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS public.production_batches (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  factory_code text NOT NULL,
  status text NOT NULL,
  version integer NOT NULL,
  expected_garment_count integer NOT NULL,
  exception_garment_count integer NOT NULL DEFAULT 0,
  created_by_staff_id uuid NOT NULL,
  created_by_device_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  updated_by_staff_id uuid NOT NULL,
  updated_by_device_id uuid NOT NULL,
  updated_at timestamptz NOT NULL,
  completed_at timestamptz,
  cancel_reason_code text,
  CONSTRAINT production_batches_tenant_id_uidx UNIQUE (org_id, store_id, id),
  CONSTRAINT production_batches_store_fk
    FOREIGN KEY (org_id, store_id) REFERENCES public.stores (org_id, id),
  CONSTRAINT production_batches_created_staff_fk
    FOREIGN KEY (org_id, created_by_staff_id) REFERENCES public.staffs (org_id, id),
  CONSTRAINT production_batches_updated_staff_fk
    FOREIGN KEY (org_id, updated_by_staff_id) REFERENCES public.staffs (org_id, id),
  CONSTRAINT production_batches_factory_code_chk CHECK (
    factory_code ~ '^[A-Z0-9][A-Z0-9._-]{0,31}$'
  ),
  CONSTRAINT production_batches_status_chk CHECK (
    status IN (
      'packing',
      'store_dispatched',
      'factory_received',
      'factory_dispatched',
      'store_received',
      'cancelled'
    )
  ),
  CONSTRAINT production_batches_version_chk CHECK (version BETWEEN 1 AND 1000000),
  CONSTRAINT production_batches_count_chk CHECK (
    expected_garment_count BETWEEN 1 AND 100
    AND exception_garment_count BETWEEN 0 AND expected_garment_count
  ),
  CONSTRAINT production_batches_time_chk CHECK (
    updated_at >= created_at
    AND (completed_at IS NULL OR completed_at >= created_at)
  ),
  CONSTRAINT production_batches_terminal_chk CHECK (
    (status IN ('store_received', 'cancelled') AND completed_at IS NOT NULL)
    OR (status NOT IN ('store_received', 'cancelled') AND completed_at IS NULL)
  ),
  CONSTRAINT production_batches_cancel_reason_chk CHECK (
    (
      status = 'cancelled'
      AND cancel_reason_code IN ('duplicate_batch', 'customer_request', 'operational_error')
    )
    OR (status <> 'cancelled' AND cancel_reason_code IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS production_batches_store_status_updated_idx
  ON public.production_batches (org_id, store_id, status, updated_at DESC, id);
CREATE INDEX IF NOT EXISTS production_batches_factory_status_updated_idx
  ON public.production_batches (org_id, store_id, factory_code, status, updated_at DESC, id);

CREATE TABLE IF NOT EXISTS public.batch_garments (
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  order_id uuid NOT NULL,
  garment_id uuid NOT NULL,
  state text NOT NULL,
  qc_status text NOT NULL DEFAULT 'pending',
  added_by_staff_id uuid NOT NULL,
  added_by_device_id uuid NOT NULL,
  added_at timestamptz NOT NULL,
  updated_by_staff_id uuid NOT NULL,
  updated_by_device_id uuid NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT batch_garments_pkey PRIMARY KEY (org_id, store_id, batch_id, garment_id),
  CONSTRAINT batch_garments_batch_fk
    FOREIGN KEY (org_id, store_id, batch_id)
    REFERENCES public.production_batches (org_id, store_id, id),
  CONSTRAINT batch_garments_garment_fk
    FOREIGN KEY (org_id, store_id, order_id, garment_id)
    REFERENCES public.garments (org_id, store_id, order_id, id),
  CONSTRAINT batch_garments_added_staff_fk
    FOREIGN KEY (org_id, added_by_staff_id) REFERENCES public.staffs (org_id, id),
  CONSTRAINT batch_garments_updated_staff_fk
    FOREIGN KEY (org_id, updated_by_staff_id) REFERENCES public.staffs (org_id, id),
  CONSTRAINT batch_garments_state_chk CHECK (state IN ('active', 'exception', 'completed')),
  CONSTRAINT batch_garments_qc_status_chk CHECK (qc_status IN ('pending', 'pass', 'rework')),
  CONSTRAINT batch_garments_time_chk CHECK (updated_at >= added_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS batch_garments_active_garment_uidx
  ON public.batch_garments (org_id, store_id, garment_id)
  WHERE state IN ('active', 'exception');
CREATE INDEX IF NOT EXISTS batch_garments_batch_state_idx
  ON public.batch_garments (org_id, store_id, batch_id, state, garment_id);
CREATE INDEX IF NOT EXISTS batch_garments_garment_history_idx
  ON public.batch_garments (org_id, store_id, garment_id, updated_at DESC, batch_id);
CREATE INDEX IF NOT EXISTS batch_garments_order_idx
  ON public.batch_garments (org_id, store_id, order_id, batch_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conname = 'garments_active_production_batch_fk'
       AND conrelid = 'public.garments'::regclass
  ) THEN
    ALTER TABLE public.garments
      ADD CONSTRAINT garments_active_production_batch_fk
      FOREIGN KEY (org_id, store_id, active_production_batch_id, id)
      REFERENCES public.batch_garments (org_id, store_id, batch_id, garment_id);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS garments_active_production_batch_idx
  ON public.garments (org_id, store_id, active_production_batch_id, custody_state, id)
  WHERE active_production_batch_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.production_handoff_attempts (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  batch_version integer NOT NULL,
  checkpoint text NOT NULL,
  attempt_no integer NOT NULL,
  outcome text NOT NULL,
  expected_count integer NOT NULL,
  scanned_count integer NOT NULL,
  matched_count integer NOT NULL,
  missing_count integer NOT NULL,
  unexpected_count integer NOT NULL,
  staff_id uuid NOT NULL,
  device_id uuid NOT NULL,
  recorded_at timestamptz NOT NULL,
  CONSTRAINT production_handoff_attempts_tenant_id_uidx
    UNIQUE (org_id, store_id, id),
  CONSTRAINT production_handoff_attempts_batch_checkpoint_id_uidx
    UNIQUE (org_id, store_id, batch_id, checkpoint, id),
  CONSTRAINT production_handoff_attempts_batch_attempt_uidx
    UNIQUE (org_id, store_id, batch_id, checkpoint, attempt_no),
  CONSTRAINT production_handoff_attempts_batch_fk
    FOREIGN KEY (org_id, store_id, batch_id)
    REFERENCES public.production_batches (org_id, store_id, id),
  CONSTRAINT production_handoff_attempts_staff_fk
    FOREIGN KEY (org_id, staff_id) REFERENCES public.staffs (org_id, id),
  CONSTRAINT production_handoff_attempts_batch_version_chk
    CHECK (batch_version BETWEEN 1 AND 1000000),
  CONSTRAINT production_handoff_attempts_checkpoint_chk CHECK (
    checkpoint IN ('store_dispatch', 'factory_receive', 'factory_dispatch', 'store_receive')
  ),
  CONSTRAINT production_handoff_attempts_attempt_no_chk CHECK (attempt_no > 0),
  CONSTRAINT production_handoff_attempts_outcome_chk CHECK (outcome IN ('matched', 'discrepancy')),
  CONSTRAINT production_handoff_attempts_counts_chk CHECK (
    expected_count BETWEEN 1 AND 100
    AND scanned_count BETWEEN 0 AND 100
    AND matched_count BETWEEN 0 AND expected_count
    AND missing_count BETWEEN 0 AND expected_count
    AND unexpected_count BETWEEN 0 AND 100
    AND matched_count + missing_count = expected_count
    AND matched_count + unexpected_count = scanned_count
  ),
  CONSTRAINT production_handoff_attempts_outcome_shape_chk CHECK (
    (outcome = 'matched' AND missing_count = 0 AND unexpected_count = 0)
    OR (outcome = 'discrepancy' AND missing_count + unexpected_count > 0)
  )
);

CREATE INDEX IF NOT EXISTS production_handoff_attempts_batch_recorded_idx
  ON public.production_handoff_attempts
  (org_id, store_id, batch_id, checkpoint, recorded_at DESC, id);
CREATE INDEX IF NOT EXISTS production_handoff_attempts_current_idx
  ON public.production_handoff_attempts
  (org_id, store_id, batch_id, batch_version, checkpoint, attempt_no DESC, id DESC);

CREATE TABLE IF NOT EXISTS public.production_handoff_attempt_items (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  checkpoint text NOT NULL,
  garment_id uuid,
  barcode text NOT NULL,
  outcome text NOT NULL,
  recorded_at timestamptz NOT NULL,
  CONSTRAINT production_handoff_attempt_items_tenant_id_uidx
    UNIQUE (org_id, store_id, id),
  CONSTRAINT production_handoff_attempt_items_attempt_item_uidx
    UNIQUE (org_id, store_id, attempt_id, barcode),
  CONSTRAINT production_handoff_attempt_items_attempt_fk
    FOREIGN KEY (org_id, store_id, batch_id, checkpoint, attempt_id)
    REFERENCES public.production_handoff_attempts
      (org_id, store_id, batch_id, checkpoint, id),
  CONSTRAINT production_handoff_attempt_items_garment_fk
    FOREIGN KEY (org_id, store_id, garment_id)
    REFERENCES public.garments (org_id, store_id, id),
  CONSTRAINT production_handoff_attempt_items_batch_garment_fk
    FOREIGN KEY (org_id, store_id, batch_id, garment_id)
    REFERENCES public.batch_garments (org_id, store_id, batch_id, garment_id),
  CONSTRAINT production_handoff_attempt_items_checkpoint_chk CHECK (
    checkpoint IN ('store_dispatch', 'factory_receive', 'factory_dispatch', 'store_receive')
  ),
  CONSTRAINT production_handoff_attempt_items_barcode_chk CHECK (
    octet_length(barcode) BETWEEN 1 AND 64
    AND barcode !~ '[\u0001-\u001F\u007F]'
  ),
  CONSTRAINT production_handoff_attempt_items_outcome_chk CHECK (
    outcome IN ('matched', 'missing', 'unexpected')
  ),
  CONSTRAINT production_handoff_attempt_items_garment_shape_chk CHECK (
    (outcome = 'unexpected') = (garment_id IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS production_handoff_attempt_items_garment_uidx
  ON public.production_handoff_attempt_items (org_id, store_id, attempt_id, garment_id)
  WHERE garment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS production_handoff_attempt_items_batch_idx
  ON public.production_handoff_attempt_items
  (org_id, store_id, batch_id, checkpoint, attempt_id, outcome, id);
CREATE INDEX IF NOT EXISTS production_handoff_attempt_items_garment_history_idx
  ON public.production_handoff_attempt_items
  (org_id, store_id, garment_id, recorded_at DESC, id)
  WHERE garment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS production_handoff_attempt_items_attempt_outcome_idx
  ON public.production_handoff_attempt_items
  (org_id, store_id, attempt_id, outcome, garment_id, barcode);

CREATE TABLE IF NOT EXISTS public.production_handoff_checkpoints (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  checkpoint text NOT NULL,
  attempt_id uuid NOT NULL,
  outcome text NOT NULL,
  matched_count integer NOT NULL,
  missing_count integer NOT NULL,
  unexpected_count integer NOT NULL,
  staff_id uuid NOT NULL,
  device_id uuid NOT NULL,
  completed_at timestamptz NOT NULL,
  CONSTRAINT production_handoff_checkpoints_tenant_id_uidx
    UNIQUE (org_id, store_id, id),
  CONSTRAINT production_handoff_checkpoints_batch_checkpoint_uidx
    UNIQUE (org_id, store_id, batch_id, checkpoint),
  CONSTRAINT production_handoff_checkpoints_attempt_uidx
    UNIQUE (org_id, store_id, attempt_id),
  CONSTRAINT production_handoff_checkpoints_attempt_fk
    FOREIGN KEY (org_id, store_id, batch_id, checkpoint, attempt_id)
    REFERENCES public.production_handoff_attempts
      (org_id, store_id, batch_id, checkpoint, id),
  CONSTRAINT production_handoff_checkpoints_staff_fk
    FOREIGN KEY (org_id, staff_id) REFERENCES public.staffs (org_id, id),
  CONSTRAINT production_handoff_checkpoints_checkpoint_chk CHECK (
    checkpoint IN ('store_dispatch', 'factory_receive', 'factory_dispatch', 'store_receive')
  ),
  CONSTRAINT production_handoff_checkpoints_outcome_chk CHECK (
    outcome IN ('matched', 'reconciled')
  ),
  CONSTRAINT production_handoff_checkpoints_counts_chk CHECK (
    matched_count BETWEEN 1 AND 100
    AND missing_count BETWEEN 0 AND 100
    AND unexpected_count BETWEEN 0 AND 100
  ),
  CONSTRAINT production_handoff_checkpoints_outcome_shape_chk CHECK (
    (outcome = 'matched' AND missing_count = 0 AND unexpected_count = 0)
    OR (outcome = 'reconciled' AND missing_count + unexpected_count > 0)
  )
);

CREATE INDEX IF NOT EXISTS production_handoff_checkpoints_batch_completed_idx
  ON public.production_handoff_checkpoints
  (org_id, store_id, batch_id, completed_at, checkpoint);

CREATE TABLE IF NOT EXISTS public.production_handoff_discrepancy_resolutions (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  checkpoint text NOT NULL,
  attempt_id uuid NOT NULL,
  resolution_code text NOT NULL,
  staff_id uuid NOT NULL,
  device_id uuid NOT NULL,
  resolved_at timestamptz NOT NULL,
  CONSTRAINT production_handoff_discrepancy_resolutions_tenant_id_uidx
    UNIQUE (org_id, store_id, id),
  CONSTRAINT production_handoff_discrepancy_resolutions_attempt_uidx
    UNIQUE (org_id, store_id, attempt_id),
  CONSTRAINT production_handoff_discrepancy_resolutions_attempt_fk
    FOREIGN KEY (org_id, store_id, batch_id, checkpoint, attempt_id)
    REFERENCES public.production_handoff_attempts
      (org_id, store_id, batch_id, checkpoint, id),
  CONSTRAINT production_handoff_discrepancy_resolutions_staff_fk
    FOREIGN KEY (org_id, staff_id) REFERENCES public.staffs (org_id, id),
  CONSTRAINT production_handoff_discrepancy_resolutions_checkpoint_chk CHECK (
    checkpoint IN ('store_dispatch', 'factory_receive', 'factory_dispatch', 'store_receive')
  ),
  CONSTRAINT production_handoff_discrepancy_resolutions_code_chk CHECK (
    resolution_code IN ('manifest_corrected', 'recount_verified', 'exception_accepted')
  )
);

CREATE INDEX IF NOT EXISTS production_handoff_resolutions_batch_idx
  ON public.production_handoff_discrepancy_resolutions
  (org_id, store_id, batch_id, checkpoint, resolved_at, id);

CREATE TABLE IF NOT EXISTS public.garment_qc_log (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  order_id uuid NOT NULL,
  garment_id uuid NOT NULL,
  inspection_no integer NOT NULL,
  outcome text NOT NULL,
  reason_code text,
  staff_id uuid NOT NULL,
  device_id uuid NOT NULL,
  inspected_at timestamptz NOT NULL,
  CONSTRAINT garment_qc_log_tenant_id_uidx UNIQUE (org_id, store_id, id),
  CONSTRAINT garment_qc_log_batch_garment_uidx
    UNIQUE (org_id, store_id, batch_id, garment_id, inspection_no),
  CONSTRAINT garment_qc_log_batch_garment_fk
    FOREIGN KEY (org_id, store_id, batch_id, garment_id)
    REFERENCES public.batch_garments (org_id, store_id, batch_id, garment_id),
  CONSTRAINT garment_qc_log_garment_fk
    FOREIGN KEY (org_id, store_id, order_id, garment_id)
    REFERENCES public.garments (org_id, store_id, order_id, id),
  CONSTRAINT garment_qc_log_staff_fk
    FOREIGN KEY (org_id, staff_id) REFERENCES public.staffs (org_id, id),
  CONSTRAINT garment_qc_log_inspection_no_chk CHECK (inspection_no > 0),
  CONSTRAINT garment_qc_log_outcome_chk CHECK (outcome IN ('pass', 'rework')),
  CONSTRAINT garment_qc_log_reason_code_chk CHECK (
    reason_code IS NULL
    OR reason_code IN ('stain_remaining', 'damage_found', 'finish_incomplete', 'other')
  ),
  CONSTRAINT garment_qc_log_outcome_shape_chk CHECK (
    (outcome = 'pass' AND reason_code IS NULL)
    OR (outcome = 'rework' AND reason_code IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS garment_qc_log_batch_inspected_idx
  ON public.garment_qc_log (org_id, store_id, batch_id, inspected_at DESC, id);
CREATE INDEX IF NOT EXISTS garment_qc_log_garment_history_idx
  ON public.garment_qc_log (org_id, store_id, garment_id, inspected_at DESC, id);

CREATE OR REPLACE FUNCTION public.assert_factory_tenant_scope(
  requested_org_id uuid,
  requested_store_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  session_org uuid;
  session_store uuid;
BEGIN
  IF session_user <> 'laundry_app' THEN RETURN; END IF;
  session_org := NULLIF(current_setting('app.org_id', true), '')::uuid;
  session_store := NULLIF(current_setting('app.store_id', true), '')::uuid;
  IF session_org IS DISTINCT FROM requested_org_id
     OR session_store IS DISTINCT FROM requested_store_id THEN
    RAISE insufficient_privilege USING MESSAGE = 'factory tenant unavailable';
  END IF;
END;
$$;

-- Retain the original signature for replay compatibility. It deliberately
-- performs no subject locks: factory writers already acquire order -> garment
-- -> batch locks before issuing row writes.
CREATE OR REPLACE FUNCTION public.assert_factory_batch_subjects_active(
  requested_org_id uuid,
  requested_store_id uuid,
  requested_batch_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM public.assert_factory_tenant_scope(requested_org_id, requested_store_id);
END;
$$;

-- Retain the legacy trigger entry point for databases that replayed an earlier
-- draft. It is now a tenant-only guard and never acquires parent row locks.
CREATE OR REPLACE FUNCTION public.guard_factory_subject_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  row_data jsonb := to_jsonb(NEW);
BEGIN
  PERFORM public.assert_factory_tenant_scope(
    (row_data ->> 'org_id')::uuid,
    (row_data ->> 'store_id')::uuid
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_factory_batch_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  db_now timestamptz := statement_timestamp();
  required_checkpoint text;
  has_same_state_evidence boolean;
BEGIN
  PERFORM public.assert_factory_tenant_scope(NEW.org_id, NEW.store_id);
  IF TG_OP = 'INSERT' THEN
    IF NEW.version <> 1 OR NEW.exception_garment_count <> 0 THEN
      RAISE check_violation USING MESSAGE = 'factory batch must start at version one';
    END IF;
    IF session_user = 'laundry_app' AND NEW.status <> 'packing' THEN
      RAISE check_violation USING MESSAGE = 'factory batch must start in packing';
    END IF;
    NEW.created_at := db_now;
    NEW.updated_at := db_now;
    IF NEW.status IN ('store_received', 'cancelled') THEN
      NEW.completed_at := db_now;
    ELSE
      NEW.completed_at := NULL;
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status IN ('store_received', 'cancelled') THEN
    RAISE insufficient_privilege USING MESSAGE = 'terminal factory batch is immutable';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.store_id IS DISTINCT FROM OLD.store_id
     OR NEW.factory_code IS DISTINCT FROM OLD.factory_code
     OR NEW.expected_garment_count IS DISTINCT FROM OLD.expected_garment_count
     OR NEW.created_by_staff_id IS DISTINCT FROM OLD.created_by_staff_id
     OR NEW.created_by_device_id IS DISTINCT FROM OLD.created_by_device_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE insufficient_privilege USING MESSAGE = 'factory batch identity is immutable';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE check_violation USING MESSAGE = 'factory batch version must advance by one';
  END IF;

  required_checkpoint := CASE OLD.status
    WHEN 'packing' THEN 'store_dispatch'
    WHEN 'store_dispatched' THEN 'factory_receive'
    WHEN 'factory_received' THEN 'factory_dispatch'
    WHEN 'factory_dispatched' THEN 'store_receive'
    ELSE NULL
  END;
  IF NEW.status = OLD.status THEN
    IF EXISTS (
      SELECT 1
        FROM public.production_handoff_attempts attempt
       WHERE attempt.org_id = OLD.org_id AND attempt.store_id = OLD.store_id
         AND attempt.batch_id = OLD.id AND attempt.batch_version = OLD.version
         AND attempt.checkpoint = required_checkpoint
         AND attempt.outcome = 'discrepancy'
         AND NOT EXISTS (
           SELECT 1
             FROM public.production_handoff_discrepancy_resolutions resolution
            WHERE resolution.org_id = attempt.org_id
              AND resolution.store_id = attempt.store_id
              AND resolution.attempt_id = attempt.id
         )
    ) THEN
      RAISE check_violation
        USING MESSAGE = 'factory discrepancy blocks same-state batch update';
    END IF;
    SELECT
      EXISTS (
        SELECT 1 FROM public.garment_qc_log qc
         WHERE qc.org_id = OLD.org_id AND qc.store_id = OLD.store_id
           AND qc.batch_id = OLD.id AND qc.inspected_at > OLD.updated_at
      )
      OR EXISTS (
        SELECT 1 FROM public.batch_garments member
         JOIN public.garments garment
           ON garment.org_id = member.org_id
          AND garment.store_id = member.store_id
          AND garment.id = member.garment_id
         WHERE member.org_id = OLD.org_id AND member.store_id = OLD.store_id
           AND member.batch_id = OLD.id AND member.updated_at > OLD.updated_at
           AND member.state = 'exception' AND garment.status = 'lost'
           AND garment.custody_state = 'exception'
      )
      INTO has_same_state_evidence;
    IF NOT has_same_state_evidence THEN
      RAISE check_violation USING MESSAGE = 'same-state factory batch update lacks evidence';
    END IF;
  ELSIF NEW.status = 'cancelled' AND OLD.status = 'packing' THEN
    IF EXISTS (
      SELECT 1 FROM public.batch_garments member
       WHERE member.org_id = OLD.org_id AND member.store_id = OLD.store_id
         AND member.batch_id = OLD.id AND member.state <> 'completed'
    ) THEN
      RAISE check_violation USING MESSAGE = 'cancelled factory batch has live members';
    END IF;
  ELSIF (OLD.status, NEW.status) IN (
    ('packing', 'store_dispatched'),
    ('store_dispatched', 'factory_received'),
    ('factory_received', 'factory_dispatched'),
    ('factory_dispatched', 'store_received')
  ) THEN
    IF NOT EXISTS (
      SELECT 1
        FROM public.production_handoff_checkpoints checkpoint
        JOIN public.production_handoff_attempts attempt
          ON attempt.org_id = checkpoint.org_id
         AND attempt.store_id = checkpoint.store_id
         AND attempt.id = checkpoint.attempt_id
       WHERE checkpoint.org_id = OLD.org_id
         AND checkpoint.store_id = OLD.store_id
         AND checkpoint.batch_id = OLD.id
         AND checkpoint.checkpoint = required_checkpoint
         AND attempt.batch_version = OLD.version
    ) THEN
      RAISE check_violation USING MESSAGE = 'factory batch transition lacks checkpoint evidence';
    END IF;
  ELSE
    RAISE check_violation USING MESSAGE = 'illegal factory batch transition';
  END IF;

  NEW.created_at := OLD.created_at;
  NEW.updated_at := db_now;
  IF NEW.status IN ('store_received', 'cancelled') THEN
    NEW.completed_at := db_now;
  ELSE
    NEW.completed_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_factory_member_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  db_now timestamptz := statement_timestamp();
  batch_status text;
  subject record;
BEGIN
  PERFORM public.assert_factory_tenant_scope(NEW.org_id, NEW.store_id);
  SELECT batch.status INTO batch_status
    FROM public.production_batches batch
   WHERE batch.org_id = NEW.org_id AND batch.store_id = NEW.store_id
     AND batch.id = NEW.batch_id;
  IF batch_status IS NULL THEN
    RAISE foreign_key_violation USING MESSAGE = 'factory batch unavailable';
  END IF;

  SELECT garment.status, garment.custody_state,
         garment.active_production_batch_id, garment.customer_pii_purged_at,
         order_row.customer_pii_purged_at AS order_purged_at
    INTO subject
    FROM public.garments garment
    JOIN public.orders order_row
      ON order_row.org_id = garment.org_id
     AND order_row.store_id = garment.store_id
     AND order_row.id = garment.order_id
   WHERE garment.org_id = NEW.org_id AND garment.store_id = NEW.store_id
     AND garment.order_id = NEW.order_id AND garment.id = NEW.garment_id;
  IF NOT FOUND THEN
    RAISE foreign_key_violation USING MESSAGE = 'factory subject unavailable';
  END IF;
  IF subject.customer_pii_purged_at IS NOT NULL OR subject.order_purged_at IS NOT NULL THEN
    RAISE SQLSTATE 'P0001' USING MESSAGE = 'CUSTOMER_ERASED';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'active' OR NEW.qc_status <> 'pending' THEN
      RAISE check_violation USING MESSAGE = 'factory member must start active and pending';
    END IF;
    IF session_user = 'laundry_app' AND (
      batch_status <> 'packing'
      OR subject.status NOT IN ('received', 'reworked')
      OR subject.custody_state <> 'store'
      OR subject.active_production_batch_id IS NOT NULL
    ) THEN
      RAISE check_violation USING MESSAGE = 'factory member subject is not packable';
    END IF;
    NEW.added_at := db_now;
    NEW.updated_at := db_now;
    RETURN NEW;
  END IF;

  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.store_id IS DISTINCT FROM OLD.store_id
     OR NEW.batch_id IS DISTINCT FROM OLD.batch_id
     OR NEW.order_id IS DISTINCT FROM OLD.order_id
     OR NEW.garment_id IS DISTINCT FROM OLD.garment_id
     OR NEW.added_by_staff_id IS DISTINCT FROM OLD.added_by_staff_id
     OR NEW.added_by_device_id IS DISTINCT FROM OLD.added_by_device_id
     OR NEW.added_at IS DISTINCT FROM OLD.added_at THEN
    RAISE insufficient_privilege USING MESSAGE = 'factory member identity is immutable';
  END IF;
  IF OLD.state = 'completed' THEN
    RAISE insufficient_privilege USING MESSAGE = 'completed factory member is immutable';
  END IF;
  IF OLD.state = 'active' AND NEW.state = 'active' THEN
    IF batch_status <> 'factory_received'
       OR subject.active_production_batch_id IS DISTINCT FROM NEW.batch_id
       OR subject.custody_state <> 'factory'
       OR (NEW.qc_status = 'pass' AND subject.status <> 'ready')
       OR (NEW.qc_status = 'rework' AND subject.status <> 'reworked')
       OR NOT EXISTS (
         SELECT 1
           FROM public.garment_qc_log qc
          WHERE qc.org_id = NEW.org_id
            AND qc.store_id = NEW.store_id
            AND qc.batch_id = NEW.batch_id
            AND qc.garment_id = NEW.garment_id
            AND qc.outcome = NEW.qc_status
            AND qc.inspected_at > OLD.updated_at
       ) THEN
      RAISE check_violation USING MESSAGE = 'invalid factory member quality transition';
    END IF;
  ELSIF OLD.state = 'active' AND NEW.state IN ('exception', 'completed') THEN
    IF NEW.qc_status IS DISTINCT FROM OLD.qc_status THEN
      RAISE check_violation USING MESSAGE = 'factory member state cannot rewrite quality';
    END IF;
    IF NEW.state = 'exception' AND subject.custody_state <> 'exception' THEN
      RAISE check_violation USING MESSAGE = 'factory exception member lacks custody evidence';
    END IF;
    IF NEW.state = 'exception' AND subject.status = 'lost' THEN
      RAISE check_violation
        USING MESSAGE = 'factory member must be reconciled before mark lost';
    END IF;
    IF NEW.state = 'completed'
       AND NOT (
         subject.active_production_batch_id IS NULL
         AND subject.custody_state = 'store'
         AND batch_status IN ('packing', 'factory_dispatched')
       ) THEN
      RAISE check_violation USING MESSAGE = 'factory member completion is out of stage';
    END IF;
  ELSIF OLD.state = 'exception' AND NEW.state = 'exception' THEN
    IF NEW.qc_status IS DISTINCT FROM OLD.qc_status
       OR subject.status <> 'lost'
       OR subject.custody_state <> 'exception'
       OR subject.active_production_batch_id IS NOT NULL THEN
      RAISE check_violation USING MESSAGE = 'factory exception refresh lacks lost evidence';
    END IF;
  ELSE
    RAISE check_violation USING MESSAGE = 'illegal factory member transition';
  END IF;
  NEW.added_at := OLD.added_at;
  NEW.updated_at := db_now;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_factory_attempt_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  batch_row record;
  required_checkpoint text;
  next_attempt_no integer;
  active_count integer;
BEGIN
  PERFORM public.assert_factory_tenant_scope(NEW.org_id, NEW.store_id);
  SELECT batch.status, batch.version INTO batch_row
    FROM public.production_batches batch
   WHERE batch.org_id = NEW.org_id AND batch.store_id = NEW.store_id
     AND batch.id = NEW.batch_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE foreign_key_violation USING MESSAGE = 'factory batch unavailable';
  END IF;
  required_checkpoint := CASE batch_row.status
    WHEN 'packing' THEN 'store_dispatch'
    WHEN 'store_dispatched' THEN 'factory_receive'
    WHEN 'factory_received' THEN 'factory_dispatch'
    WHEN 'factory_dispatched' THEN 'store_receive'
    ELSE NULL
  END;
  IF NEW.batch_version <> batch_row.version
     OR NEW.checkpoint IS DISTINCT FROM required_checkpoint THEN
    RAISE check_violation USING MESSAGE = 'factory attempt is stale or out of stage';
  END IF;
  IF NEW.checkpoint = 'factory_dispatch' AND EXISTS (
    SELECT 1
      FROM public.batch_garments member
      JOIN public.garments garment
        ON garment.org_id = member.org_id AND garment.store_id = member.store_id
       AND garment.id = member.garment_id
     WHERE member.org_id = NEW.org_id AND member.store_id = NEW.store_id
       AND member.batch_id = NEW.batch_id AND member.state = 'active'
       AND (
         member.qc_status <> 'pass' OR garment.status <> 'ready'
         OR garment.custody_state <> 'factory'
         OR garment.active_production_batch_id IS DISTINCT FROM NEW.batch_id
       )
  ) THEN
    RAISE check_violation USING MESSAGE = 'factory dispatch manifest is not quality ready';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.production_handoff_attempts attempt
     WHERE attempt.org_id = NEW.org_id AND attempt.store_id = NEW.store_id
       AND attempt.batch_id = NEW.batch_id
       AND attempt.batch_version = NEW.batch_version
       AND attempt.checkpoint = NEW.checkpoint
       AND attempt.outcome = 'discrepancy'
       AND NOT EXISTS (
         SELECT 1 FROM public.production_handoff_discrepancy_resolutions resolution
          WHERE resolution.org_id = attempt.org_id
            AND resolution.store_id = attempt.store_id
            AND resolution.attempt_id = attempt.id
       )
  ) THEN
    RAISE check_violation USING MESSAGE = 'factory discrepancy requires reconciliation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.production_handoff_attempts attempt
     WHERE attempt.org_id = NEW.org_id AND attempt.store_id = NEW.store_id
       AND attempt.batch_id = NEW.batch_id
       AND attempt.batch_version = NEW.batch_version
       AND attempt.checkpoint = NEW.checkpoint
  ) THEN
    RAISE check_violation USING MESSAGE = 'factory checkpoint attempt already recorded';
  END IF;
  SELECT COALESCE(MAX(attempt.attempt_no), 0)::integer + 1
    INTO next_attempt_no
    FROM public.production_handoff_attempts attempt
   WHERE attempt.org_id = NEW.org_id AND attempt.store_id = NEW.store_id
     AND attempt.batch_id = NEW.batch_id AND attempt.checkpoint = NEW.checkpoint;
  SELECT count(*)::integer INTO active_count
    FROM public.batch_garments member
   WHERE member.org_id = NEW.org_id AND member.store_id = NEW.store_id
     AND member.batch_id = NEW.batch_id AND member.state = 'active';
  IF NEW.attempt_no <> next_attempt_no OR NEW.expected_count <> active_count THEN
    RAISE check_violation USING MESSAGE = 'factory attempt sequence or manifest count is invalid';
  END IF;
  NEW.recorded_at := statement_timestamp();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_factory_attempt_item_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  attempt_row record;
  subject record;
  required_checkpoint text;
BEGIN
  PERFORM public.assert_factory_tenant_scope(NEW.org_id, NEW.store_id);
  SELECT attempt.batch_version, attempt.checkpoint,
         batch.status AS batch_status, batch.version AS current_version
    INTO attempt_row
    FROM public.production_handoff_attempts attempt
    JOIN public.production_batches batch
      ON batch.org_id = attempt.org_id AND batch.store_id = attempt.store_id
     AND batch.id = attempt.batch_id
   WHERE attempt.org_id = NEW.org_id AND attempt.store_id = NEW.store_id
     AND attempt.batch_id = NEW.batch_id AND attempt.id = NEW.attempt_id;
  IF NOT FOUND THEN
    RAISE foreign_key_violation USING MESSAGE = 'factory attempt unavailable';
  END IF;
  required_checkpoint := CASE attempt_row.batch_status
    WHEN 'packing' THEN 'store_dispatch'
    WHEN 'store_dispatched' THEN 'factory_receive'
    WHEN 'factory_received' THEN 'factory_dispatch'
    WHEN 'factory_dispatched' THEN 'store_receive'
    ELSE NULL
  END;
  IF NEW.checkpoint IS DISTINCT FROM attempt_row.checkpoint
     OR attempt_row.batch_version <> attempt_row.current_version
     OR attempt_row.checkpoint IS DISTINCT FROM required_checkpoint THEN
    RAISE check_violation USING MESSAGE = 'factory attempt item is stale or out of stage';
  END IF;

  IF NEW.outcome = 'unexpected' THEN
    IF NEW.garment_id IS NOT NULL OR EXISTS (
      SELECT 1
        FROM public.batch_garments member
        JOIN public.garments garment
          ON garment.org_id = member.org_id AND garment.store_id = member.store_id
         AND garment.id = member.garment_id
       WHERE member.org_id = NEW.org_id AND member.store_id = NEW.store_id
         AND member.batch_id = NEW.batch_id AND member.state = 'active'
         AND garment.barcode = NEW.barcode
    ) THEN
      RAISE check_violation USING MESSAGE = 'unexpected barcode belongs to active manifest';
    END IF;
  ELSE
    SELECT garment.barcode, garment.customer_pii_purged_at,
           order_row.customer_pii_purged_at AS order_purged_at,
           member.state
      INTO subject
      FROM public.batch_garments member
      JOIN public.garments garment
        ON garment.org_id = member.org_id AND garment.store_id = member.store_id
       AND garment.id = member.garment_id
      JOIN public.orders order_row
        ON order_row.org_id = garment.org_id AND order_row.store_id = garment.store_id
       AND order_row.id = garment.order_id
     WHERE member.org_id = NEW.org_id AND member.store_id = NEW.store_id
       AND member.batch_id = NEW.batch_id AND member.garment_id = NEW.garment_id;
    IF NOT FOUND OR subject.state <> 'active' OR subject.barcode <> NEW.barcode THEN
      RAISE check_violation USING MESSAGE = 'factory attempt item is outside active manifest';
    END IF;
    IF subject.customer_pii_purged_at IS NOT NULL OR subject.order_purged_at IS NOT NULL THEN
      RAISE SQLSTATE 'P0001' USING MESSAGE = 'CUSTOMER_ERASED';
    END IF;
  END IF;
  NEW.recorded_at := statement_timestamp();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_factory_resolution_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  evidence record;
  required_checkpoint text;
BEGIN
  PERFORM public.assert_factory_tenant_scope(NEW.org_id, NEW.store_id);
  SELECT attempt.batch_version, attempt.checkpoint, attempt.outcome,
         batch.status AS batch_status, batch.version AS current_version,
         attempt.attempt_no
    INTO evidence
    FROM public.production_handoff_attempts attempt
    JOIN public.production_batches batch
      ON batch.org_id = attempt.org_id AND batch.store_id = attempt.store_id
     AND batch.id = attempt.batch_id
   WHERE attempt.org_id = NEW.org_id AND attempt.store_id = NEW.store_id
     AND attempt.batch_id = NEW.batch_id AND attempt.id = NEW.attempt_id;
  IF NOT FOUND THEN
    RAISE foreign_key_violation USING MESSAGE = 'factory discrepancy attempt unavailable';
  END IF;
  required_checkpoint := CASE evidence.batch_status
    WHEN 'packing' THEN 'store_dispatch'
    WHEN 'store_dispatched' THEN 'factory_receive'
    WHEN 'factory_received' THEN 'factory_dispatch'
    WHEN 'factory_dispatched' THEN 'store_receive'
    ELSE NULL
  END;
  IF evidence.outcome <> 'discrepancy'
     OR evidence.batch_version <> evidence.current_version
     OR NEW.checkpoint IS DISTINCT FROM evidence.checkpoint
     OR evidence.checkpoint IS DISTINCT FROM required_checkpoint
     OR EXISTS (
       SELECT 1 FROM public.production_handoff_attempts later
        WHERE later.org_id = NEW.org_id AND later.store_id = NEW.store_id
          AND later.batch_id = NEW.batch_id AND later.checkpoint = NEW.checkpoint
          AND later.attempt_no > evidence.attempt_no
     )
     OR EXISTS (
       SELECT 1 FROM public.production_handoff_checkpoints checkpoint
        WHERE checkpoint.org_id = NEW.org_id AND checkpoint.store_id = NEW.store_id
          AND checkpoint.attempt_id = NEW.attempt_id
     ) THEN
    RAISE check_violation USING MESSAGE = 'factory discrepancy resolution is stale';
  END IF;
  NEW.resolved_at := statement_timestamp();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_factory_checkpoint_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  evidence record;
  required_checkpoint text;
BEGIN
  PERFORM public.assert_factory_tenant_scope(NEW.org_id, NEW.store_id);
  SELECT attempt.batch_version, attempt.checkpoint, attempt.outcome,
         attempt.matched_count, attempt.missing_count, attempt.unexpected_count,
         attempt.attempt_no, batch.status AS batch_status,
         batch.version AS current_version
    INTO evidence
    FROM public.production_handoff_attempts attempt
    JOIN public.production_batches batch
      ON batch.org_id = attempt.org_id AND batch.store_id = attempt.store_id
     AND batch.id = attempt.batch_id
   WHERE attempt.org_id = NEW.org_id AND attempt.store_id = NEW.store_id
     AND attempt.batch_id = NEW.batch_id AND attempt.id = NEW.attempt_id;
  IF NOT FOUND THEN
    RAISE foreign_key_violation USING MESSAGE = 'factory checkpoint attempt unavailable';
  END IF;
  required_checkpoint := CASE evidence.batch_status
    WHEN 'packing' THEN 'store_dispatch'
    WHEN 'store_dispatched' THEN 'factory_receive'
    WHEN 'factory_received' THEN 'factory_dispatch'
    WHEN 'factory_dispatched' THEN 'store_receive'
    ELSE NULL
  END;
  IF evidence.batch_version <> evidence.current_version
     OR NEW.checkpoint IS DISTINCT FROM evidence.checkpoint
     OR evidence.checkpoint IS DISTINCT FROM required_checkpoint
     OR NEW.matched_count <> evidence.matched_count
     OR NEW.missing_count <> evidence.missing_count
     OR NEW.unexpected_count <> evidence.unexpected_count
     OR EXISTS (
       SELECT 1 FROM public.production_handoff_attempts later
        WHERE later.org_id = NEW.org_id AND later.store_id = NEW.store_id
          AND later.batch_id = NEW.batch_id AND later.checkpoint = NEW.checkpoint
          AND later.attempt_no > evidence.attempt_no
     ) THEN
    RAISE check_violation USING MESSAGE = 'factory checkpoint is stale or inconsistent';
  END IF;
  IF NEW.outcome = 'matched' AND (
    evidence.outcome <> 'matched'
    OR EXISTS (
      SELECT 1 FROM public.production_handoff_discrepancy_resolutions resolution
       WHERE resolution.org_id = NEW.org_id AND resolution.store_id = NEW.store_id
         AND resolution.attempt_id = NEW.attempt_id
    )
  ) THEN
    RAISE check_violation USING MESSAGE = 'matched checkpoint lacks exact attempt';
  END IF;
  IF NEW.outcome = 'reconciled' AND (
    evidence.outcome <> 'discrepancy'
    OR NOT EXISTS (
      SELECT 1 FROM public.production_handoff_discrepancy_resolutions resolution
       WHERE resolution.org_id = NEW.org_id AND resolution.store_id = NEW.store_id
         AND resolution.batch_id = NEW.batch_id
         AND resolution.checkpoint = NEW.checkpoint
         AND resolution.attempt_id = NEW.attempt_id
    )
  ) THEN
    RAISE check_violation USING MESSAGE = 'reconciled checkpoint lacks resolution';
  END IF;
  NEW.completed_at := statement_timestamp();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_factory_qc_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  batch_row record;
  subject record;
  next_inspection_no integer;
BEGIN
  PERFORM public.assert_factory_tenant_scope(NEW.org_id, NEW.store_id);
  SELECT batch.status, batch.version INTO batch_row
    FROM public.production_batches batch
   WHERE batch.org_id = NEW.org_id AND batch.store_id = NEW.store_id
     AND batch.id = NEW.batch_id
   FOR UPDATE;
  IF NOT FOUND OR batch_row.status <> 'factory_received' THEN
    RAISE check_violation USING MESSAGE = 'factory quality check is out of stage';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.production_handoff_attempts attempt
     WHERE attempt.org_id = NEW.org_id AND attempt.store_id = NEW.store_id
       AND attempt.batch_id = NEW.batch_id
       AND attempt.batch_version = batch_row.version
       AND attempt.checkpoint = 'factory_dispatch'
       AND attempt.outcome = 'discrepancy'
       AND NOT EXISTS (
         SELECT 1
           FROM public.production_handoff_discrepancy_resolutions resolution
          WHERE resolution.org_id = attempt.org_id
            AND resolution.store_id = attempt.store_id
            AND resolution.attempt_id = attempt.id
       )
  ) THEN
    RAISE check_violation
      USING MESSAGE = 'factory discrepancy requires reconciliation before quality check';
  END IF;
  SELECT member.order_id, member.state, garment.custody_state,
         garment.active_production_batch_id, garment.status,
         garment.customer_pii_purged_at,
         order_row.customer_pii_purged_at AS order_purged_at
    INTO subject
    FROM public.batch_garments member
    JOIN public.garments garment
      ON garment.org_id = member.org_id AND garment.store_id = member.store_id
     AND garment.id = member.garment_id
    JOIN public.orders order_row
      ON order_row.org_id = garment.org_id AND order_row.store_id = garment.store_id
     AND order_row.id = garment.order_id
   WHERE member.org_id = NEW.org_id AND member.store_id = NEW.store_id
     AND member.batch_id = NEW.batch_id AND member.garment_id = NEW.garment_id;
  IF NOT FOUND
     OR subject.order_id IS DISTINCT FROM NEW.order_id
     OR subject.state <> 'active'
     OR subject.custody_state <> 'factory'
     OR subject.active_production_batch_id IS DISTINCT FROM NEW.batch_id
     OR subject.status NOT IN ('washing', 'ready', 'reworked') THEN
    RAISE check_violation USING MESSAGE = 'factory quality subject is invalid';
  END IF;
  IF subject.customer_pii_purged_at IS NOT NULL OR subject.order_purged_at IS NOT NULL THEN
    RAISE SQLSTATE 'P0001' USING MESSAGE = 'CUSTOMER_ERASED';
  END IF;
  SELECT COALESCE(MAX(qc.inspection_no), 0)::integer + 1
    INTO next_inspection_no
    FROM public.garment_qc_log qc
   WHERE qc.org_id = NEW.org_id AND qc.store_id = NEW.store_id
     AND qc.batch_id = NEW.batch_id AND qc.garment_id = NEW.garment_id;
  IF NEW.inspection_no <> next_inspection_no THEN
    RAISE check_violation USING MESSAGE = 'factory quality inspection sequence is invalid';
  END IF;
  NEW.inspected_at := statement_timestamp();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.assert_factory_attempt_complete(
  requested_org_id uuid,
  requested_store_id uuid,
  requested_attempt_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  attempt_row record;
  item_counts record;
  has_resolution boolean;
  checkpoint_outcome text;
BEGIN
  PERFORM public.assert_factory_tenant_scope(requested_org_id, requested_store_id);
  SELECT * INTO attempt_row
    FROM public.production_handoff_attempts attempt
   WHERE attempt.org_id = requested_org_id AND attempt.store_id = requested_store_id
     AND attempt.id = requested_attempt_id;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT count(*) FILTER (WHERE item.outcome = 'matched')::integer AS matched_count,
         count(*) FILTER (WHERE item.outcome = 'missing')::integer AS missing_count,
         count(*) FILTER (WHERE item.outcome = 'unexpected')::integer AS unexpected_count
    INTO item_counts
    FROM public.production_handoff_attempt_items item
   WHERE item.org_id = requested_org_id AND item.store_id = requested_store_id
     AND item.attempt_id = requested_attempt_id;
  IF item_counts.matched_count <> attempt_row.matched_count
     OR item_counts.missing_count <> attempt_row.missing_count
     OR item_counts.unexpected_count <> attempt_row.unexpected_count THEN
    RAISE check_violation USING MESSAGE = 'factory attempt header and items disagree';
  END IF;
  SELECT EXISTS (
           SELECT 1 FROM public.production_handoff_discrepancy_resolutions resolution
            WHERE resolution.org_id = requested_org_id
              AND resolution.store_id = requested_store_id
              AND resolution.attempt_id = requested_attempt_id
         ),
         (
           SELECT checkpoint.outcome
             FROM public.production_handoff_checkpoints checkpoint
            WHERE checkpoint.org_id = requested_org_id
              AND checkpoint.store_id = requested_store_id
              AND checkpoint.attempt_id = requested_attempt_id
         )
    INTO has_resolution, checkpoint_outcome;
  IF attempt_row.outcome = 'matched' AND checkpoint_outcome IS DISTINCT FROM 'matched' THEN
    RAISE check_violation USING MESSAGE = 'exact factory attempt lacks matched checkpoint';
  END IF;
  IF attempt_row.outcome = 'discrepancy' AND (
    (has_resolution AND checkpoint_outcome IS DISTINCT FROM 'reconciled')
    OR (NOT has_resolution AND checkpoint_outcome IS NOT NULL)
  ) THEN
    RAISE check_violation USING MESSAGE = 'factory discrepancy resolution graph is incomplete';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.assert_factory_batch_graph(
  requested_org_id uuid,
  requested_store_id uuid,
  requested_batch_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  batch_row record;
  member_count integer;
  exception_count integer;
  expected_custody text;
  completed_checkpoint text;
BEGIN
  PERFORM public.assert_factory_tenant_scope(requested_org_id, requested_store_id);
  SELECT batch.status, batch.version,
         batch.expected_garment_count, batch.exception_garment_count
    INTO batch_row
    FROM public.production_batches batch
   WHERE batch.org_id = requested_org_id AND batch.store_id = requested_store_id
     AND batch.id = requested_batch_id;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT count(*)::integer,
         count(*) FILTER (WHERE member.state = 'exception')::integer
    INTO member_count, exception_count
    FROM public.batch_garments member
   WHERE member.org_id = requested_org_id AND member.store_id = requested_store_id
     AND member.batch_id = requested_batch_id;
  IF member_count <> batch_row.expected_garment_count
     OR exception_count <> batch_row.exception_garment_count THEN
    RAISE check_violation USING MESSAGE = 'factory batch manifest counts disagree';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.production_handoff_checkpoints checkpoint
      JOIN public.production_handoff_attempts attempt
        ON attempt.org_id = checkpoint.org_id
       AND attempt.store_id = checkpoint.store_id
       AND attempt.id = checkpoint.attempt_id
     WHERE checkpoint.org_id = requested_org_id
       AND checkpoint.store_id = requested_store_id
       AND checkpoint.batch_id = requested_batch_id
       AND attempt.batch_version = batch_row.version
  ) THEN
    RAISE check_violation USING MESSAGE = 'factory checkpoint has not advanced batch authority';
  END IF;
  expected_custody := CASE batch_row.status
    WHEN 'packing' THEN 'store'
    WHEN 'store_dispatched' THEN 'to_factory'
    WHEN 'factory_received' THEN 'factory'
    WHEN 'factory_dispatched' THEN 'to_store'
    ELSE NULL
  END;
  completed_checkpoint := CASE batch_row.status
    WHEN 'store_dispatched' THEN 'store_dispatch'
    WHEN 'factory_received' THEN 'factory_receive'
    WHEN 'factory_dispatched' THEN 'factory_dispatch'
    WHEN 'store_received' THEN 'store_receive'
    ELSE NULL
  END;
  IF EXISTS (
    SELECT 1
      FROM public.batch_garments member
      JOIN public.garments garment
        ON garment.org_id = member.org_id AND garment.store_id = member.store_id
       AND garment.order_id = member.order_id AND garment.id = member.garment_id
      JOIN public.orders order_row
        ON order_row.org_id = garment.org_id AND order_row.store_id = garment.store_id
       AND order_row.id = garment.order_id
     WHERE member.org_id = requested_org_id AND member.store_id = requested_store_id
       AND member.batch_id = requested_batch_id
       AND (
         (
           (garment.customer_pii_purged_at IS NOT NULL
            OR order_row.customer_pii_purged_at IS NOT NULL)
           AND NOT (
             member.state = 'exception' AND garment.status = 'lost'
             AND garment.active_production_batch_id IS NULL
           )
         )
         OR (
           member.state = 'active' AND (
             expected_custody IS NULL
             OR garment.active_production_batch_id IS DISTINCT FROM requested_batch_id
             OR garment.custody_state IS DISTINCT FROM expected_custody
             OR (batch_row.status = 'packing'
                 AND (member.qc_status <> 'pending'
                      OR garment.status NOT IN ('received', 'reworked')))
             OR (batch_row.status = 'store_dispatched'
                 AND (member.qc_status <> 'pending' OR garment.status <> 'washing'))
             OR (batch_row.status = 'factory_received'
                 AND member.qc_status = 'pending' AND garment.status <> 'washing')
             OR (batch_row.status = 'factory_dispatched'
                 AND (member.qc_status <> 'pass' OR garment.status <> 'ready'))
             OR (member.qc_status = 'pass' AND garment.status <> 'ready')
             OR (member.qc_status = 'rework' AND garment.status <> 'reworked')
             OR NOT (
               (
                 member.qc_status = 'pending'
                 AND NOT EXISTS (
                   SELECT 1 FROM public.garment_qc_log qc
                    WHERE qc.org_id = member.org_id
                      AND qc.store_id = member.store_id
                      AND qc.batch_id = member.batch_id
                      AND qc.garment_id = member.garment_id
                 )
               )
               OR member.qc_status = (
                 SELECT qc.outcome
                   FROM public.garment_qc_log qc
                  WHERE qc.org_id = member.org_id
                    AND qc.store_id = member.store_id
                    AND qc.batch_id = member.batch_id
                    AND qc.garment_id = member.garment_id
                  ORDER BY qc.inspection_no DESC, qc.id DESC
                  LIMIT 1
               )
             )
           )
         )
         OR (
           member.state = 'exception' AND (
             garment.custody_state <> 'exception'
             OR NOT (
               (
                 garment.active_production_batch_id = requested_batch_id
                 AND garment.status <> 'lost'
               )
               OR (
                 garment.active_production_batch_id IS NULL
                 AND garment.status = 'lost'
               )
             )
           )
         )
         OR (
           member.state = 'completed' AND (
             batch_row.status NOT IN ('store_received', 'cancelled')
             OR garment.active_production_batch_id IS NOT NULL
             OR NOT (
               garment.custody_state = 'store'
               OR (garment.custody_state = 'exception' AND garment.status = 'lost')
             )
           )
         )
       )
  ) THEN
    RAISE check_violation USING MESSAGE = 'factory member and garment graph disagree';
  END IF;
  IF completed_checkpoint IS NOT NULL AND EXISTS (
    SELECT 1
      FROM public.production_handoff_checkpoints checkpoint
      JOIN public.production_handoff_attempt_items item
        ON item.org_id = checkpoint.org_id
       AND item.store_id = checkpoint.store_id
       AND item.attempt_id = checkpoint.attempt_id
      JOIN public.batch_garments member
        ON member.org_id = item.org_id
       AND member.store_id = item.store_id
       AND member.batch_id = item.batch_id
       AND member.garment_id = item.garment_id
      JOIN public.garments garment
        ON garment.org_id = member.org_id
       AND garment.store_id = member.store_id
       AND garment.order_id = member.order_id
       AND garment.id = member.garment_id
     WHERE checkpoint.org_id = requested_org_id
       AND checkpoint.store_id = requested_store_id
       AND checkpoint.batch_id = requested_batch_id
       AND checkpoint.checkpoint = completed_checkpoint
       AND item.outcome <> 'unexpected'
       AND (
         (
           item.outcome = 'matched'
           AND (
             (
               batch_row.status = 'store_received'
               AND (
                 member.state IS DISTINCT FROM 'completed'
                 OR garment.active_production_batch_id IS NOT NULL
                 OR garment.custody_state IS DISTINCT FROM 'store'
               )
             )
             OR (
               batch_row.status <> 'store_received'
               AND (
                 member.state IS DISTINCT FROM 'active'
                 OR garment.active_production_batch_id IS DISTINCT FROM requested_batch_id
                 OR garment.custody_state IS DISTINCT FROM expected_custody
               )
             )
           )
         )
         OR (
           item.outcome = 'missing'
           AND (
             member.state IS DISTINCT FROM 'exception'
             OR garment.custody_state IS DISTINCT FROM 'exception'
             OR NOT (
               garment.active_production_batch_id = requested_batch_id
               OR (
                 garment.active_production_batch_id IS NULL
                 AND garment.status = 'lost'
               )
             )
           )
         )
       )
  ) THEN
    RAISE check_violation
      USING MESSAGE = 'factory checkpoint items and custody projection disagree';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.batch_garments member
     WHERE member.org_id = requested_org_id
       AND member.store_id = requested_store_id
       AND member.batch_id = requested_batch_id
       AND (
         (
           member.state = 'exception'
           AND NOT EXISTS (
             SELECT 1
               FROM public.production_handoff_attempt_items item
               JOIN public.production_handoff_discrepancy_resolutions resolution
                 ON resolution.org_id = item.org_id
                AND resolution.store_id = item.store_id
                AND resolution.batch_id = item.batch_id
                AND resolution.attempt_id = item.attempt_id
               JOIN public.production_handoff_checkpoints checkpoint
                 ON checkpoint.org_id = resolution.org_id
                AND checkpoint.store_id = resolution.store_id
                AND checkpoint.batch_id = resolution.batch_id
                AND checkpoint.attempt_id = resolution.attempt_id
                AND checkpoint.outcome = 'reconciled'
              WHERE item.org_id = member.org_id
                AND item.store_id = member.store_id
                AND item.batch_id = member.batch_id
                AND item.garment_id = member.garment_id
                AND item.outcome = 'missing'
           )
         )
         OR (
           member.state <> 'exception'
           AND EXISTS (
             SELECT 1
               FROM public.production_handoff_attempt_items item
               JOIN public.production_handoff_discrepancy_resolutions resolution
                 ON resolution.org_id = item.org_id
                AND resolution.store_id = item.store_id
                AND resolution.batch_id = item.batch_id
                AND resolution.attempt_id = item.attempt_id
               JOIN public.production_handoff_checkpoints checkpoint
                 ON checkpoint.org_id = resolution.org_id
                AND checkpoint.store_id = resolution.store_id
                AND checkpoint.batch_id = resolution.batch_id
                AND checkpoint.attempt_id = resolution.attempt_id
                AND checkpoint.outcome = 'reconciled'
              WHERE item.org_id = member.org_id
                AND item.store_id = member.store_id
                AND item.batch_id = member.batch_id
                AND item.garment_id = member.garment_id
                AND item.outcome = 'missing'
           )
         )
       )
  ) THEN
    RAISE check_violation
      USING MESSAGE = 'factory exception projection disagrees with resolved missing evidence';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_factory_deferred_consistency()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  row_data jsonb := to_jsonb(NEW);
  old_data jsonb := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE NULL END;
  row_org_id uuid := (row_data ->> 'org_id')::uuid;
  row_store_id uuid := (row_data ->> 'store_id')::uuid;
  batch_id uuid;
  attempt_id uuid;
  old_batch_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'production_handoff_attempts' THEN
    attempt_id := (row_data ->> 'id')::uuid;
  ELSIF TG_TABLE_NAME IN (
    'production_handoff_attempt_items',
    'production_handoff_checkpoints',
    'production_handoff_discrepancy_resolutions'
  ) THEN
    attempt_id := (row_data ->> 'attempt_id')::uuid;
  END IF;
  IF attempt_id IS NOT NULL THEN
    PERFORM public.assert_factory_attempt_complete(row_org_id, row_store_id, attempt_id);
  END IF;

  IF TG_TABLE_NAME = 'production_batches' THEN
    batch_id := (row_data ->> 'id')::uuid;
  ELSIF TG_TABLE_NAME <> 'garments' THEN
    batch_id := NULLIF(row_data ->> 'batch_id', '')::uuid;
  ELSE
    batch_id := NULLIF(row_data ->> 'active_production_batch_id', '')::uuid;
    old_batch_id := NULLIF(old_data ->> 'active_production_batch_id', '')::uuid;
  END IF;
  IF batch_id IS NOT NULL THEN
    PERFORM public.assert_factory_batch_graph(row_org_id, row_store_id, batch_id);
  END IF;
  IF old_batch_id IS NOT NULL AND old_batch_id IS DISTINCT FROM batch_id THEN
    PERFORM public.assert_factory_batch_graph(row_org_id, row_store_id, old_batch_id);
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_factory_qc_deferred_consistency()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  latest_id uuid;
  expected_status text;
BEGIN
  PERFORM public.assert_factory_tenant_scope(NEW.org_id, NEW.store_id);
  SELECT qc.id INTO latest_id
    FROM public.garment_qc_log qc
   WHERE qc.org_id = NEW.org_id AND qc.store_id = NEW.store_id
     AND qc.batch_id = NEW.batch_id AND qc.garment_id = NEW.garment_id
   ORDER BY qc.inspection_no DESC, qc.id DESC
   LIMIT 1;
  IF latest_id IS DISTINCT FROM NEW.id THEN RETURN NEW; END IF;
  expected_status := CASE NEW.outcome WHEN 'pass' THEN 'ready' ELSE 'reworked' END;
  IF NOT EXISTS (
    SELECT 1
      FROM public.batch_garments member
      JOIN public.garments garment
        ON garment.org_id = member.org_id AND garment.store_id = member.store_id
       AND garment.id = member.garment_id
      JOIN public.production_batches batch
        ON batch.org_id = member.org_id AND batch.store_id = member.store_id
       AND batch.id = member.batch_id
     WHERE member.org_id = NEW.org_id AND member.store_id = NEW.store_id
       AND member.batch_id = NEW.batch_id AND member.garment_id = NEW.garment_id
       AND member.state = 'active' AND member.qc_status = NEW.outcome
       AND garment.status = expected_status AND garment.custody_state = 'factory'
       AND garment.active_production_batch_id = NEW.batch_id
       AND batch.status = 'factory_received'
       AND batch.updated_at >= NEW.inspected_at
  ) THEN
    RAISE check_violation USING MESSAGE = 'factory quality evidence projection is incomplete';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_factory_active_customer_erasure()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM public.assert_factory_tenant_scope(NEW.org_id, NEW.store_id);
  IF OLD.customer_pii_purged_at IS NULL
     AND NEW.customer_pii_purged_at IS NOT NULL
     AND OLD.active_production_batch_id IS NOT NULL THEN
    RAISE SQLSTATE 'P0001' USING MESSAGE = 'CUSTOMER_FACTORY_HANDOFF_ACTIVE';
  END IF;
  IF OLD.customer_pii_purged_at IS NOT NULL
     AND (
       NEW.custody_state IS DISTINCT FROM OLD.custody_state
       OR NEW.active_production_batch_id IS DISTINCT FROM OLD.active_production_batch_id
     ) THEN
    RAISE SQLSTATE 'P0001' USING MESSAGE = 'CUSTOMER_ERASED';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.reject_factory_evidence_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE insufficient_privilege USING MESSAGE = 'factory handoff evidence is append-only';
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
     WHERE tgname = 'factory_batch_invariant_trg'
       AND tgrelid = 'public.production_batches'::regclass
  ) THEN
    CREATE TRIGGER factory_batch_invariant_trg
      BEFORE INSERT OR UPDATE ON public.production_batches
      FOR EACH ROW EXECUTE FUNCTION public.guard_factory_batch_write();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
     WHERE tgname = 'factory_member_invariant_trg'
       AND tgrelid = 'public.batch_garments'::regclass
  ) THEN
    CREATE TRIGGER factory_member_invariant_trg
      BEFORE INSERT OR UPDATE ON public.batch_garments
      FOR EACH ROW EXECUTE FUNCTION public.guard_factory_member_write();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
     WHERE tgname = 'factory_attempt_invariant_trg'
       AND tgrelid = 'public.production_handoff_attempts'::regclass
  ) THEN
    CREATE TRIGGER factory_attempt_invariant_trg
      BEFORE INSERT ON public.production_handoff_attempts
      FOR EACH ROW EXECUTE FUNCTION public.guard_factory_attempt_insert();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
     WHERE tgname = 'factory_attempt_item_invariant_trg'
       AND tgrelid = 'public.production_handoff_attempt_items'::regclass
  ) THEN
    CREATE TRIGGER factory_attempt_item_invariant_trg
      BEFORE INSERT ON public.production_handoff_attempt_items
      FOR EACH ROW EXECUTE FUNCTION public.guard_factory_attempt_item_insert();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
     WHERE tgname = 'factory_checkpoint_invariant_trg'
       AND tgrelid = 'public.production_handoff_checkpoints'::regclass
  ) THEN
    CREATE TRIGGER factory_checkpoint_invariant_trg
      BEFORE INSERT ON public.production_handoff_checkpoints
      FOR EACH ROW EXECUTE FUNCTION public.guard_factory_checkpoint_insert();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
     WHERE tgname = 'factory_resolution_invariant_trg'
       AND tgrelid = 'public.production_handoff_discrepancy_resolutions'::regclass
  ) THEN
    CREATE TRIGGER factory_resolution_invariant_trg
      BEFORE INSERT ON public.production_handoff_discrepancy_resolutions
      FOR EACH ROW EXECUTE FUNCTION public.guard_factory_resolution_insert();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
     WHERE tgname = 'factory_qc_invariant_trg'
       AND tgrelid = 'public.garment_qc_log'::regclass
  ) THEN
    CREATE TRIGGER factory_qc_invariant_trg
      BEFORE INSERT ON public.garment_qc_log
      FOR EACH ROW EXECUTE FUNCTION public.guard_factory_qc_insert();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
     WHERE tgname = 'factory_batch_graph_deferred_trg'
       AND tgrelid = 'public.production_batches'::regclass
  ) THEN
    CREATE CONSTRAINT TRIGGER factory_batch_graph_deferred_trg
      AFTER INSERT OR UPDATE ON public.production_batches
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION public.guard_factory_deferred_consistency();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
     WHERE tgname = 'factory_member_graph_deferred_trg'
       AND tgrelid = 'public.batch_garments'::regclass
  ) THEN
    CREATE CONSTRAINT TRIGGER factory_member_graph_deferred_trg
      AFTER INSERT OR UPDATE ON public.batch_garments
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION public.guard_factory_deferred_consistency();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
     WHERE tgname = 'factory_garment_graph_deferred_trg'
       AND tgrelid = 'public.garments'::regclass
  ) THEN
    CREATE CONSTRAINT TRIGGER factory_garment_graph_deferred_trg
      AFTER UPDATE ON public.garments
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION public.guard_factory_deferred_consistency();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
     WHERE tgname = 'factory_attempt_graph_deferred_trg'
       AND tgrelid = 'public.production_handoff_attempts'::regclass
  ) THEN
    CREATE CONSTRAINT TRIGGER factory_attempt_graph_deferred_trg
      AFTER INSERT ON public.production_handoff_attempts
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION public.guard_factory_deferred_consistency();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
     WHERE tgname = 'factory_attempt_item_graph_deferred_trg'
       AND tgrelid = 'public.production_handoff_attempt_items'::regclass
  ) THEN
    CREATE CONSTRAINT TRIGGER factory_attempt_item_graph_deferred_trg
      AFTER INSERT ON public.production_handoff_attempt_items
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION public.guard_factory_deferred_consistency();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
     WHERE tgname = 'factory_checkpoint_graph_deferred_trg'
       AND tgrelid = 'public.production_handoff_checkpoints'::regclass
  ) THEN
    CREATE CONSTRAINT TRIGGER factory_checkpoint_graph_deferred_trg
      AFTER INSERT ON public.production_handoff_checkpoints
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION public.guard_factory_deferred_consistency();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
     WHERE tgname = 'factory_resolution_graph_deferred_trg'
       AND tgrelid = 'public.production_handoff_discrepancy_resolutions'::regclass
  ) THEN
    CREATE CONSTRAINT TRIGGER factory_resolution_graph_deferred_trg
      AFTER INSERT ON public.production_handoff_discrepancy_resolutions
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION public.guard_factory_deferred_consistency();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
     WHERE tgname = 'factory_qc_graph_deferred_trg'
       AND tgrelid = 'public.garment_qc_log'::regclass
  ) THEN
    CREATE CONSTRAINT TRIGGER factory_qc_graph_deferred_trg
      AFTER INSERT ON public.garment_qc_log
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION public.guard_factory_deferred_consistency();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
     WHERE tgname = 'factory_qc_projection_deferred_trg'
       AND tgrelid = 'public.garment_qc_log'::regclass
  ) THEN
    CREATE CONSTRAINT TRIGGER factory_qc_projection_deferred_trg
      AFTER INSERT ON public.garment_qc_log
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION public.guard_factory_qc_deferred_consistency();
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
     WHERE tgname = 'customer_factory_active_privacy_guard_trg'
       AND tgrelid = 'public.garments'::regclass
  ) THEN
    CREATE TRIGGER customer_factory_active_privacy_guard_trg
      BEFORE UPDATE OF customer_pii_purged_at ON public.garments
      FOR EACH ROW EXECUTE FUNCTION public.guard_factory_active_customer_erasure();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
     WHERE tgname = 'customer_factory_subject_custody_guard_trg'
       AND tgrelid = 'public.garments'::regclass
  ) THEN
    CREATE TRIGGER customer_factory_subject_custody_guard_trg
      BEFORE UPDATE OF custody_state, active_production_batch_id ON public.garments
      FOR EACH ROW EXECUTE FUNCTION public.guard_factory_active_customer_erasure();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
     WHERE tgname = 'factory_subject_production_batches_trg'
       AND tgrelid = 'public.production_batches'::regclass
  ) THEN
    CREATE TRIGGER factory_subject_production_batches_trg
      BEFORE UPDATE ON public.production_batches
      FOR EACH ROW EXECUTE FUNCTION public.guard_factory_subject_write();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
     WHERE tgname = 'factory_subject_batch_garments_trg'
       AND tgrelid = 'public.batch_garments'::regclass
  ) THEN
    CREATE TRIGGER factory_subject_batch_garments_trg
      BEFORE INSERT OR UPDATE ON public.batch_garments
      FOR EACH ROW EXECUTE FUNCTION public.guard_factory_subject_write();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
     WHERE tgname = 'factory_subject_handoff_attempts_trg'
       AND tgrelid = 'public.production_handoff_attempts'::regclass
  ) THEN
    CREATE TRIGGER factory_subject_handoff_attempts_trg
      BEFORE INSERT ON public.production_handoff_attempts
      FOR EACH ROW EXECUTE FUNCTION public.guard_factory_subject_write();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
     WHERE tgname = 'factory_subject_handoff_attempt_items_trg'
       AND tgrelid = 'public.production_handoff_attempt_items'::regclass
  ) THEN
    CREATE TRIGGER factory_subject_handoff_attempt_items_trg
      BEFORE INSERT ON public.production_handoff_attempt_items
      FOR EACH ROW EXECUTE FUNCTION public.guard_factory_subject_write();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
     WHERE tgname = 'factory_subject_handoff_checkpoints_trg'
       AND tgrelid = 'public.production_handoff_checkpoints'::regclass
  ) THEN
    CREATE TRIGGER factory_subject_handoff_checkpoints_trg
      BEFORE INSERT ON public.production_handoff_checkpoints
      FOR EACH ROW EXECUTE FUNCTION public.guard_factory_subject_write();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
     WHERE tgname = 'factory_subject_handoff_resolutions_trg'
       AND tgrelid = 'public.production_handoff_discrepancy_resolutions'::regclass
  ) THEN
    CREATE TRIGGER factory_subject_handoff_resolutions_trg
      BEFORE INSERT ON public.production_handoff_discrepancy_resolutions
      FOR EACH ROW EXECUTE FUNCTION public.guard_factory_subject_write();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
     WHERE tgname = 'factory_subject_garment_qc_log_trg'
       AND tgrelid = 'public.garment_qc_log'::regclass
  ) THEN
    CREATE TRIGGER factory_subject_garment_qc_log_trg
      BEFORE INSERT ON public.garment_qc_log
      FOR EACH ROW EXECUTE FUNCTION public.guard_factory_subject_write();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
     WHERE tgname = 'production_handoff_attempts_append_only_trg'
       AND tgrelid = 'public.production_handoff_attempts'::regclass
  ) THEN
    CREATE TRIGGER production_handoff_attempts_append_only_trg
      BEFORE UPDATE OR DELETE ON public.production_handoff_attempts
      FOR EACH ROW EXECUTE FUNCTION public.reject_factory_evidence_mutation();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
     WHERE tgname = 'production_handoff_attempt_items_append_only_trg'
       AND tgrelid = 'public.production_handoff_attempt_items'::regclass
  ) THEN
    CREATE TRIGGER production_handoff_attempt_items_append_only_trg
      BEFORE UPDATE OR DELETE ON public.production_handoff_attempt_items
      FOR EACH ROW EXECUTE FUNCTION public.reject_factory_evidence_mutation();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
     WHERE tgname = 'production_handoff_checkpoints_append_only_trg'
       AND tgrelid = 'public.production_handoff_checkpoints'::regclass
  ) THEN
    CREATE TRIGGER production_handoff_checkpoints_append_only_trg
      BEFORE UPDATE OR DELETE ON public.production_handoff_checkpoints
      FOR EACH ROW EXECUTE FUNCTION public.reject_factory_evidence_mutation();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
     WHERE tgname = 'production_handoff_resolutions_append_only_trg'
       AND tgrelid = 'public.production_handoff_discrepancy_resolutions'::regclass
  ) THEN
    CREATE TRIGGER production_handoff_resolutions_append_only_trg
      BEFORE UPDATE OR DELETE ON public.production_handoff_discrepancy_resolutions
      FOR EACH ROW EXECUTE FUNCTION public.reject_factory_evidence_mutation();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
     WHERE tgname = 'garment_qc_log_append_only_trg'
       AND tgrelid = 'public.garment_qc_log'::regclass
  ) THEN
    CREATE TRIGGER garment_qc_log_append_only_trg
      BEFORE UPDATE OR DELETE ON public.garment_qc_log
      FOR EACH ROW EXECUTE FUNCTION public.reject_factory_evidence_mutation();
  END IF;
END
$$;

ALTER TABLE public.production_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.production_batches FORCE ROW LEVEL SECURITY;
ALTER TABLE public.batch_garments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.batch_garments FORCE ROW LEVEL SECURITY;
ALTER TABLE public.production_handoff_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.production_handoff_attempts FORCE ROW LEVEL SECURITY;
ALTER TABLE public.production_handoff_attempt_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.production_handoff_attempt_items FORCE ROW LEVEL SECURITY;
ALTER TABLE public.production_handoff_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.production_handoff_checkpoints FORCE ROW LEVEL SECURITY;
ALTER TABLE public.production_handoff_discrepancy_resolutions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.production_handoff_discrepancy_resolutions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.garment_qc_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.garment_qc_log FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS production_batches_store_scope ON public.production_batches;
CREATE POLICY production_batches_store_scope ON public.production_batches
  AS PERMISSIVE FOR ALL TO laundry_app
  USING (
    org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid
  );
DROP POLICY IF EXISTS production_batches_maintenance ON public.production_batches;
CREATE POLICY production_batches_maintenance ON public.production_batches
  AS PERMISSIVE FOR ALL TO laundry_owner USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS batch_garments_store_scope ON public.batch_garments;
CREATE POLICY batch_garments_store_scope ON public.batch_garments
  AS PERMISSIVE FOR ALL TO laundry_app
  USING (
    org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid
  );
DROP POLICY IF EXISTS batch_garments_maintenance ON public.batch_garments;
CREATE POLICY batch_garments_maintenance ON public.batch_garments
  AS PERMISSIVE FOR ALL TO laundry_owner USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS production_handoff_attempts_store_scope
  ON public.production_handoff_attempts;
CREATE POLICY production_handoff_attempts_store_scope ON public.production_handoff_attempts
  AS PERMISSIVE FOR ALL TO laundry_app
  USING (
    org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid
  );
DROP POLICY IF EXISTS production_handoff_attempts_maintenance
  ON public.production_handoff_attempts;
CREATE POLICY production_handoff_attempts_maintenance ON public.production_handoff_attempts
  AS PERMISSIVE FOR ALL TO laundry_owner USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS production_handoff_attempt_items_store_scope
  ON public.production_handoff_attempt_items;
CREATE POLICY production_handoff_attempt_items_store_scope
  ON public.production_handoff_attempt_items
  AS PERMISSIVE FOR ALL TO laundry_app
  USING (
    org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid
  );
DROP POLICY IF EXISTS production_handoff_attempt_items_maintenance
  ON public.production_handoff_attempt_items;
CREATE POLICY production_handoff_attempt_items_maintenance
  ON public.production_handoff_attempt_items
  AS PERMISSIVE FOR ALL TO laundry_owner USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS production_handoff_checkpoints_store_scope
  ON public.production_handoff_checkpoints;
CREATE POLICY production_handoff_checkpoints_store_scope
  ON public.production_handoff_checkpoints
  AS PERMISSIVE FOR ALL TO laundry_app
  USING (
    org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid
  );
DROP POLICY IF EXISTS production_handoff_checkpoints_maintenance
  ON public.production_handoff_checkpoints;
CREATE POLICY production_handoff_checkpoints_maintenance
  ON public.production_handoff_checkpoints
  AS PERMISSIVE FOR ALL TO laundry_owner USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS production_handoff_discrepancy_resolutions_store_scope
  ON public.production_handoff_discrepancy_resolutions;
CREATE POLICY production_handoff_discrepancy_resolutions_store_scope
  ON public.production_handoff_discrepancy_resolutions
  AS PERMISSIVE FOR ALL TO laundry_app
  USING (
    org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid
  );
DROP POLICY IF EXISTS production_handoff_discrepancy_resolutions_maintenance
  ON public.production_handoff_discrepancy_resolutions;
CREATE POLICY production_handoff_discrepancy_resolutions_maintenance
  ON public.production_handoff_discrepancy_resolutions
  AS PERMISSIVE FOR ALL TO laundry_owner USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS garment_qc_log_store_scope ON public.garment_qc_log;
CREATE POLICY garment_qc_log_store_scope ON public.garment_qc_log
  AS PERMISSIVE FOR ALL TO laundry_app
  USING (
    org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid
  );
DROP POLICY IF EXISTS garment_qc_log_maintenance ON public.garment_qc_log;
CREATE POLICY garment_qc_log_maintenance ON public.garment_qc_log
  AS PERMISSIVE FOR ALL TO laundry_owner USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE ON TABLE public.production_batches TO laundry_app;
GRANT SELECT, INSERT, UPDATE ON TABLE public.batch_garments TO laundry_app;
GRANT SELECT, INSERT ON TABLE public.production_handoff_attempts TO laundry_app;
GRANT SELECT, INSERT ON TABLE public.production_handoff_attempt_items TO laundry_app;
GRANT SELECT, INSERT ON TABLE public.production_handoff_checkpoints TO laundry_app;
GRANT SELECT, INSERT ON TABLE public.production_handoff_discrepancy_resolutions TO laundry_app;
GRANT SELECT, INSERT ON TABLE public.garment_qc_log TO laundry_app;

REVOKE DELETE, TRUNCATE ON TABLE public.production_batches FROM laundry_app;
REVOKE DELETE, TRUNCATE ON TABLE public.batch_garments FROM laundry_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.production_handoff_attempts FROM laundry_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.production_handoff_attempt_items FROM laundry_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.production_handoff_checkpoints FROM laundry_app;
REVOKE UPDATE, DELETE, TRUNCATE
  ON TABLE public.production_handoff_discrepancy_resolutions FROM laundry_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.garment_qc_log FROM laundry_app;
REVOKE ALL ON FUNCTION public.reject_factory_evidence_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_factory_tenant_scope(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_factory_batch_subjects_active(uuid, uuid, uuid)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_factory_subject_write() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_factory_batch_write() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_factory_member_write() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_factory_attempt_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_factory_attempt_item_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_factory_checkpoint_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_factory_resolution_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_factory_qc_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_factory_attempt_complete(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_factory_batch_graph(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_factory_deferred_consistency() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_factory_qc_deferred_consistency() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_factory_active_customer_erasure() FROM PUBLIC;

-- Extend the ADR-42 format-v2 export through the ADR-44 wrapper. The base call
-- owns canonical authority, graph bounds and customer-to-garment locks. This
-- layer adds only bounded, controlled factory facts linked to that same group.
DO $$
BEGIN
  IF to_regprocedure(
       'public.customer_privacy_export_v3_base(uuid,text,uuid,timestamptz)'
     ) IS NULL THEN
    ALTER FUNCTION public.customer_privacy_export(uuid, text, uuid, timestamptz)
      RENAME TO customer_privacy_export_v3_base;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.customer_factory_handoff_privacy_export(
  requested_customer_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  authority record;
  root_id uuid;
  group_ids uuid[];
  group_order_ids uuid[] := ARRAY[]::uuid[];
  group_garment_ids uuid[] := ARRAY[]::uuid[];
  group_batch_ids uuid[] := ARRAY[]::uuid[];
  evidence_count integer;
  evidence_rows jsonb;
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

  root_id := customer_canonical_root(requested_customer_id);
  IF root_id IS NULL THEN
    RETURN jsonb_build_object(
      'factory_handoff_evidence', '[]'::jsonb,
      'factory_handoff_evidence_count', 0,
      'factory_handoff_evidence_truncated', false
    );
  END IF;
  SELECT array_agg(group_row.group_customer_id ORDER BY group_row.group_customer_id)
    INTO group_ids
    FROM customer_canonical_group(root_id) group_row;
  SELECT COALESCE(array_agg(order_row.id ORDER BY order_row.id), ARRAY[]::uuid[])
    INTO group_order_ids
    FROM orders order_row
   WHERE order_row.org_id = authority.org_id
     AND order_row.customer_id = ANY(group_ids);
  SELECT COALESCE(array_agg(garment.id ORDER BY garment.id), ARRAY[]::uuid[])
    INTO group_garment_ids
    FROM garments garment
   WHERE garment.org_id = authority.org_id
     AND garment.order_id = ANY(group_order_ids);
  SELECT COALESCE(array_agg(DISTINCT member.batch_id ORDER BY member.batch_id), ARRAY[]::uuid[])
    INTO group_batch_ids
    FROM batch_garments member
   WHERE member.org_id = authority.org_id
     AND member.garment_id = ANY(group_garment_ids);

  -- The base holds order and garment locks. Factory writers take batch locks
  -- afterwards, preserving customer -> order -> garment -> batch ordering.
  PERFORM batch.id
    FROM production_batches batch
   WHERE batch.org_id = authority.org_id
     AND batch.id = ANY(group_batch_ids)
   ORDER BY batch.org_id, batch.store_id, batch.id
   FOR SHARE;
  PERFORM member.garment_id
    FROM batch_garments member
   WHERE member.org_id = authority.org_id
     AND member.garment_id = ANY(group_garment_ids)
   ORDER BY member.org_id, member.store_id, member.batch_id, member.garment_id
   FOR SHARE;
  PERFORM attempt.id
    FROM production_handoff_attempts attempt
   WHERE attempt.org_id = authority.org_id
     AND attempt.batch_id = ANY(group_batch_ids)
   ORDER BY attempt.org_id, attempt.store_id, attempt.batch_id, attempt.id
   FOR SHARE;
  PERFORM item.id
    FROM production_handoff_attempt_items item
   WHERE item.org_id = authority.org_id
     AND item.garment_id = ANY(group_garment_ids)
   ORDER BY item.org_id, item.store_id, item.attempt_id, item.id
   FOR SHARE;
  PERFORM checkpoint.id
    FROM production_handoff_checkpoints checkpoint
   WHERE checkpoint.org_id = authority.org_id
     AND checkpoint.batch_id = ANY(group_batch_ids)
   ORDER BY checkpoint.org_id, checkpoint.store_id, checkpoint.batch_id, checkpoint.id
   FOR SHARE;
  PERFORM resolution.id
    FROM production_handoff_discrepancy_resolutions resolution
   WHERE resolution.org_id = authority.org_id
     AND resolution.batch_id = ANY(group_batch_ids)
   ORDER BY resolution.org_id, resolution.store_id, resolution.batch_id, resolution.id
   FOR SHARE;
  PERFORM qc.id
    FROM garment_qc_log qc
   WHERE qc.org_id = authority.org_id
     AND qc.garment_id = ANY(group_garment_ids)
   ORDER BY qc.org_id, qc.store_id, qc.garment_id, qc.id
   FOR SHARE;

  WITH evidence AS (
    SELECT 'manifest'::text AS event_type,
           member.updated_at AS event_at,
           member.batch_id,
           member.order_id,
           member.garment_id,
           garment.barcode,
           batch.factory_code,
           batch.status AS batch_status,
           garment.custody_state,
           member.state AS manifest_state,
           member.qc_status,
           NULL::text AS checkpoint,
           NULL::text AS outcome,
           NULL::text AS code,
           NULL::integer AS matched_count,
           NULL::integer AS missing_count,
           NULL::integer AS unexpected_count,
           member.batch_id::text || ':' || member.garment_id::text AS stable_id
      FROM batch_garments member
      JOIN garments garment
        ON garment.org_id = member.org_id
       AND garment.store_id = member.store_id
       AND garment.id = member.garment_id
      JOIN production_batches batch
        ON batch.org_id = member.org_id
       AND batch.store_id = member.store_id
       AND batch.id = member.batch_id
     WHERE member.org_id = authority.org_id
       AND member.garment_id = ANY(group_garment_ids)
    UNION ALL
    SELECT 'handoff_attempt', attempt.recorded_at, attempt.batch_id,
           NULL::uuid, NULL::uuid, NULL::text, batch.factory_code,
           batch.status, NULL::text, NULL::text, NULL::text,
           attempt.checkpoint, attempt.outcome, NULL::text,
           attempt.matched_count, attempt.missing_count, attempt.unexpected_count,
           attempt.id::text
      FROM production_handoff_attempts attempt
      JOIN production_batches batch
        ON batch.org_id = attempt.org_id
       AND batch.store_id = attempt.store_id
       AND batch.id = attempt.batch_id
     WHERE attempt.org_id = authority.org_id
       AND attempt.batch_id = ANY(group_batch_ids)
    UNION ALL
    SELECT 'attempt_item', item.recorded_at, item.batch_id, garment.order_id,
           item.garment_id, item.barcode, NULL::text, NULL::text,
           garment.custody_state, NULL::text, NULL::text, item.checkpoint,
           item.outcome, NULL::text, NULL::integer, NULL::integer, NULL::integer,
           item.id::text
      FROM production_handoff_attempt_items item
      JOIN garments garment
        ON garment.org_id = item.org_id
       AND garment.store_id = item.store_id
       AND garment.id = item.garment_id
     WHERE item.org_id = authority.org_id
       AND item.garment_id = ANY(group_garment_ids)
    UNION ALL
    SELECT 'checkpoint', checkpoint.completed_at, checkpoint.batch_id,
           NULL::uuid, NULL::uuid, NULL::text, NULL::text, NULL::text,
           NULL::text, NULL::text, NULL::text, checkpoint.checkpoint,
           checkpoint.outcome, NULL::text, checkpoint.matched_count,
           checkpoint.missing_count, checkpoint.unexpected_count,
           checkpoint.id::text
      FROM production_handoff_checkpoints checkpoint
     WHERE checkpoint.org_id = authority.org_id
       AND checkpoint.batch_id = ANY(group_batch_ids)
    UNION ALL
    SELECT 'discrepancy_resolution', resolution.resolved_at, resolution.batch_id,
           NULL::uuid, NULL::uuid, NULL::text, NULL::text, NULL::text,
           NULL::text, NULL::text, NULL::text, resolution.checkpoint,
           NULL::text, resolution.resolution_code, NULL::integer,
           NULL::integer, NULL::integer, resolution.id::text
      FROM production_handoff_discrepancy_resolutions resolution
     WHERE resolution.org_id = authority.org_id
       AND resolution.batch_id = ANY(group_batch_ids)
    UNION ALL
    SELECT 'quality_inspection', qc.inspected_at, qc.batch_id, qc.order_id,
           qc.garment_id, garment.barcode, NULL::text, NULL::text,
           garment.custody_state, NULL::text, member.qc_status, NULL::text,
           qc.outcome, qc.reason_code, NULL::integer, NULL::integer,
           NULL::integer, qc.id::text
      FROM garment_qc_log qc
      JOIN garments garment
        ON garment.org_id = qc.org_id
       AND garment.store_id = qc.store_id
       AND garment.id = qc.garment_id
      JOIN batch_garments member
        ON member.org_id = qc.org_id
       AND member.store_id = qc.store_id
       AND member.batch_id = qc.batch_id
       AND member.garment_id = qc.garment_id
     WHERE qc.org_id = authority.org_id
       AND qc.garment_id = ANY(group_garment_ids)
  )
  SELECT count(*)::integer INTO evidence_count FROM evidence;

  WITH evidence AS (
    SELECT 'manifest'::text AS event_type, member.updated_at AS event_at,
           member.batch_id, member.order_id, member.garment_id, garment.barcode,
           batch.factory_code, batch.status AS batch_status,
           garment.custody_state, member.state AS manifest_state,
           member.qc_status, NULL::text AS checkpoint, NULL::text AS outcome,
           NULL::text AS code, NULL::integer AS matched_count,
           NULL::integer AS missing_count, NULL::integer AS unexpected_count,
           member.batch_id::text || ':' || member.garment_id::text AS stable_id
      FROM batch_garments member
      JOIN garments garment ON garment.org_id = member.org_id
       AND garment.store_id = member.store_id AND garment.id = member.garment_id
      JOIN production_batches batch ON batch.org_id = member.org_id
       AND batch.store_id = member.store_id AND batch.id = member.batch_id
     WHERE member.org_id = authority.org_id
       AND member.garment_id = ANY(group_garment_ids)
    UNION ALL
    SELECT 'handoff_attempt', attempt.recorded_at, attempt.batch_id,
           NULL::uuid, NULL::uuid, NULL::text, batch.factory_code, batch.status,
           NULL::text, NULL::text, NULL::text, attempt.checkpoint,
           attempt.outcome, NULL::text, attempt.matched_count,
           attempt.missing_count, attempt.unexpected_count, attempt.id::text
      FROM production_handoff_attempts attempt
      JOIN production_batches batch ON batch.org_id = attempt.org_id
       AND batch.store_id = attempt.store_id AND batch.id = attempt.batch_id
     WHERE attempt.org_id = authority.org_id
       AND attempt.batch_id = ANY(group_batch_ids)
    UNION ALL
    SELECT 'attempt_item', item.recorded_at, item.batch_id, garment.order_id,
           item.garment_id, item.barcode, NULL::text, NULL::text,
           garment.custody_state, NULL::text, NULL::text, item.checkpoint,
           item.outcome, NULL::text, NULL::integer, NULL::integer, NULL::integer,
           item.id::text
      FROM production_handoff_attempt_items item
      JOIN garments garment ON garment.org_id = item.org_id
       AND garment.store_id = item.store_id AND garment.id = item.garment_id
     WHERE item.org_id = authority.org_id
       AND item.garment_id = ANY(group_garment_ids)
    UNION ALL
    SELECT 'checkpoint', checkpoint.completed_at, checkpoint.batch_id,
           NULL::uuid, NULL::uuid, NULL::text, NULL::text, NULL::text,
           NULL::text, NULL::text, NULL::text, checkpoint.checkpoint,
           checkpoint.outcome, NULL::text, checkpoint.matched_count,
           checkpoint.missing_count, checkpoint.unexpected_count,
           checkpoint.id::text
      FROM production_handoff_checkpoints checkpoint
     WHERE checkpoint.org_id = authority.org_id
       AND checkpoint.batch_id = ANY(group_batch_ids)
    UNION ALL
    SELECT 'discrepancy_resolution', resolution.resolved_at,
           resolution.batch_id, NULL::uuid, NULL::uuid, NULL::text, NULL::text,
           NULL::text, NULL::text, NULL::text, NULL::text,
           resolution.checkpoint, NULL::text, resolution.resolution_code,
           NULL::integer, NULL::integer, NULL::integer, resolution.id::text
      FROM production_handoff_discrepancy_resolutions resolution
     WHERE resolution.org_id = authority.org_id
       AND resolution.batch_id = ANY(group_batch_ids)
    UNION ALL
    SELECT 'quality_inspection', qc.inspected_at, qc.batch_id, qc.order_id,
           qc.garment_id, garment.barcode, NULL::text, NULL::text,
           garment.custody_state, NULL::text, member.qc_status, NULL::text,
           qc.outcome, qc.reason_code, NULL::integer, NULL::integer,
           NULL::integer, qc.id::text
      FROM garment_qc_log qc
      JOIN garments garment ON garment.org_id = qc.org_id
       AND garment.store_id = qc.store_id AND garment.id = qc.garment_id
      JOIN batch_garments member ON member.org_id = qc.org_id
       AND member.store_id = qc.store_id AND member.batch_id = qc.batch_id
       AND member.garment_id = qc.garment_id
     WHERE qc.org_id = authority.org_id
       AND qc.garment_id = ANY(group_garment_ids)
  )
  SELECT COALESCE(
           jsonb_agg(
             jsonb_strip_nulls(
               jsonb_build_object(
                 'event_type', bounded.event_type,
                 'event_at', extract(epoch FROM bounded.event_at)::bigint,
                 'batch_id', bounded.batch_id,
                 'order_id', bounded.order_id,
                 'garment_id', bounded.garment_id,
                 'barcode', bounded.barcode,
                 'factory_code', bounded.factory_code,
                 'batch_status', bounded.batch_status,
                 'custody_state', bounded.custody_state,
                 'manifest_state', bounded.manifest_state,
                 'qc_status', bounded.qc_status,
                 'checkpoint', bounded.checkpoint,
                 'outcome', bounded.outcome,
                 'code', bounded.code,
                 'matched_count', bounded.matched_count,
                 'missing_count', bounded.missing_count,
                 'unexpected_count', bounded.unexpected_count
               )
             ) ORDER BY bounded.event_at, bounded.event_type, bounded.stable_id
           ),
           '[]'::jsonb
         )
    INTO evidence_rows
    FROM (
      SELECT * FROM evidence
       ORDER BY event_at, event_type, stable_id
       LIMIT 1000
    ) bounded;

  RETURN jsonb_build_object(
    'factory_handoff_evidence', evidence_rows,
    'factory_handoff_evidence_count', evidence_count,
    'factory_handoff_evidence_truncated', evidence_count > 1000
  );
END;
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
DECLARE
  base_payload jsonb;
BEGIN
  base_payload := customer_privacy_export_v3_base(
    requested_customer_id, requested_reason, event_id, requested_at
  );
  IF base_payload IS NULL THEN RETURN NULL; END IF;
  RETURN base_payload || customer_factory_handoff_privacy_export(requested_customer_id);
END;
$$;

REVOKE ALL ON FUNCTION public.customer_privacy_export_v3_base(uuid, text, uuid, timestamptz)
  FROM PUBLIC, laundry_app;
REVOKE ALL ON FUNCTION public.customer_factory_handoff_privacy_export(uuid)
  FROM PUBLIC, laundry_app;
REVOKE ALL ON FUNCTION public.customer_privacy_export(uuid, text, uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.customer_privacy_export(uuid, text, uuid, timestamptz)
  TO laundry_app;
