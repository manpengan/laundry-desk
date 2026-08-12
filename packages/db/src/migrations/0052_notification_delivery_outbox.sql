-- ADR-44: provider-neutral notification outbox.
-- New workflow rows retain only subject references, keyed recipient fingerprints
-- and message digests. Phone numbers, message bodies and provider payloads remain
-- outside the durable outbox.

CREATE TABLE IF NOT EXISTS public.notification_templates (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  code text NOT NULL,
  version integer NOT NULL,
  channel text NOT NULL,
  body text NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT notification_templates_tenant_id_uidx UNIQUE (org_id, id),
  CONSTRAINT notification_templates_code_version_uidx UNIQUE (org_id, code, version),
  CONSTRAINT notification_templates_org_fk FOREIGN KEY (org_id) REFERENCES public.orgs (id),
  CONSTRAINT notification_templates_version_chk CHECK (version > 0 AND version <= 1000000),
  CONSTRAINT notification_templates_code_chk CHECK (code = 'pickup_reminder_v1'),
  CONSTRAINT notification_templates_channel_chk CHECK (channel = 'sms'),
  CONSTRAINT notification_templates_status_chk CHECK (status IN ('active', 'retired')),
  CONSTRAINT notification_templates_body_chk CHECK (
    octet_length(body) BETWEEN 1 AND 1024
    AND body !~ '\{\{(?!tickets\}\}|garment_count\}\}|balance_cents\}\})'
  )
);

CREATE TABLE IF NOT EXISTS public.notification_delivery_batches (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  provider_code text NOT NULL,
  assurance text NOT NULL,
  channel text NOT NULL,
  template_id uuid NOT NULL,
  template_code text NOT NULL,
  template_version integer NOT NULL,
  min_age_days integer NOT NULL,
  unpaid_only boolean NOT NULL,
  garment_statuses text[] NOT NULL,
  recipient_count integer NOT NULL,
  estimated_cost_cents integer NOT NULL,
  max_cost_cents integer NOT NULL,
  created_by_staff_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT notification_delivery_batches_tenant_id_uidx UNIQUE (org_id, store_id, id),
  CONSTRAINT notification_delivery_batches_store_fk
    FOREIGN KEY (org_id, store_id) REFERENCES public.stores (org_id, id),
  CONSTRAINT notification_delivery_batches_template_fk
    FOREIGN KEY (org_id, template_id) REFERENCES public.notification_templates (org_id, id),
  CONSTRAINT notification_delivery_batches_staff_fk
    FOREIGN KEY (org_id, created_by_staff_id) REFERENCES public.staffs (org_id, id),
  CONSTRAINT notification_delivery_batches_provider_chk
    CHECK (provider_code ~ '^[a-z][a-z0-9_]{0,31}$'),
  CONSTRAINT notification_delivery_batches_assurance_chk
    CHECK (assurance IN ('software_only', 'external')),
  CONSTRAINT notification_delivery_batches_channel_chk CHECK (channel = 'sms'),
  CONSTRAINT notification_delivery_batches_template_chk CHECK (
    template_code = 'pickup_reminder_v1'
    AND template_version > 0
    AND template_version <= 1000000
  ),
  CONSTRAINT notification_delivery_batches_filter_chk CHECK (
    min_age_days IN (30, 90, 180)
    AND garment_statuses IN (
      ARRAY['ready']::text[],
      ARRAY['racked']::text[],
      ARRAY['ready', 'racked']::text[]
    )
  ),
  CONSTRAINT notification_delivery_batches_count_chk
    CHECK (recipient_count BETWEEN 1 AND 50),
  CONSTRAINT notification_delivery_batches_cost_chk CHECK (
    estimated_cost_cents BETWEEN 0 AND 100000
    AND max_cost_cents BETWEEN 0 AND 100000
    AND estimated_cost_cents <= max_cost_cents
  )
);

CREATE TABLE IF NOT EXISTS public.notification_deliveries (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  order_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  status text NOT NULL,
  recipient_hmac char(64),
  message_sha256 char(64),
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  claimed_at timestamptz,
  lease_until timestamptz,
  lease_token uuid,
  worker_id text,
  last_error_code text,
  provider_ref_sha256 char(64),
  cost_cents integer NOT NULL DEFAULT 0,
  reserved_cost_cents integer NOT NULL DEFAULT 0,
  provider_outcome_pending boolean NOT NULL DEFAULT false,
  accepted_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT notification_deliveries_tenant_id_uidx UNIQUE (org_id, store_id, id),
  CONSTRAINT notification_deliveries_batch_order_uidx UNIQUE (org_id, store_id, batch_id, order_id),
  CONSTRAINT notification_deliveries_batch_fk
    FOREIGN KEY (org_id, store_id, batch_id)
    REFERENCES public.notification_delivery_batches (org_id, store_id, id),
  CONSTRAINT notification_deliveries_order_fk
    FOREIGN KEY (org_id, store_id, order_id) REFERENCES public.orders (org_id, store_id, id),
  CONSTRAINT notification_deliveries_customer_fk
    FOREIGN KEY (org_id, customer_id) REFERENCES public.customers (org_id, id),
  CONSTRAINT notification_deliveries_status_chk CHECK (
    status IN (
      'queued', 'sending', 'retry_wait', 'accepted', 'delivered',
      'manual_required', 'cancelled'
    )
  ),
  CONSTRAINT notification_deliveries_attempt_chk CHECK (attempt_count BETWEEN 0 AND 5),
  CONSTRAINT notification_deliveries_hash_chk CHECK (
    (recipient_hmac IS NULL OR recipient_hmac ~ '^[0-9a-f]{64}$')
    AND (message_sha256 IS NULL OR message_sha256 ~ '^[0-9a-f]{64}$')
    AND (provider_ref_sha256 IS NULL OR provider_ref_sha256 ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT notification_deliveries_error_chk CHECK (
    last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'
  ),
  CONSTRAINT notification_deliveries_cost_chk CHECK (
    cost_cents BETWEEN 0 AND 100000
    AND reserved_cost_cents BETWEEN 0 AND 100000
  ),
  CONSTRAINT notification_deliveries_time_chk CHECK (
    updated_at >= created_at
    AND (next_attempt_at IS NULL OR next_attempt_at >= created_at)
    AND (accepted_at IS NULL OR accepted_at >= created_at)
    AND (delivered_at IS NULL OR (accepted_at IS NOT NULL AND delivered_at >= accepted_at))
  ),
  CONSTRAINT notification_deliveries_lease_chk CHECK (
    (
      status = 'sending'
      AND claimed_at IS NOT NULL
      AND lease_until IS NOT NULL
      AND lease_until > claimed_at
      AND lease_token IS NOT NULL
      AND worker_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'
    )
    OR (
      status <> 'sending'
      AND claimed_at IS NULL
      AND lease_until IS NULL
      AND lease_token IS NULL
      AND worker_id IS NULL
    )
  ),
  CONSTRAINT notification_deliveries_fingerprint_chk CHECK (
    (status IN ('queued', 'sending', 'retry_wait')
      AND recipient_hmac IS NOT NULL AND message_sha256 IS NOT NULL)
    OR status = 'accepted'
    OR (status IN ('delivered', 'manual_required', 'cancelled')
      AND recipient_hmac IS NULL AND message_sha256 IS NULL)
  ),
  CONSTRAINT notification_deliveries_state_shape_chk CHECK (
    (status = 'queued'
      AND attempt_count = 0
      AND next_attempt_at IS NOT NULL
      AND last_error_code IS NULL
      AND provider_ref_sha256 IS NULL
      AND cost_cents = 0
      AND reserved_cost_cents = 0
      AND NOT provider_outcome_pending
      AND accepted_at IS NULL
      AND delivered_at IS NULL)
    OR (status = 'sending'
      AND next_attempt_at IS NULL
      AND last_error_code IS NULL
      AND provider_ref_sha256 IS NULL
      AND cost_cents = 0
      AND provider_outcome_pending
      AND accepted_at IS NULL
      AND delivered_at IS NULL)
    OR (status = 'retry_wait'
      AND next_attempt_at IS NOT NULL
      AND last_error_code IS NOT NULL
      AND provider_ref_sha256 IS NULL
      AND cost_cents = 0
      AND NOT provider_outcome_pending
      AND accepted_at IS NULL
      AND delivered_at IS NULL)
    OR (status = 'accepted'
      AND next_attempt_at IS NULL
      AND last_error_code IS NULL
      AND provider_ref_sha256 IS NOT NULL
      AND reserved_cost_cents = 0
      AND NOT provider_outcome_pending
      AND accepted_at IS NOT NULL
      AND delivered_at IS NULL)
    OR (status = 'delivered'
      AND next_attempt_at IS NULL
      AND last_error_code IS NULL
      AND provider_ref_sha256 IS NOT NULL
      AND reserved_cost_cents = 0
      AND NOT provider_outcome_pending
      AND accepted_at IS NOT NULL
      AND delivered_at IS NOT NULL)
    OR (status = 'manual_required'
      AND next_attempt_at IS NULL
      AND last_error_code IS NOT NULL
      AND NOT provider_outcome_pending
      AND delivered_at IS NULL)
    OR (status = 'cancelled'
      AND next_attempt_at IS NULL
      AND last_error_code IS NOT NULL
      AND reserved_cost_cents = 0
      AND NOT provider_outcome_pending
      AND delivered_at IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS public.notification_delivery_attempts (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  delivery_id uuid NOT NULL,
  attempt_no integer NOT NULL,
  outcome text NOT NULL,
  error_code text,
  provider_ref_sha256 char(64),
  cost_cents integer NOT NULL,
  started_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL,
  CONSTRAINT notification_delivery_attempts_tenant_id_uidx UNIQUE (org_id, store_id, id),
  CONSTRAINT notification_delivery_attempts_delivery_no_uidx
    UNIQUE (org_id, store_id, delivery_id, attempt_no),
  CONSTRAINT notification_delivery_attempts_delivery_fk
    FOREIGN KEY (org_id, store_id, delivery_id)
    REFERENCES public.notification_deliveries (org_id, store_id, id),
  CONSTRAINT notification_delivery_attempts_no_chk CHECK (attempt_no BETWEEN 1 AND 5),
  CONSTRAINT notification_delivery_attempts_outcome_chk CHECK (
    outcome IN ('accepted', 'transient_failure', 'permanent_failure', 'uncertain')
  ),
  CONSTRAINT notification_delivery_attempts_error_chk CHECK (
    error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'
  ),
  CONSTRAINT notification_delivery_attempts_ref_chk CHECK (
    provider_ref_sha256 IS NULL OR provider_ref_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT notification_delivery_attempts_cost_chk CHECK (cost_cents BETWEEN 0 AND 100000),
  CONSTRAINT notification_delivery_attempts_time_chk CHECK (completed_at >= started_at),
  CONSTRAINT notification_delivery_attempts_shape_chk CHECK (
    (outcome = 'accepted' AND error_code IS NULL AND provider_ref_sha256 IS NOT NULL)
    OR (outcome <> 'accepted' AND error_code IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS public.notification_delivery_receipts (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  delivery_id uuid NOT NULL,
  provider_code text NOT NULL,
  receipt_sha256 char(64) NOT NULL,
  status text NOT NULL,
  observed_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL,
  CONSTRAINT notification_delivery_receipts_tenant_id_uidx UNIQUE (org_id, store_id, id),
  CONSTRAINT notification_delivery_receipts_provider_uidx
    UNIQUE (org_id, store_id, provider_code, receipt_sha256),
  CONSTRAINT notification_delivery_receipts_delivery_fk
    FOREIGN KEY (org_id, store_id, delivery_id)
    REFERENCES public.notification_deliveries (org_id, store_id, id),
  CONSTRAINT notification_delivery_receipts_provider_chk
    CHECK (provider_code ~ '^[a-z][a-z0-9_]{0,31}$'),
  CONSTRAINT notification_delivery_receipts_hash_chk
    CHECK (receipt_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT notification_delivery_receipts_status_chk
    CHECK (status IN ('delivered', 'failed')),
  CONSTRAINT notification_delivery_receipts_time_chk CHECK (recorded_at >= observed_at)
);

CREATE INDEX IF NOT EXISTS notification_delivery_batches_recent_idx
  ON public.notification_delivery_batches (org_id, store_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS notification_deliveries_claim_idx
  ON public.notification_deliveries (
    org_id, store_id, status, next_attempt_at, lease_until, created_at, id
  );
CREATE INDEX IF NOT EXISTS notification_deliveries_batch_idx
  ON public.notification_deliveries (org_id, store_id, batch_id, created_at, id);
CREATE INDEX IF NOT EXISTS notification_deliveries_order_idx
  ON public.notification_deliveries (org_id, store_id, order_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS notification_deliveries_order_uidx
  ON public.notification_deliveries (org_id, store_id, order_id);
CREATE UNIQUE INDEX IF NOT EXISTS ai_pending_notification_idempotency_uidx
  ON public.ai_pending_actions (org_id, store_id, command, idempotency_key)
  WHERE command = 'notification.delivery_batch.enqueue';
CREATE INDEX IF NOT EXISTS notification_delivery_attempts_delivery_idx
  ON public.notification_delivery_attempts (org_id, store_id, delivery_id, attempt_no);
CREATE INDEX IF NOT EXISTS notification_delivery_receipts_delivery_idx
  ON public.notification_delivery_receipts (org_id, store_id, delivery_id, observed_at);

-- Seed the single reviewed template for organizations that already exist when
-- this migration is applied. Fresh installations provision it only when the
-- commissioning marker is committed, rather than as a side effect of every
-- maintenance/test organization row.
INSERT INTO public.notification_templates (
  id, org_id, code, version, channel, body, status, created_at
)
SELECT gen_random_uuid(), org_row.id, 'pickup_reminder_v1', 1, 'sms',
       '您好，您的洗衣订单{{tickets}}共{{garment_count}}件已可取，尚欠{{balance_cents}}分，请方便时到店取衣。',
       'active', now()
  FROM public.orgs org_row
ON CONFLICT (org_id, code, version) DO NOTHING;

CREATE OR REPLACE FUNCTION public.seed_commissioned_notification_template()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  INSERT INTO public.notification_templates (
    id, org_id, code, version, channel, body, status, created_at
  ) VALUES (
    gen_random_uuid(), NEW.org_id, 'pickup_reminder_v1', 1, 'sms',
    '您好，您的洗衣订单{{tickets}}共{{garment_count}}件已可取，尚欠{{balance_cents}}分，请方便时到店取衣。',
    'active', COALESCE(NEW.created_at, now())
  )
  ON CONFLICT (org_id, code, version) DO NOTHING;
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
     WHERE tgname = 'commissioning_seed_notification_template_trg'
       AND tgrelid = 'public.local_bootstrap_metadata'::regclass
  ) THEN
    CREATE TRIGGER commissioning_seed_notification_template_trg
      AFTER INSERT ON public.local_bootstrap_metadata
      FOR EACH ROW EXECUTE FUNCTION public.seed_commissioned_notification_template();
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.reject_notification_evidence_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE insufficient_privilege USING MESSAGE = 'notification evidence is append-only';
END;
$$;

CREATE TRIGGER notification_templates_append_only_trg
  BEFORE UPDATE OR DELETE ON public.notification_templates
  FOR EACH ROW EXECUTE FUNCTION public.reject_notification_evidence_mutation();
CREATE TRIGGER notification_delivery_batches_append_only_trg
  BEFORE UPDATE OR DELETE ON public.notification_delivery_batches
  FOR EACH ROW EXECUTE FUNCTION public.reject_notification_evidence_mutation();
CREATE TRIGGER notification_delivery_attempts_append_only_trg
  BEFORE UPDATE OR DELETE ON public.notification_delivery_attempts
  FOR EACH ROW EXECUTE FUNCTION public.reject_notification_evidence_mutation();
CREATE TRIGGER notification_delivery_receipts_append_only_trg
  BEFORE UPDATE OR DELETE ON public.notification_delivery_receipts
  FOR EACH ROW EXECUTE FUNCTION public.reject_notification_evidence_mutation();

CREATE OR REPLACE FUNCTION public.notification_recipient_matches(
  requested_org uuid,
  requested_store uuid,
  requested_order uuid,
  requested_customer uuid,
  expected_hmac text
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  session_org uuid := NULLIF(current_setting('app.org_id', true), '')::uuid;
  session_store uuid := NULLIF(current_setting('app.store_id', true), '')::uuid;
  current_phone text;
  current_customer uuid;
  purged_at timestamptz;
BEGIN
  IF session_user = 'laundry_app' AND (
    session_org IS DISTINCT FROM requested_org
    OR session_store IS DISTINCT FROM requested_store
  ) THEN
    RAISE insufficient_privilege USING MESSAGE = 'notification tenant unavailable';
  END IF;
  SELECT order_row.customer_id, order_row.customer_phone,
         order_row.customer_pii_purged_at
    INTO current_customer, current_phone, purged_at
    FROM orders order_row
   WHERE order_row.org_id = requested_org
     AND order_row.store_id = requested_store
     AND order_row.id = requested_order;
  RETURN current_customer = requested_customer
    AND purged_at IS NULL
    AND current_phone ~ '^1[3-9][0-9]{9}$'
    AND expected_hmac = customer_phone_hmac(requested_org, current_phone);
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_notification_delivery()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  session_org uuid := NULLIF(current_setting('app.org_id', true), '')::uuid;
  session_store uuid := NULLIF(current_setting('app.store_id', true), '')::uuid;
  order_customer_id uuid;
  order_phone text;
  order_purged_at timestamptz;
  is_lease_renewal boolean := false;
BEGIN
  IF session_user = 'laundry_app' AND (
    session_org IS DISTINCT FROM NEW.org_id
    OR session_store IS DISTINCT FROM NEW.store_id
  ) THEN
    RAISE insufficient_privilege USING MESSAGE = 'notification tenant unavailable';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'queued'
       OR NEW.attempt_count <> 0
       OR NEW.last_error_code IS NOT NULL
       OR NEW.provider_ref_sha256 IS NOT NULL
       OR NEW.cost_cents <> 0
       OR NEW.reserved_cost_cents <> 0
       OR NEW.provider_outcome_pending
       OR NEW.accepted_at IS NOT NULL
       OR NEW.delivered_at IS NOT NULL THEN
      RAISE check_violation USING MESSAGE = 'NOTIFICATION_INITIAL_STATE_INVALID';
    END IF;
    SELECT order_row.customer_id, order_row.customer_phone,
           order_row.customer_pii_purged_at
      INTO order_customer_id, order_phone, order_purged_at
      FROM orders order_row
     WHERE order_row.org_id = NEW.org_id
       AND order_row.store_id = NEW.store_id
       AND order_row.id = NEW.order_id
     FOR SHARE;
    IF order_customer_id IS NULL OR order_customer_id <> NEW.customer_id THEN
      RAISE check_violation USING MESSAGE = 'NOTIFICATION_CUSTOMER_MISMATCH';
    END IF;
    IF order_purged_at IS NOT NULL OR order_phone !~ '^1[3-9][0-9]{9}$' THEN
      RAISE check_violation USING MESSAGE = 'CUSTOMER_ERASED';
    END IF;
    NEW.recipient_hmac := customer_phone_hmac(NEW.org_id, order_phone);
    RETURN NEW;
  END IF;

  IF NEW.org_id <> OLD.org_id
     OR NEW.store_id <> OLD.store_id
     OR NEW.batch_id <> OLD.batch_id
     OR NEW.order_id <> OLD.order_id
     OR NEW.customer_id <> OLD.customer_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE check_violation USING MESSAGE = 'NOTIFICATION_IDENTITY_IMMUTABLE';
  END IF;

  is_lease_renewal := OLD.status = 'sending'
    AND NEW.status = 'sending'
    AND NEW.lease_until > OLD.lease_until
    AND NEW.updated_at >= OLD.updated_at
    AND (to_jsonb(NEW) - 'lease_until' - 'updated_at')
      = (to_jsonb(OLD) - 'lease_until' - 'updated_at');

  IF NEW.status <> OLD.status AND NOT (
    (OLD.status IN ('queued', 'retry_wait')
      AND NEW.status IN ('sending', 'manual_required', 'cancelled'))
    OR (OLD.status = 'sending'
      AND NEW.status IN ('sending', 'accepted', 'retry_wait', 'manual_required', 'cancelled'))
    OR (OLD.status = 'accepted'
      AND NEW.status IN ('delivered', 'manual_required'))
  ) THEN
    RAISE check_violation USING MESSAGE = 'NOTIFICATION_STATUS_INVALID';
  END IF;

  IF NEW.status = 'sending'
     AND OLD.status IN ('queued', 'sending', 'retry_wait')
     AND NOT is_lease_renewal
     AND NEW.attempt_count <> OLD.attempt_count + 1 THEN
    RAISE check_violation USING MESSAGE = 'NOTIFICATION_ATTEMPT_INVALID';
  END IF;
  IF NOT (
    (NEW.status = 'sending' AND OLD.status IN ('queued', 'sending', 'retry_wait'))
    OR is_lease_renewal
  ) AND NEW.attempt_count <> OLD.attempt_count THEN
    RAISE check_violation USING MESSAGE = 'NOTIFICATION_ATTEMPT_INVALID';
  END IF;

  IF (
    NEW.recipient_hmac IS DISTINCT FROM OLD.recipient_hmac
    OR NEW.message_sha256 IS DISTINCT FROM OLD.message_sha256
  ) AND NOT (
    NEW.status IN ('delivered', 'manual_required', 'cancelled')
    OR (
      OLD.status = 'accepted'
      AND NEW.status = 'accepted'
      AND NEW.recipient_hmac IS NULL
      AND NEW.message_sha256 IS NULL
    )
  ) THEN
    RAISE check_violation USING MESSAGE = 'NOTIFICATION_FINGERPRINT_IMMUTABLE';
  END IF;

  IF OLD.status = 'sending' AND NEW.status = 'sending'
     AND NOT is_lease_renewal
     AND (OLD.lease_until IS NULL OR OLD.lease_until > statement_timestamp()) THEN
    RAISE check_violation USING MESSAGE = 'NOTIFICATION_LEASE_ACTIVE';
  END IF;

  IF NEW.status = 'sending' THEN
    SELECT order_row.customer_id, order_row.customer_phone,
           order_row.customer_pii_purged_at
      INTO order_customer_id, order_phone, order_purged_at
      FROM orders order_row
     WHERE order_row.org_id = NEW.org_id
       AND order_row.store_id = NEW.store_id
       AND order_row.id = NEW.order_id
     FOR SHARE;
    IF order_customer_id IS NULL OR order_customer_id <> NEW.customer_id
       OR order_purged_at IS NOT NULL
       OR order_phone !~ '^1[3-9][0-9]{9}$'
       OR NEW.recipient_hmac <> customer_phone_hmac(NEW.org_id, order_phone) THEN
      RAISE check_violation USING MESSAGE = 'CUSTOMER_ERASED';
    END IF;
  END IF;

  IF NEW.status IN ('delivered', 'manual_required', 'cancelled') THEN
    NEW.recipient_hmac := NULL;
    NEW.message_sha256 := NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER notification_deliveries_guard_trg
  BEFORE INSERT OR UPDATE ON public.notification_deliveries
  FOR EACH ROW EXECUTE FUNCTION public.guard_notification_delivery();

CREATE OR REPLACE FUNCTION public.cancel_notification_delivery_for_privacy()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.customer_pii_purged_at IS NULL AND NEW.customer_pii_purged_at IS NOT NULL THEN
    IF EXISTS (
      SELECT 1
        FROM notification_deliveries delivery
       WHERE delivery.org_id = NEW.org_id
         AND delivery.store_id = NEW.store_id
         AND delivery.order_id = NEW.id
         AND delivery.status = 'sending'
         AND delivery.lease_until > statement_timestamp()
    ) THEN
      RAISE object_in_use USING MESSAGE = 'CUSTOMER_NOTIFICATION_IN_FLIGHT';
    END IF;

    UPDATE notification_deliveries delivery
       SET status = CASE
             WHEN delivery.status IN ('queued', 'retry_wait', 'sending') THEN 'cancelled'
             ELSE delivery.status
           END,
           recipient_hmac = NULL,
           message_sha256 = NULL,
           next_attempt_at = NULL,
           claimed_at = NULL,
           lease_until = NULL,
           lease_token = NULL,
           worker_id = NULL,
           reserved_cost_cents = 0,
           provider_outcome_pending = false,
           last_error_code = CASE
             WHEN delivery.status IN ('queued', 'retry_wait', 'sending')
               THEN 'CUSTOMER_ERASED'
             ELSE delivery.last_error_code
           END,
           updated_at = GREATEST(delivery.updated_at, NEW.customer_pii_purged_at)
     WHERE delivery.org_id = NEW.org_id
       AND delivery.store_id = NEW.store_id
       AND delivery.order_id = NEW.id
       AND delivery.status NOT IN ('delivered', 'manual_required', 'cancelled');
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER orders_cancel_notification_delivery_for_privacy_trg
  BEFORE UPDATE OF customer_pii_purged_at ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.cancel_notification_delivery_for_privacy();

ALTER TABLE public.notification_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_templates FORCE ROW LEVEL SECURITY;
ALTER TABLE public.notification_delivery_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_delivery_batches FORCE ROW LEVEL SECURITY;
ALTER TABLE public.notification_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_deliveries FORCE ROW LEVEL SECURITY;
ALTER TABLE public.notification_delivery_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_delivery_attempts FORCE ROW LEVEL SECURITY;
ALTER TABLE public.notification_delivery_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_delivery_receipts FORCE ROW LEVEL SECURITY;

CREATE POLICY notification_templates_org_scope ON public.notification_templates
  AS PERMISSIVE FOR ALL TO laundry_app
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
CREATE POLICY notification_templates_maintenance ON public.notification_templates
  AS PERMISSIVE FOR ALL TO laundry_owner USING (true) WITH CHECK (true);

CREATE POLICY notification_delivery_batches_store_scope ON public.notification_delivery_batches
  AS PERMISSIVE FOR ALL TO laundry_app
  USING (
    org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid
  );
CREATE POLICY notification_delivery_batches_maintenance ON public.notification_delivery_batches
  AS PERMISSIVE FOR ALL TO laundry_owner USING (true) WITH CHECK (true);

CREATE POLICY notification_deliveries_store_scope ON public.notification_deliveries
  AS PERMISSIVE FOR ALL TO laundry_app
  USING (
    org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid
  );
CREATE POLICY notification_deliveries_maintenance ON public.notification_deliveries
  AS PERMISSIVE FOR ALL TO laundry_owner USING (true) WITH CHECK (true);

CREATE POLICY notification_delivery_attempts_store_scope ON public.notification_delivery_attempts
  AS PERMISSIVE FOR ALL TO laundry_app
  USING (
    org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid
  );
CREATE POLICY notification_delivery_attempts_maintenance ON public.notification_delivery_attempts
  AS PERMISSIVE FOR ALL TO laundry_owner USING (true) WITH CHECK (true);

CREATE POLICY notification_delivery_receipts_store_scope ON public.notification_delivery_receipts
  AS PERMISSIVE FOR ALL TO laundry_app
  USING (
    org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid
  );
CREATE POLICY notification_delivery_receipts_maintenance ON public.notification_delivery_receipts
  AS PERMISSIVE FOR ALL TO laundry_owner USING (true) WITH CHECK (true);

GRANT SELECT ON TABLE public.notification_templates TO laundry_app;
GRANT SELECT, INSERT ON TABLE public.notification_delivery_batches TO laundry_app;
GRANT SELECT, INSERT, UPDATE ON TABLE public.notification_deliveries TO laundry_app;
GRANT SELECT, INSERT ON TABLE public.notification_delivery_attempts TO laundry_app;
GRANT SELECT, INSERT ON TABLE public.notification_delivery_receipts TO laundry_app;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.notification_templates FROM laundry_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.notification_delivery_batches FROM laundry_app;
REVOKE DELETE, TRUNCATE ON TABLE public.notification_deliveries FROM laundry_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.notification_delivery_attempts FROM laundry_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.notification_delivery_receipts FROM laundry_app;

REVOKE ALL ON FUNCTION public.seed_commissioned_notification_template() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reject_notification_evidence_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.notification_recipient_matches(uuid, uuid, uuid, uuid, text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.notification_recipient_matches(uuid, uuid, uuid, uuid, text)
  TO laundry_app;
REVOKE ALL ON FUNCTION public.guard_notification_delivery() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cancel_notification_delivery_for_privacy() FROM PUBLIC;

-- Extend ADR-42 format v2 without copying its large canonical-profile export.
-- The renamed base keeps the original authority, graph and lock semantics; the
-- wrapper adds only bounded operational notification evidence from this migration.
DO $$
BEGIN
  IF to_regprocedure(
       'public.customer_privacy_export_v2_base(uuid,text,uuid,timestamptz)'
     ) IS NULL THEN
    ALTER FUNCTION public.customer_privacy_export(uuid, text, uuid, timestamptz)
      RENAME TO customer_privacy_export_v2_base;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.customer_notification_privacy_export(
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
  delivery_count integer;
  delivery_rows jsonb;
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
      'notification_deliveries', '[]'::jsonb,
      'notification_delivery_count', 0,
      'notification_deliveries_truncated', false
    );
  END IF;
  SELECT array_agg(group_row.group_customer_id)
    INTO group_ids
    FROM customer_canonical_group(root_id) group_row;
  SELECT COALESCE(array_agg(order_row.id ORDER BY order_row.id), ARRAY[]::uuid[])
    INTO group_order_ids
    FROM orders order_row
   WHERE order_row.org_id = authority.org_id
     AND order_row.customer_id = ANY(group_ids);

  -- ADR-42 already holds customer -> account -> print -> order -> garment. Add
  -- delivery locks afterwards so settle/receipt cannot change the evidence view.
  PERFORM delivery.id
    FROM notification_deliveries delivery
   WHERE delivery.org_id = authority.org_id
     AND delivery.order_id = ANY(group_order_ids)
   ORDER BY delivery.org_id, delivery.store_id, delivery.id
   FOR SHARE;

  SELECT count(*)::integer INTO delivery_count
    FROM notification_deliveries delivery
   WHERE delivery.org_id = authority.org_id
     AND delivery.order_id = ANY(group_order_ids);

  SELECT COALESCE(
           jsonb_agg(to_jsonb(bounded) ORDER BY bounded.created_at, bounded.delivery_id),
           '[]'::jsonb
         )
    INTO delivery_rows
    FROM (
      SELECT delivery.id AS delivery_id,
             delivery.batch_id,
             delivery.store_id,
             delivery.order_id,
             delivery.customer_id,
             delivery.status,
             batch.assurance,
             batch.provider_code,
             batch.template_code,
             batch.template_version,
             delivery.attempt_count,
             delivery.last_error_code,
             delivery.cost_cents,
             delivery.reserved_cost_cents,
             extract(epoch FROM delivery.created_at)::bigint AS created_at,
             extract(epoch FROM delivery.updated_at)::bigint AS updated_at,
             CASE WHEN delivery.accepted_at IS NULL THEN NULL
               ELSE extract(epoch FROM delivery.accepted_at)::bigint END AS accepted_at,
             CASE WHEN delivery.delivered_at IS NULL THEN NULL
               ELSE extract(epoch FROM delivery.delivered_at)::bigint END AS delivered_at,
             (
               SELECT COALESCE(
                 jsonb_agg(
                   jsonb_build_object(
                     'attempt_no', attempt.attempt_no,
                     'outcome', attempt.outcome,
                     'error_code', attempt.error_code,
                     'cost_cents', attempt.cost_cents,
                     'started_at', extract(epoch FROM attempt.started_at)::bigint,
                     'completed_at', extract(epoch FROM attempt.completed_at)::bigint
                   ) ORDER BY attempt.attempt_no
                 ),
                 '[]'::jsonb
               )
                 FROM notification_delivery_attempts attempt
                WHERE attempt.org_id = delivery.org_id
                  AND attempt.store_id = delivery.store_id
                  AND attempt.delivery_id = delivery.id
             ) AS attempts,
             (
               SELECT count(*)::integer
                 FROM notification_delivery_receipts receipt
                WHERE receipt.org_id = delivery.org_id
                  AND receipt.store_id = delivery.store_id
                  AND receipt.delivery_id = delivery.id
             ) AS receipt_count,
             (
               SELECT COALESCE(
                 jsonb_agg(
                   jsonb_build_object(
                     'status', receipt_bounded.status,
                     'observed_at', extract(epoch FROM receipt_bounded.observed_at)::bigint,
                     'recorded_at', extract(epoch FROM receipt_bounded.recorded_at)::bigint
                   ) ORDER BY receipt_bounded.observed_at, receipt_bounded.id
                 ),
                 '[]'::jsonb
               )
                 FROM (
                   SELECT receipt.id, receipt.status, receipt.observed_at, receipt.recorded_at
                     FROM notification_delivery_receipts receipt
                    WHERE receipt.org_id = delivery.org_id
                      AND receipt.store_id = delivery.store_id
                      AND receipt.delivery_id = delivery.id
                    ORDER BY receipt.observed_at, receipt.id
                    LIMIT 50
                 ) receipt_bounded
             ) AS receipts,
             (
               SELECT count(*) > 50
                 FROM notification_delivery_receipts receipt
                WHERE receipt.org_id = delivery.org_id
                  AND receipt.store_id = delivery.store_id
                  AND receipt.delivery_id = delivery.id
             ) AS receipts_truncated
        FROM notification_deliveries delivery
        JOIN notification_delivery_batches batch
          ON batch.org_id = delivery.org_id
         AND batch.store_id = delivery.store_id
         AND batch.id = delivery.batch_id
       WHERE delivery.org_id = authority.org_id
         AND delivery.order_id = ANY(group_order_ids)
       ORDER BY delivery.created_at, delivery.id
       LIMIT 1000
    ) bounded;

  RETURN jsonb_build_object(
    'notification_deliveries', delivery_rows,
    'notification_delivery_count', delivery_count,
    'notification_deliveries_truncated', delivery_count > 1000
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
  base_payload := customer_privacy_export_v2_base(
    requested_customer_id, requested_reason, event_id, requested_at
  );
  IF base_payload IS NULL THEN RETURN NULL; END IF;
  RETURN base_payload || customer_notification_privacy_export(requested_customer_id);
END;
$$;

REVOKE ALL ON FUNCTION public.customer_privacy_export_v2_base(uuid, text, uuid, timestamptz)
  FROM PUBLIC, laundry_app;
REVOKE ALL ON FUNCTION public.customer_notification_privacy_export(uuid)
  FROM PUBLIC, laundry_app;
REVOKE ALL ON FUNCTION public.customer_privacy_export(uuid, text, uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.customer_privacy_export(uuid, text, uuid, timestamptz)
  TO laundry_app;
