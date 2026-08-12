-- ADR-42 customer extended profiles, canonical merge groups, automatic discount
-- snapshots and irreversible privacy tombstones.
--
-- Compatibility: every existing-table change is additive and has an old-code
-- compatible default. The only deliberate old-writer restriction is the phone
-- erasure trigger: a pre-0051 binary must fail closed instead of recreating a
-- phone that has already been anonymized.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Customer/profile versions and bounded extension rows.
-- ---------------------------------------------------------------------------

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;

ALTER TABLE public.customers
  ADD CONSTRAINT customers_version_chk CHECK (version > 0);

CREATE TABLE IF NOT EXISTS public.customer_profiles (
  org_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  version integer NOT NULL,
  gender text NOT NULL,
  preferred_contact text NOT NULL,
  service_note text,
  skip_ticket_print boolean NOT NULL DEFAULT false,
  skip_label_print boolean NOT NULL DEFAULT false,
  skip_rack_assignment boolean NOT NULL DEFAULT false,
  discount_bps integer,
  origin_store_id uuid NOT NULL,
  updated_by_staff_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT customer_profiles_pkey PRIMARY KEY (org_id, customer_id),
  CONSTRAINT customer_profiles_customer_fk
    FOREIGN KEY (org_id, customer_id) REFERENCES public.customers (org_id, id),
  CONSTRAINT customer_profiles_store_fk
    FOREIGN KEY (org_id, origin_store_id) REFERENCES public.stores (org_id, id),
  CONSTRAINT customer_profiles_staff_fk
    FOREIGN KEY (org_id, updated_by_staff_id) REFERENCES public.staffs (org_id, id),
  CONSTRAINT customer_profiles_version_chk CHECK (version > 0),
  CONSTRAINT customer_profiles_gender_chk
    CHECK (gender IN ('unspecified', 'female', 'male', 'other')),
  CONSTRAINT customer_profiles_contact_chk
    CHECK (preferred_contact IN ('none', 'phone', 'sms', 'wechat')),
  CONSTRAINT customer_profiles_service_note_chk
    CHECK (service_note IS NULL OR char_length(service_note) <= 256),
  CONSTRAINT customer_profiles_discount_bps_chk
    CHECK (discount_bps IS NULL OR discount_bps BETWEEN 0 AND 10000)
);

CREATE TABLE IF NOT EXISTS public.customer_addresses (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  profile_version integer NOT NULL,
  label text,
  recipient text,
  contact_phone text,
  address_body text,
  is_default boolean NOT NULL DEFAULT false,
  retired_at timestamptz,
  pii_purged_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT customer_addresses_tenant_id_uidx UNIQUE (org_id, id),
  CONSTRAINT customer_addresses_customer_fk
    FOREIGN KEY (org_id, customer_id) REFERENCES public.customers (org_id, id),
  CONSTRAINT customer_addresses_version_chk CHECK (profile_version > 0),
  CONSTRAINT customer_addresses_label_chk
    CHECK (label IS NULL OR char_length(btrim(label)) BETWEEN 1 AND 32),
  CONSTRAINT customer_addresses_recipient_chk
    CHECK (recipient IS NULL OR char_length(btrim(recipient)) BETWEEN 1 AND 64),
  CONSTRAINT customer_addresses_phone_chk
    CHECK (contact_phone IS NULL OR char_length(contact_phone) BETWEEN 1 AND 32),
  CONSTRAINT customer_addresses_body_chk
    CHECK (address_body IS NULL OR char_length(btrim(address_body)) BETWEEN 1 AND 256),
  CONSTRAINT customer_addresses_pii_lifecycle_chk CHECK (
    (
      retired_at IS NULL
      AND pii_purged_at IS NULL
      AND label IS NOT NULL
      AND address_body IS NOT NULL
    )
    OR
    (
      retired_at IS NOT NULL
      AND pii_purged_at IS NOT NULL
      AND label IS NULL
      AND recipient IS NULL
      AND contact_phone IS NULL
      AND address_body IS NULL
    )
  )
);

-- Replay-safe hardening for databases that applied an earlier 0051 draft:
-- free-form labels are PII and cannot survive retirement.
ALTER TABLE public.customer_addresses
  ALTER COLUMN label DROP NOT NULL;

UPDATE public.customer_addresses
   SET label = NULL
 WHERE retired_at IS NOT NULL
   AND label IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'public.customer_addresses'::regclass
       AND conname = 'customer_addresses_retired_label_purged_chk'
  ) THEN
    ALTER TABLE public.customer_addresses
      ADD CONSTRAINT customer_addresses_retired_label_purged_chk CHECK (
        (retired_at IS NULL AND label IS NOT NULL)
        OR (retired_at IS NOT NULL AND label IS NULL)
      );
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS customer_addresses_active_default_uidx
  ON public.customer_addresses (org_id, customer_id)
  WHERE retired_at IS NULL AND is_default;

CREATE INDEX IF NOT EXISTS customer_addresses_customer_version_idx
  ON public.customer_addresses (org_id, customer_id, profile_version DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS public.customer_identifiers (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  profile_version integer NOT NULL,
  kind text NOT NULL,
  raw_value text,
  normalized_value text,
  retired_at timestamptz,
  pii_purged_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT customer_identifiers_tenant_id_uidx UNIQUE (org_id, id),
  CONSTRAINT customer_identifiers_customer_fk
    FOREIGN KEY (org_id, customer_id) REFERENCES public.customers (org_id, id),
  CONSTRAINT customer_identifiers_version_chk CHECK (profile_version > 0),
  CONSTRAINT customer_identifiers_kind_chk
    CHECK (kind IN ('vehicle_plate', 'tag', 'external_ref')),
  CONSTRAINT customer_identifiers_raw_chk
    CHECK (raw_value IS NULL OR char_length(btrim(raw_value)) BETWEEN 1 AND 64),
  CONSTRAINT customer_identifiers_normalized_chk
    CHECK (normalized_value IS NULL OR char_length(normalized_value) BETWEEN 1 AND 128),
  CONSTRAINT customer_identifiers_pii_lifecycle_chk CHECK (
    (
      retired_at IS NULL
      AND pii_purged_at IS NULL
      AND raw_value IS NOT NULL
      AND normalized_value IS NOT NULL
    )
    OR
    (
      retired_at IS NOT NULL
      AND pii_purged_at IS NOT NULL
      AND raw_value IS NULL
      AND normalized_value IS NULL
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS customer_identifiers_active_value_uidx
  ON public.customer_identifiers (org_id, kind, normalized_value)
  WHERE retired_at IS NULL AND normalized_value IS NOT NULL;

CREATE INDEX IF NOT EXISTS customer_identifiers_customer_version_idx
  ON public.customer_identifiers (org_id, customer_id, profile_version DESC, created_at DESC);

-- ---------------------------------------------------------------------------
-- Owner-only per-org HMAC keys and non-enumerable erasure tombstones.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.customer_privacy_hmac_keys (
  org_id uuid PRIMARY KEY,
  hmac_key bytea NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT customer_privacy_hmac_keys_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs (id),
  CONSTRAINT customer_privacy_hmac_keys_length_chk CHECK (octet_length(hmac_key) = 32)
);

CREATE TABLE IF NOT EXISTS public.customer_erasure_tombstones (
  org_id uuid NOT NULL,
  phone_hmac char(64) NOT NULL,
  customer_id uuid NOT NULL,
  erased_at timestamptz NOT NULL,
  erased_by_staff_id uuid NOT NULL,
  CONSTRAINT customer_erasure_tombstones_pkey PRIMARY KEY (org_id, phone_hmac),
  CONSTRAINT customer_erasure_tombstones_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs (id),
  CONSTRAINT customer_erasure_tombstones_customer_fk
    FOREIGN KEY (org_id, customer_id) REFERENCES public.customers (org_id, id),
  CONSTRAINT customer_erasure_tombstones_staff_fk
    FOREIGN KEY (org_id, erased_by_staff_id) REFERENCES public.staffs (org_id, id),
  CONSTRAINT customer_erasure_tombstones_hash_chk
    CHECK (phone_hmac ~ '^[0-9a-f]{64}$')
);

CREATE TABLE IF NOT EXISTS public.customer_phone_history (
  org_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  phone_hmac char(64) NOT NULL,
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  CONSTRAINT customer_phone_history_pkey PRIMARY KEY (org_id, customer_id, phone_hmac),
  CONSTRAINT customer_phone_history_customer_fk
    FOREIGN KEY (org_id, customer_id) REFERENCES public.customers (org_id, id)
    ON DELETE CASCADE,
  CONSTRAINT customer_phone_history_hash_chk CHECK (phone_hmac ~ '^[0-9a-f]{64}$'),
  CONSTRAINT customer_phone_history_time_chk CHECK (last_seen_at >= first_seen_at)
);

ALTER TABLE public.customer_privacy_hmac_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_privacy_hmac_keys FORCE ROW LEVEL SECURITY;
ALTER TABLE public.customer_erasure_tombstones ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_erasure_tombstones FORCE ROW LEVEL SECURITY;
ALTER TABLE public.customer_phone_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_phone_history FORCE ROW LEVEL SECURITY;

CREATE POLICY customer_privacy_hmac_keys_maintenance
  ON public.customer_privacy_hmac_keys
  AS PERMISSIVE FOR ALL TO laundry_owner USING (true) WITH CHECK (true);

CREATE POLICY customer_erasure_tombstones_maintenance
  ON public.customer_erasure_tombstones
  AS PERMISSIVE FOR ALL TO laundry_owner USING (true) WITH CHECK (true);

CREATE POLICY customer_phone_history_maintenance
  ON public.customer_phone_history
  AS PERMISSIVE FOR ALL TO laundry_owner USING (true) WITH CHECK (true);

REVOKE ALL ON TABLE public.customer_privacy_hmac_keys FROM PUBLIC, laundry_app;
REVOKE ALL ON TABLE public.customer_erasure_tombstones FROM PUBLIC, laundry_app;
REVOKE ALL ON TABLE public.customer_phone_history FROM PUBLIC, laundry_app;

INSERT INTO public.customer_privacy_hmac_keys (org_id, hmac_key, created_at)
SELECT org_row.id, gen_random_bytes(32), now()
  FROM public.orgs org_row
ON CONFLICT (org_id) DO NOTHING;

-- Privacy audit reasons are immutable but must not become another PII store.
-- Normalize legacy free text once, then allow controlled non-PII codes only.
UPDATE public.customer_privacy_events
   SET reason = 'legacy_request'
 WHERE reason NOT IN (
   'customer_request',
   'legal_request',
   'data_correction',
   'retention_expiry',
   'legacy_request'
 );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'public.customer_privacy_events'::regclass
       AND conname = 'customer_privacy_events_reason_code_chk'
  ) THEN
    ALTER TABLE public.customer_privacy_events
      ADD CONSTRAINT customer_privacy_events_reason_code_chk CHECK (
        reason IN (
          'customer_request',
          'legal_request',
          'data_correction',
          'retention_expiry',
          'legacy_request'
        )
      );
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.seed_customer_privacy_hmac_key()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  INSERT INTO customer_privacy_hmac_keys (org_id, hmac_key, created_at)
  VALUES (NEW.id, gen_random_bytes(32), COALESCE(NEW.created_at, now()))
  ON CONFLICT (org_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
     WHERE tgname = 'orgs_seed_customer_privacy_hmac_key_trg'
       AND tgrelid = 'public.orgs'::regclass
  ) THEN
    CREATE TRIGGER orgs_seed_customer_privacy_hmac_key_trg
      AFTER INSERT ON public.orgs
      FOR EACH ROW EXECUTE FUNCTION public.seed_customer_privacy_hmac_key();
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.customer_phone_hmac(
  requested_org_id uuid,
  requested_phone text
)
RETURNS text
LANGUAGE plpgsql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  resolved_key bytea;
BEGIN
  SELECT key_row.hmac_key
    INTO resolved_key
    FROM customer_privacy_hmac_keys key_row
   WHERE key_row.org_id = requested_org_id;
  IF resolved_key IS NULL THEN
    RAISE object_not_in_prerequisite_state
      USING MESSAGE = 'customer privacy key unavailable';
  END IF;
  RETURN encode(hmac(convert_to(requested_phone, 'UTF8'), resolved_key, 'sha256'), 'hex');
END;
$$;

CREATE OR REPLACE FUNCTION public.customer_phone_erased_for_org(
  requested_org_id uuid,
  requested_phone text
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- Serialize every phone writer with privacy erasure for this organization.
  -- A BEFORE trigger alone is insufficient when an INSERT waits on the old
  -- phone's unique row while anonymization commits its tombstone.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('customer-phone:' || requested_org_id::text, 0)
  );
  RETURN EXISTS (
    SELECT 1
      FROM customer_erasure_tombstones tombstone
     WHERE tombstone.org_id = requested_org_id
       AND tombstone.phone_hmac = customer_phone_hmac(requested_org_id, requested_phone)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.record_customer_phone_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  observed_at timestamptz := COALESCE(NEW.updated_at, NEW.created_at, now());
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.phone ~ '^1[3-9][0-9]{9}$' THEN
    INSERT INTO customer_phone_history (
      org_id, customer_id, phone_hmac, first_seen_at, last_seen_at
    ) VALUES (
      OLD.org_id, OLD.id, customer_phone_hmac(OLD.org_id, OLD.phone),
      COALESCE(OLD.created_at, observed_at),
      GREATEST(COALESCE(OLD.created_at, observed_at), observed_at)
    )
    ON CONFLICT (org_id, customer_id, phone_hmac) DO UPDATE
      SET last_seen_at = GREATEST(customer_phone_history.last_seen_at, EXCLUDED.last_seen_at);
  END IF;
  IF NEW.phone ~ '^1[3-9][0-9]{9}$' THEN
    INSERT INTO customer_phone_history (
      org_id, customer_id, phone_hmac, first_seen_at, last_seen_at
    ) VALUES (
      NEW.org_id, NEW.id, customer_phone_hmac(NEW.org_id, NEW.phone),
      CASE WHEN TG_OP = 'INSERT' THEN COALESCE(NEW.created_at, observed_at) ELSE observed_at END,
      GREATEST(
        CASE WHEN TG_OP = 'INSERT' THEN COALESCE(NEW.created_at, observed_at) ELSE observed_at END,
        observed_at
      )
    )
    ON CONFLICT (org_id, customer_id, phone_hmac) DO UPDATE
      SET last_seen_at = GREATEST(customer_phone_history.last_seen_at, EXCLUDED.last_seen_at);
  END IF;
  RETURN NEW;
END;
$$;

INSERT INTO public.customer_phone_history (
  org_id, customer_id, phone_hmac, first_seen_at, last_seen_at
)
SELECT customer_row.org_id, customer_row.id,
       customer_phone_hmac(customer_row.org_id, customer_row.phone),
       customer_row.created_at, GREATEST(customer_row.created_at, customer_row.updated_at)
  FROM public.customers customer_row
 WHERE customer_row.phone ~ '^1[3-9][0-9]{9}$'
ON CONFLICT (org_id, customer_id, phone_hmac) DO UPDATE
  SET last_seen_at = GREATEST(customer_phone_history.last_seen_at, EXCLUDED.last_seen_at);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
     WHERE tgname = 'customers_record_phone_history_trg'
       AND tgrelid = 'public.customers'::regclass
  ) THEN
    CREATE TRIGGER customers_record_phone_history_trg
      AFTER INSERT OR UPDATE OF phone ON public.customers
      FOR EACH ROW EXECUTE FUNCTION public.record_customer_phone_history();
  END IF;
END;
$$;

-- Pre-0051 anonymizations cannot recover a phone that 0028 already replaced
-- with anon-*. Retire every still-live authority that could carry such a
-- historical phone so old encrypted queues fail closed and must be securely
-- discarded/recommissioned before they can replay.
UPDATE public.primary_lease_heads head
   SET current_lease_id = NULL,
       current_device_id = NULL,
       current_not_after = NULL,
       updated_at = now()
  FROM public.primary_leases lease_row
  JOIN public.offline_grants grant_row
    ON grant_row.org_id = lease_row.org_id
   AND grant_row.store_id = lease_row.store_id
   AND grant_row.id = lease_row.grant_id
 WHERE head.org_id = lease_row.org_id
   AND head.store_id = lease_row.store_id
   AND head.current_lease_id = lease_row.id
   AND grant_row.revoked_at IS NULL
   AND grant_row.allowed_commands ?| ARRAY['customer.upsert', 'order.receive', 'order.hold'];

UPDATE public.primary_leases lease_row
   SET released_at = COALESCE(lease_row.released_at, now())
  FROM public.offline_grants grant_row
 WHERE grant_row.org_id = lease_row.org_id
   AND grant_row.store_id = lease_row.store_id
   AND grant_row.id = lease_row.grant_id
   AND grant_row.revoked_at IS NULL
   AND grant_row.allowed_commands ?| ARRAY['customer.upsert', 'order.receive', 'order.hold'];

WITH revoked AS (
  UPDATE public.offline_grants grant_row
     SET revoked_at = now()
   WHERE grant_row.revoked_at IS NULL
     AND grant_row.allowed_commands ?| ARRAY['customer.upsert', 'order.receive', 'order.hold']
  RETURNING grant_row.org_id, grant_row.store_id
), counts AS (
  SELECT org_id, store_id, count(*)::integer AS revoked_count
    FROM revoked
   GROUP BY org_id, store_id
)
INSERT INTO public.audit_log (
  id, org_id, store_id, staff_id, via, command, dry_run,
  entity, entity_id, after_json, at
)
SELECT gen_random_uuid(), counts.org_id, counts.store_id, NULL, 'automation',
       'migration.0051.offline_pii_epoch', false, 'migration', '0051',
       jsonb_build_object('revoked_grant_count', counts.revoked_count)::text, now()
  FROM counts;

CREATE OR REPLACE FUNCTION public.customer_phone_erased(requested_phone text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  requested_org uuid := NULLIF(current_setting('app.org_id', true), '')::uuid;
BEGIN
  IF requested_org IS NULL THEN
    RAISE insufficient_privilege USING MESSAGE = 'customer tenant unavailable';
  END IF;
  RETURN customer_phone_erased_for_org(requested_org, requested_phone);
END;
$$;

CREATE OR REPLACE FUNCTION public.reject_erased_customer_phone()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  requested_org uuid := NULLIF(current_setting('app.org_id', true), '')::uuid;
  erased boolean;
BEGIN
  IF requested_org IS NULL THEN
    IF session_user = 'laundry_app' THEN
      RAISE insufficient_privilege USING MESSAGE = 'customer tenant unavailable';
    END IF;
  ELSIF requested_org <> NEW.org_id THEN
    RAISE insufficient_privilege USING MESSAGE = 'customer tenant unavailable';
  END IF;

  IF NEW.phone ~ '^1[3-9][0-9]{9}$' THEN
    erased := CASE
      WHEN requested_org IS NULL
        THEN customer_phone_erased_for_org(NEW.org_id, NEW.phone)
      ELSE customer_phone_erased(NEW.phone)
    END;
    IF erased THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'CUSTOMER_ERASED';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
     WHERE tgname = 'customers_reject_erased_phone_trg'
       AND tgrelid = 'public.customers'::regclass
  ) THEN
    CREATE TRIGGER customers_reject_erased_phone_trg
      BEFORE INSERT OR UPDATE OF phone ON public.customers
      FOR EACH ROW EXECUTE FUNCTION public.reject_erased_customer_phone();
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.seed_customer_privacy_hmac_key() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.customer_phone_hmac(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.customer_phone_erased_for_org(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_customer_phone_history() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.customer_phone_erased(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reject_erased_customer_phone() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.customer_phone_erased(text) TO laundry_app;

-- ---------------------------------------------------------------------------
-- Recursive canonical customer group with explicit cycle/depth/size guards.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.customer_canonical_root(requested_customer_id uuid)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  requested_org uuid := NULLIF(current_setting('app.org_id', true), '')::uuid;
  current_id uuid := requested_customer_id;
  next_id uuid;
  visited uuid[] := ARRAY[]::uuid[];
  hop integer;
BEGIN
  IF requested_org IS NULL THEN
    RAISE insufficient_privilege USING MESSAGE = 'customer tenant unavailable';
  END IF;
  FOR hop IN 0..64 LOOP
    IF current_id = ANY(visited) THEN
      RAISE integrity_constraint_violation USING MESSAGE = 'customer merge cycle detected';
    END IF;
    visited := array_append(visited, current_id);
    SELECT customer_row.merged_into_id
      INTO next_id
      FROM customers customer_row
     WHERE customer_row.org_id = requested_org
       AND customer_row.id = current_id;
    IF NOT FOUND THEN RETURN NULL; END IF;
    IF next_id IS NULL THEN RETURN current_id; END IF;
    current_id := next_id;
  END LOOP;
  RAISE program_limit_exceeded USING MESSAGE = 'customer merge depth exceeded';
END;
$$;

CREATE OR REPLACE FUNCTION public.customer_canonical_group(requested_customer_id uuid)
RETURNS TABLE (group_customer_id uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  requested_org uuid := NULLIF(current_setting('app.org_id', true), '')::uuid;
  root_id uuid;
  group_ids uuid[];
  group_size integer;
  deepest integer;
BEGIN
  root_id := customer_canonical_root(requested_customer_id);
  IF root_id IS NULL THEN RETURN; END IF;

  WITH RECURSIVE group_walk(customer_id, depth, path) AS (
    SELECT root_id, 0, ARRAY[root_id]::uuid[]
    UNION ALL
    SELECT child.id, parent.depth + 1, array_append(parent.path, child.id)
      FROM group_walk parent
      JOIN customers child
        ON child.org_id = requested_org
       AND child.merged_into_id = parent.customer_id
     WHERE parent.depth < 64
       AND NOT child.id = ANY(parent.path)
  )
  SELECT array_agg(walk.customer_id ORDER BY walk.depth, walk.customer_id),
         count(*)::integer,
         max(walk.depth)
    INTO group_ids, group_size, deepest
    FROM group_walk walk;

  IF group_size > 1000 THEN
    RAISE program_limit_exceeded USING MESSAGE = 'customer merge group size exceeded';
  END IF;
  IF deepest = 64 AND EXISTS (
    SELECT 1
      FROM customers child
     WHERE child.org_id = requested_org
       AND child.merged_into_id = ANY(group_ids)
       AND NOT child.id = ANY(group_ids)
  ) THEN
    RAISE program_limit_exceeded USING MESSAGE = 'customer merge depth exceeded';
  END IF;

  RETURN QUERY SELECT unnest(group_ids);
END;
$$;

REVOKE ALL ON FUNCTION public.customer_canonical_root(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.customer_canonical_group(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.customer_canonical_root(uuid) TO laundry_app;
GRANT EXECUTE ON FUNCTION public.customer_canonical_group(uuid) TO laundry_app;

-- Merge needs an org-wide write despite store-scoped order RLS. Keep that
-- bypass inside one narrowly granted function that derives every authority
-- value from the current transaction GUCs and serializes group rewrites.
CREATE OR REPLACE FUNCTION public.customer_merge_canonical(
  requested_source_customer_id uuid,
  requested_target_customer_id uuid,
  requested_at timestamptz
)
RETURNS TABLE (
  source_customer_id uuid,
  target_customer_id uuid,
  relinked_order_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  requested_org uuid := NULLIF(current_setting('app.org_id', true), '')::uuid;
  requested_store uuid := NULLIF(current_setting('app.store_id', true), '')::uuid;
  requested_staff uuid := NULLIF(current_setting('app.staff_id', true), '')::uuid;
  source_root uuid;
  target_root uuid;
  source_group_ids uuid[];
  target_group_ids uuid[];
  combined_group_ids uuid[];
  combined_group_count integer;
  source_account_count integer;
  target_account_count integer;
  source_account_id uuid;
  target_phone text;
  target_name text;
  changed_orders integer;
BEGIN
  IF requested_org IS NULL OR requested_store IS NULL OR requested_staff IS NULL THEN
    RAISE insufficient_privilege USING MESSAGE = 'customer merge authority unavailable';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM staff_store_roles role_row
      JOIN staffs staff_row
        ON staff_row.org_id = role_row.org_id
       AND staff_row.id = role_row.staff_id
     WHERE role_row.org_id = requested_org
       AND role_row.store_id = requested_store
       AND role_row.staff_id = requested_staff
       AND role_row.is_active
       AND staff_row.is_active
  ) THEN
    RAISE insufficient_privilege USING MESSAGE = 'customer merge authority unavailable';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(requested_org::text, 42));
  source_root := customer_canonical_root(requested_source_customer_id);
  target_root := customer_canonical_root(requested_target_customer_id);
  IF source_root IS NULL OR target_root IS NULL OR source_root = target_root THEN RETURN; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM customers customer_row
     WHERE customer_row.org_id = requested_org
       AND customer_row.id = source_root
       AND customer_row.merged_into_id IS NULL
       AND customer_row.anonymized_at IS NULL
  ) OR NOT EXISTS (
    SELECT 1 FROM customers customer_row
     WHERE customer_row.org_id = requested_org
       AND customer_row.id = target_root
       AND customer_row.merged_into_id IS NULL
       AND customer_row.anonymized_at IS NULL
  ) THEN
    RETURN;
  END IF;

  SELECT array_agg(group_row.group_customer_id)
    INTO source_group_ids
    FROM customer_canonical_group(source_root) group_row;
  SELECT array_agg(group_row.group_customer_id)
    INTO target_group_ids
    FROM customer_canonical_group(target_root) group_row;
  SELECT array_agg(combined.group_id ORDER BY combined.group_id), count(*)::integer
    INTO combined_group_ids, combined_group_count
    FROM (
      SELECT DISTINCT unnest(source_group_ids || target_group_ids) AS group_id
    ) combined;
  IF combined_group_count > 1000 THEN RETURN; END IF;

  PERFORM customer_row.id
    FROM customers customer_row
   WHERE customer_row.org_id = requested_org
     AND customer_row.id = ANY(combined_group_ids)
   ORDER BY customer_row.id
   FOR UPDATE;
  PERFORM account_row.id
   FROM member_accounts account_row
   WHERE account_row.org_id = requested_org
     AND account_row.customer_id = ANY(combined_group_ids)
   ORDER BY account_row.customer_id, account_row.id
   FOR UPDATE;

  SELECT count(*)::integer, (array_agg(account_row.id ORDER BY account_row.id))[1]
    INTO source_account_count, source_account_id
    FROM member_accounts account_row
   WHERE account_row.org_id = requested_org
     AND account_row.customer_id = ANY(source_group_ids);
  SELECT count(*)::integer
    INTO target_account_count
    FROM member_accounts account_row
   WHERE account_row.org_id = requested_org
     AND account_row.customer_id = ANY(target_group_ids);
  IF source_account_count > 1 OR target_account_count > 1
     OR (source_account_count = 1 AND target_account_count = 1) THEN
    RETURN;
  END IF;

  IF source_account_id IS NOT NULL THEN
    UPDATE member_accounts
       SET customer_id = target_root
     WHERE org_id = requested_org
       AND id = source_account_id
       AND customer_id = ANY(source_group_ids);
  END IF;

  SELECT customer_row.phone, customer_row.name
    INTO target_phone, target_name
    FROM customers customer_row
   WHERE customer_row.org_id = requested_org
     AND customer_row.id = target_root;

  UPDATE orders order_row
     SET customer_id = target_root,
         customer_phone = target_phone,
         customer_name = COALESCE(target_name, order_row.customer_name),
         updated_at = requested_at
   WHERE order_row.org_id = requested_org
     AND order_row.customer_id = ANY(combined_group_ids)
     AND order_row.customer_id <> target_root;
  GET DIAGNOSTICS changed_orders = ROW_COUNT;

  UPDATE customers customer_row
     SET merged_into_id = CASE
           WHEN customer_row.id = target_root THEN NULL
           ELSE target_root
         END,
         merged_at = CASE
           WHEN customer_row.id = target_root THEN NULL
           ELSE COALESCE(customer_row.merged_at, requested_at)
         END,
         version = customer_row.version + 1,
         updated_at = requested_at
   WHERE customer_row.org_id = requested_org
     AND customer_row.id = ANY(combined_group_ids);

  RETURN QUERY SELECT source_root, target_root, changed_orders;
END;
$$;

REVOKE ALL ON FUNCTION public.customer_merge_canonical(uuid, uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.customer_merge_canonical(uuid, uuid, timestamptz) TO laundry_app;

-- ---------------------------------------------------------------------------
-- Tier/customer pricing snapshots and privacy-subject ownership metadata.
-- ---------------------------------------------------------------------------

ALTER TABLE public.member_tiers
  ADD COLUMN IF NOT EXISTS discount_bps integer NOT NULL DEFAULT 0;

ALTER TABLE public.member_tiers
  ADD CONSTRAINT member_tiers_discount_bps_chk CHECK (discount_bps BETWEEN 0 AND 10000);

ALTER TABLE public.member_memberships
  ADD COLUMN IF NOT EXISTS tier_definition_version integer,
  ADD COLUMN IF NOT EXISTS tier_discount_bps integer;

UPDATE public.member_memberships membership
   SET tier_definition_version = tier.version,
       tier_discount_bps = tier.discount_bps
  FROM public.member_tiers tier
 WHERE membership.org_id = tier.org_id
   AND membership.tier_id = tier.id
   AND membership.tier_id IS NOT NULL
   AND (membership.tier_definition_version IS NULL OR membership.tier_discount_bps IS NULL);

ALTER TABLE public.member_memberships
  ADD CONSTRAINT member_memberships_tier_policy_shape_chk CHECK (
    (
      tier_id IS NULL
      AND tier_definition_version IS NULL
      AND tier_discount_bps IS NULL
    )
    OR
    (
      tier_id IS NOT NULL
      AND tier_definition_version IS NOT NULL
      AND tier_definition_version > 0
      AND tier_discount_bps BETWEEN 0 AND 10000
    )
  );

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS customer_profile_version integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS discount_source text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS discount_bps integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS membership_version integer,
  ADD COLUMN IF NOT EXISTS tier_id uuid,
  ADD COLUMN IF NOT EXISTS tier_definition_version integer,
  ADD COLUMN IF NOT EXISTS tier_code text,
  ADD COLUMN IF NOT EXISTS tier_name text,
  ADD COLUMN IF NOT EXISTS tier_level integer,
  ADD COLUMN IF NOT EXISTS tier_discount_bps integer,
  ADD COLUMN IF NOT EXISTS skip_ticket_print boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS skip_label_print boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS skip_rack_assignment boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS customer_pii_purged_at timestamptz;

ALTER TABLE public.member_accounts
  ADD COLUMN IF NOT EXISTS customer_pii_purged_at timestamptz;

ALTER TABLE public.garments
  ADD COLUMN IF NOT EXISTS customer_pii_purged_at timestamptz;

-- Propagate legacy single-row erasures through every merged source before its
-- raw phone is removed. This also creates replay tombstones for those sources.
WITH RECURSIVE erased_group(
  org_id, customer_id, anonymized_at, anonymized_by_staff_id
) AS (
  SELECT customer_row.org_id, customer_row.id, customer_row.anonymized_at,
         customer_row.anonymized_by_staff_id
    FROM public.customers customer_row
   WHERE customer_row.anonymized_at IS NOT NULL
  UNION
  SELECT child.org_id, child.id, erased_group.anonymized_at,
         erased_group.anonymized_by_staff_id
    FROM public.customers child
    JOIN erased_group
      ON erased_group.org_id = child.org_id
     AND child.merged_into_id = erased_group.customer_id
), erased_anchor AS (
  SELECT org_id, customer_id, min(anonymized_at) AS anonymized_at,
         min(anonymized_by_staff_id::text)::uuid AS anonymized_by_staff_id
    FROM erased_group
   GROUP BY org_id, customer_id
)
INSERT INTO public.customer_erasure_tombstones (
  org_id, phone_hmac, customer_id, erased_at, erased_by_staff_id
)
SELECT customer_row.org_id,
       customer_phone_hmac(customer_row.org_id, customer_row.phone),
       customer_row.id,
       erased_anchor.anonymized_at,
       erased_anchor.anonymized_by_staff_id
  FROM public.customers customer_row
  JOIN erased_anchor
    ON erased_anchor.org_id = customer_row.org_id
   AND erased_anchor.customer_id = customer_row.id
 WHERE customer_row.phone ~ '^1[3-9][0-9]{9}$'
ON CONFLICT (org_id, phone_hmac) DO NOTHING;

WITH RECURSIVE erased_group(
  org_id, customer_id, anonymized_at, anonymized_by_staff_id
) AS (
  SELECT customer_row.org_id, customer_row.id, customer_row.anonymized_at,
         customer_row.anonymized_by_staff_id
    FROM public.customers customer_row
   WHERE customer_row.anonymized_at IS NOT NULL
  UNION
  SELECT child.org_id, child.id, erased_group.anonymized_at,
         erased_group.anonymized_by_staff_id
    FROM public.customers child
    JOIN erased_group
      ON erased_group.org_id = child.org_id
     AND child.merged_into_id = erased_group.customer_id
), erased_anchor AS (
  SELECT org_id, customer_id, min(anonymized_at) AS anonymized_at,
         min(anonymized_by_staff_id::text)::uuid AS anonymized_by_staff_id
    FROM erased_group
   GROUP BY org_id, customer_id
)
UPDATE public.customers customer_row
   SET phone = 'anon-' || replace(customer_row.id::text, '-', ''),
       name = NULL,
       note = NULL,
       anonymized_at = erased_anchor.anonymized_at,
       anonymized_by_staff_id = erased_anchor.anonymized_by_staff_id,
       updated_at = GREATEST(customer_row.updated_at, erased_anchor.anonymized_at),
       version = customer_row.version + 1
  FROM erased_anchor
 WHERE customer_row.org_id = erased_anchor.org_id
   AND customer_row.id = erased_anchor.customer_id
   AND (
     customer_row.anonymized_at IS NULL
     OR customer_row.phone <> 'anon-' || replace(customer_row.id::text, '-', '')
     OR customer_row.name IS NOT NULL
     OR customer_row.note IS NOT NULL
   );

WITH RECURSIVE erased_group(org_id, customer_id, anonymized_at) AS (
  SELECT customer_row.org_id, customer_row.id, customer_row.anonymized_at
    FROM public.customers customer_row
   WHERE customer_row.anonymized_at IS NOT NULL
  UNION
  SELECT child.org_id, child.id, erased_group.anonymized_at
    FROM public.customers child
    JOIN erased_group
      ON erased_group.org_id = child.org_id
     AND child.merged_into_id = erased_group.customer_id
), erased_anchor AS (
  SELECT org_id, customer_id, min(anonymized_at) AS anonymized_at
    FROM erased_group
   GROUP BY org_id, customer_id
)
UPDATE public.orders order_row
   SET customer_pii_purged_at = erased_anchor.anonymized_at
  FROM erased_anchor
 WHERE order_row.org_id = erased_anchor.org_id
   AND order_row.customer_id = erased_anchor.customer_id
   AND order_row.customer_pii_purged_at IS NULL;

WITH RECURSIVE erased_group(org_id, customer_id, anonymized_at) AS (
  SELECT customer_row.org_id, customer_row.id, customer_row.anonymized_at
    FROM public.customers customer_row
   WHERE customer_row.anonymized_at IS NOT NULL
  UNION
  SELECT child.org_id, child.id, erased_group.anonymized_at
    FROM public.customers child
    JOIN erased_group
      ON erased_group.org_id = child.org_id
     AND child.merged_into_id = erased_group.customer_id
), erased_anchor AS (
  SELECT org_id, customer_id, min(anonymized_at) AS anonymized_at
    FROM erased_group
   GROUP BY org_id, customer_id
)
UPDATE public.member_accounts account_row
   SET customer_pii_purged_at = erased_anchor.anonymized_at
  FROM erased_anchor
 WHERE account_row.org_id = erased_anchor.org_id
   AND account_row.customer_id = erased_anchor.customer_id
   AND account_row.customer_pii_purged_at IS NULL;

UPDATE public.garments garment_row
   SET customer_pii_purged_at = order_row.customer_pii_purged_at
  FROM public.orders order_row
 WHERE garment_row.org_id = order_row.org_id
   AND garment_row.store_id = order_row.store_id
   AND garment_row.order_id = order_row.id
   AND order_row.customer_pii_purged_at IS NOT NULL
   AND garment_row.customer_pii_purged_at IS NULL;

UPDATE public.orders
   SET discount_source = 'manual'
 WHERE discount_cents > 0 AND discount_source = 'none';

ALTER TABLE public.orders
  ADD CONSTRAINT orders_customer_profile_version_chk CHECK (customer_profile_version >= 0),
  ADD CONSTRAINT orders_discount_source_chk
    CHECK (discount_source IN ('none', 'manual', 'customer', 'tier')),
  ADD CONSTRAINT orders_discount_bps_chk CHECK (discount_bps BETWEEN 0 AND 10000),
  ADD CONSTRAINT orders_discount_policy_shape_chk CHECK (
    (discount_source IN ('none', 'manual') AND discount_bps = 0)
    OR discount_source IN ('customer', 'tier')
  ),
  ADD CONSTRAINT orders_membership_version_chk
    CHECK (membership_version IS NULL OR membership_version > 0),
  ADD CONSTRAINT orders_tier_snapshot_shape_chk CHECK (
    (
      tier_id IS NULL
      AND tier_definition_version IS NULL
      AND tier_code IS NULL
      AND tier_name IS NULL
      AND tier_level IS NULL
      AND tier_discount_bps IS NULL
    )
    OR
    (
      tier_id IS NOT NULL
      AND tier_definition_version IS NOT NULL
      AND tier_definition_version > 0
      AND tier_code IS NOT NULL
      AND tier_name IS NOT NULL
      AND tier_level BETWEEN 1 AND 99
      AND tier_discount_bps BETWEEN 0 AND 10000
    )
  );

ALTER TABLE public.orders
  ADD CONSTRAINT orders_tier_snapshot_fk
  FOREIGN KEY (org_id, tier_id) REFERENCES public.member_tiers (org_id, id)
  NOT VALID;

ALTER TABLE public.command_idempotency
  ADD COLUMN IF NOT EXISTS privacy_subject_customer_id uuid,
  ADD COLUMN IF NOT EXISTS pii_purged_at timestamptz;

ALTER TABLE public.edge_replay_records
  ADD COLUMN IF NOT EXISTS privacy_subject_customer_id uuid,
  ADD COLUMN IF NOT EXISTS pii_purged_at timestamptz;

ALTER TABLE public.ai_pending_actions
  ADD COLUMN IF NOT EXISTS privacy_subject_customer_id uuid,
  ADD COLUMN IF NOT EXISTS pii_purged_at timestamptz;

ALTER TABLE public.command_idempotency
  ADD CONSTRAINT command_idempotency_privacy_subject_fk
  FOREIGN KEY (org_id, privacy_subject_customer_id) REFERENCES public.customers (org_id, id)
  NOT VALID;

ALTER TABLE public.edge_replay_records
  ADD CONSTRAINT edge_replay_records_privacy_subject_fk
  FOREIGN KEY (org_id, privacy_subject_customer_id) REFERENCES public.customers (org_id, id)
  NOT VALID;

ALTER TABLE public.ai_pending_actions
  ADD CONSTRAINT ai_pending_actions_privacy_subject_fk
  FOREIGN KEY (org_id, privacy_subject_customer_id) REFERENCES public.customers (org_id, id)
  NOT VALID;

CREATE INDEX IF NOT EXISTS command_idempotency_privacy_subject_idx
  ON public.command_idempotency (org_id, privacy_subject_customer_id)
  WHERE privacy_subject_customer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS edge_replay_records_privacy_subject_idx
  ON public.edge_replay_records (org_id, privacy_subject_customer_id)
  WHERE privacy_subject_customer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ai_pending_actions_privacy_subject_idx
  ON public.ai_pending_actions (org_id, privacy_subject_customer_id)
  WHERE privacy_subject_customer_id IS NOT NULL;

UPDATE public.command_idempotency row_to_backfill
   SET privacy_subject_customer_id = CASE
     WHEN COALESCE(
       row_to_backfill.result_json #>> '{data,result,customer_id}',
       row_to_backfill.result_json #>> '{data,result,customer,customer_id}',
       row_to_backfill.result_json #>> '{data,result,benefits,customer_id}'
     ) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     THEN COALESCE(
       row_to_backfill.result_json #>> '{data,result,customer_id}',
       row_to_backfill.result_json #>> '{data,result,customer,customer_id}',
       row_to_backfill.result_json #>> '{data,result,benefits,customer_id}'
     )::uuid
     ELSE NULL
   END
 WHERE row_to_backfill.privacy_subject_customer_id IS NULL
   AND COALESCE(
     row_to_backfill.result_json #>> '{data,result,customer_id}',
     row_to_backfill.result_json #>> '{data,result,customer,customer_id}',
     row_to_backfill.result_json #>> '{data,result,benefits,customer_id}'
   ) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
   AND EXISTS (
     SELECT 1 FROM public.customers customer_row
      WHERE customer_row.org_id = row_to_backfill.org_id
        AND customer_row.id = CASE
          WHEN COALESCE(
            row_to_backfill.result_json #>> '{data,result,customer_id}',
            row_to_backfill.result_json #>> '{data,result,customer,customer_id}',
            row_to_backfill.result_json #>> '{data,result,benefits,customer_id}'
          ) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          THEN COALESCE(
            row_to_backfill.result_json #>> '{data,result,customer_id}',
            row_to_backfill.result_json #>> '{data,result,customer,customer_id}',
            row_to_backfill.result_json #>> '{data,result,benefits,customer_id}'
          )::uuid
          ELSE NULL
        END
   );

UPDATE public.edge_replay_records replay
   SET privacy_subject_customer_id = idempotency.privacy_subject_customer_id
  FROM public.command_idempotency idempotency
 WHERE replay.privacy_subject_customer_id IS NULL
   AND idempotency.org_id = replay.org_id
   AND idempotency.store_id = replay.store_id
   AND idempotency.command = replay.command
   AND idempotency.idempotency_key = replay.idempotency_key
   AND idempotency.privacy_subject_customer_id IS NOT NULL;

UPDATE public.ai_pending_actions pending
   SET privacy_subject_customer_id = (pending.args_json ->> 'customer_id')::uuid
 WHERE pending.privacy_subject_customer_id IS NULL
   AND pending.args_json ->> 'customer_id'
       ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
   AND EXISTS (
     SELECT 1 FROM public.customers customer_row
      WHERE customer_row.org_id = pending.org_id
        AND customer_row.id = (pending.args_json ->> 'customer_id')::uuid
   );

-- ---------------------------------------------------------------------------
-- RLS/grants for the three application-visible profile tables.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'customer_profiles',
    'customer_addresses',
    'customer_identifiers'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS PERMISSIVE FOR ALL TO laundry_app '
      || 'USING (org_id = NULLIF(current_setting(''app.org_id'', true), '''')::uuid) '
      || 'WITH CHECK (org_id = NULLIF(current_setting(''app.org_id'', true), '''')::uuid)',
      table_name || '_org_scope',
      table_name
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS PERMISSIVE FOR ALL TO laundry_owner '
      || 'USING (true) WITH CHECK (true)',
      table_name || '_maintenance',
      table_name
    );
  END LOOP;
END;
$$;

GRANT SELECT, INSERT, UPDATE ON TABLE public.customer_profiles TO laundry_app;
GRANT SELECT, INSERT, UPDATE ON TABLE public.customer_addresses TO laundry_app;
GRANT SELECT, INSERT, UPDATE ON TABLE public.customer_identifiers TO laundry_app;
REVOKE DELETE, TRUNCATE ON TABLE public.customer_profiles FROM laundry_app;
REVOKE DELETE, TRUNCATE ON TABLE public.customer_addresses FROM laundry_app;
REVOKE DELETE, TRUNCATE ON TABLE public.customer_identifiers FROM laundry_app;

-- Remove historical names from ordinary upsert audit payloads. The modifying
-- CTE emits one non-PII maintenance record per affected store and is naturally
-- idempotent because rows without a name key are not touched again.
WITH redacted AS (
  UPDATE public.audit_log
     SET after_json = (after_json::jsonb - 'name')::text
   WHERE command = 'customer.upsert'
     AND after_json IS NOT NULL
     AND after_json::jsonb ? 'name'
  RETURNING org_id, store_id
), counts AS (
  SELECT org_id, store_id, count(*)::integer AS redacted_count
    FROM redacted
   GROUP BY org_id, store_id
)
INSERT INTO public.audit_log (
  id, org_id, store_id, staff_id, via, command, idempotency_key, dry_run,
  entity, entity_id, before_json, after_json, ip, device_id, at
)
SELECT gen_random_uuid(), count_row.org_id, count_row.store_id, NULL,
       'automation', 'migration.0051.audit_pii_redaction', NULL, false,
       'migration', '0051', NULL,
       jsonb_build_object('redacted_count', count_row.redacted_count)::text,
       NULL, NULL, now()
  FROM counts count_row;

-- ---------------------------------------------------------------------------
-- Permanent post-erasure write guards.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.customer_redact_garment_details(requested_details jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT COALESCE(
    jsonb_agg(
      CASE
        WHEN jsonb_typeof(detail.value) = 'object' THEN
          jsonb_set(
            jsonb_set(
              jsonb_set(detail.value, '{note}', 'null'::jsonb, true),
              '{defects}', '[]'::jsonb, true
            ),
            '{accessories}', '[]'::jsonb, true
          )
        ELSE jsonb_build_object(
          'note', NULL,
          'defects', '[]'::jsonb,
          'accessories', '[]'::jsonb
        )
      END
      ORDER BY detail.ordinality
    ),
    '[]'::jsonb
  )
    FROM jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(requested_details) = 'array' THEN requested_details
        ELSE '[]'::jsonb
      END
    ) WITH ORDINALITY AS detail(value, ordinality)
$$;

CREATE OR REPLACE FUNCTION public.customer_privacy_anchor_at(
  requested_org_id uuid,
  requested_kind text,
  requested_id uuid,
  lock_anchor boolean DEFAULT false
)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  session_org uuid := NULLIF(current_setting('app.org_id', true), '')::uuid;
  purged_at timestamptz;
BEGIN
  IF requested_org_id IS NULL OR requested_id IS NULL THEN RETURN NULL; END IF;
  IF session_user = 'laundry_app' AND session_org IS DISTINCT FROM requested_org_id THEN
    RAISE insufficient_privilege USING MESSAGE = 'customer privacy anchor unavailable';
  END IF;

  IF requested_kind = 'customer' THEN
    IF lock_anchor THEN
      SELECT customer_row.anonymized_at INTO purged_at
        FROM customers customer_row
       WHERE customer_row.org_id = requested_org_id AND customer_row.id = requested_id
       FOR SHARE;
    ELSE
      SELECT customer_row.anonymized_at INTO purged_at
        FROM customers customer_row
       WHERE customer_row.org_id = requested_org_id AND customer_row.id = requested_id;
    END IF;
  ELSIF requested_kind = 'order' THEN
    IF lock_anchor THEN
      SELECT order_row.customer_pii_purged_at INTO purged_at
        FROM orders order_row
       WHERE order_row.org_id = requested_org_id AND order_row.id = requested_id
       FOR SHARE;
    ELSE
      SELECT order_row.customer_pii_purged_at INTO purged_at
        FROM orders order_row
       WHERE order_row.org_id = requested_org_id AND order_row.id = requested_id;
    END IF;
  ELSIF requested_kind = 'account' THEN
    IF lock_anchor THEN
      SELECT account_row.customer_pii_purged_at INTO purged_at
        FROM member_accounts account_row
       WHERE account_row.org_id = requested_org_id AND account_row.id = requested_id
       FOR SHARE;
    ELSE
      SELECT account_row.customer_pii_purged_at INTO purged_at
        FROM member_accounts account_row
       WHERE account_row.org_id = requested_org_id AND account_row.id = requested_id;
    END IF;
  ELSIF requested_kind = 'garment' THEN
    IF lock_anchor THEN
      SELECT garment_row.customer_pii_purged_at INTO purged_at
        FROM garments garment_row
       WHERE garment_row.org_id = requested_org_id AND garment_row.id = requested_id
       FOR SHARE;
    ELSE
      SELECT garment_row.customer_pii_purged_at INTO purged_at
        FROM garments garment_row
       WHERE garment_row.org_id = requested_org_id AND garment_row.id = requested_id;
    END IF;
  ELSE
    RAISE invalid_parameter_value USING MESSAGE = 'invalid customer privacy anchor kind';
  END IF;
  RETURN purged_at;
END;
$$;

CREATE OR REPLACE FUNCTION public.customer_guard_subject_writes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  purged_at timestamptz;
BEGIN
  IF TG_TABLE_NAME = 'orders' THEN
    IF TG_OP = 'UPDATE' AND OLD.customer_pii_purged_at IS NOT NULL THEN
      purged_at := OLD.customer_pii_purged_at;
    ELSIF NEW.customer_id IS NOT NULL THEN
      purged_at := customer_privacy_anchor_at(NEW.org_id, 'customer', NEW.customer_id, TG_OP = 'INSERT');
    END IF;
    IF purged_at IS NOT NULL THEN
      NEW.customer_pii_purged_at := purged_at;
      NEW.customer_phone := NULL;
      NEW.customer_name := NULL;
      NEW.note := NULL;
    END IF;
  ELSIF TG_TABLE_NAME = 'order_lines' THEN
    purged_at := customer_privacy_anchor_at(NEW.org_id, 'order', NEW.order_id, true);
    IF purged_at IS NOT NULL THEN
      NEW.garment_details_json := customer_redact_garment_details(NEW.garment_details_json);
    END IF;
  ELSIF TG_TABLE_NAME = 'garments' THEN
    IF TG_OP = 'UPDATE' AND OLD.customer_pii_purged_at IS NOT NULL THEN
      purged_at := OLD.customer_pii_purged_at;
    ELSE
      purged_at := customer_privacy_anchor_at(NEW.org_id, 'order', NEW.order_id, true);
    END IF;
    IF purged_at IS NOT NULL THEN
      NEW.customer_pii_purged_at := purged_at;
      NEW.defects := '[]'::jsonb;
      NEW.accessories := '[]'::jsonb;
      NEW.note := NULL;
    END IF;
  ELSIF TG_TABLE_NAME = 'payments' THEN
    purged_at := customer_privacy_anchor_at(NEW.org_id, 'order', NEW.order_id, true);
    IF purged_at IS NOT NULL THEN NEW.note := NULL; END IF;
  ELSIF TG_TABLE_NAME = 'garment_status_log' THEN
    purged_at := customer_privacy_anchor_at(NEW.org_id, 'garment', NEW.garment_id, true);
    IF purged_at IS NOT NULL THEN NEW.reason := NULL; END IF;
  ELSIF TG_TABLE_NAME = 'garment_incidents' THEN
    purged_at := customer_privacy_anchor_at(NEW.org_id, 'garment', NEW.garment_id, true);
    IF purged_at IS NOT NULL THEN NEW.note := 'privacy_redacted'; END IF;
  ELSIF TG_TABLE_NAME = 'garment_photos' THEN
    purged_at := customer_privacy_anchor_at(NEW.org_id, 'order', NEW.order_id, true);
    IF purged_at IS NULL THEN
      purged_at := customer_privacy_anchor_at(NEW.org_id, 'garment', NEW.garment_id, true);
    END IF;
    IF purged_at IS NOT NULL THEN
      RAISE SQLSTATE 'P0001' USING MESSAGE = 'CUSTOMER_ERASED';
    END IF;
  ELSIF TG_TABLE_NAME = 'print_jobs' THEN
    purged_at := customer_privacy_anchor_at(NEW.org_id, 'order', NEW.order_id, true);
    IF purged_at IS NOT NULL THEN
      IF TG_OP = 'INSERT' OR NEW.status IN ('queued', 'printing') THEN
        RAISE SQLSTATE 'P0001' USING MESSAGE = 'CUSTOMER_ERASED';
      END IF;
      NEW.snapshot_json := NULL;
      NEW.snapshot_purged_at := COALESCE(NEW.snapshot_purged_at, purged_at);
    END IF;
  ELSIF TG_TABLE_NAME = 'member_accounts' THEN
    IF TG_OP = 'UPDATE' AND OLD.customer_pii_purged_at IS NOT NULL THEN
      purged_at := OLD.customer_pii_purged_at;
    ELSE
      purged_at := customer_privacy_anchor_at(NEW.org_id, 'customer', NEW.customer_id, TG_OP = 'INSERT');
    END IF;
    IF purged_at IS NOT NULL THEN
      NEW.customer_pii_purged_at := purged_at;
      IF NEW.status_reason IS NOT NULL THEN NEW.status_reason := 'privacy_redacted'; END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'member_ledger' THEN
    purged_at := customer_privacy_anchor_at(NEW.org_id, 'account', NEW.account_id, true);
    IF purged_at IS NULL AND NEW.order_id IS NOT NULL THEN
      purged_at := customer_privacy_anchor_at(NEW.org_id, 'order', NEW.order_id, true);
    END IF;
    IF purged_at IS NOT NULL THEN NEW.note := NULL; END IF;
  ELSIF TG_TABLE_NAME = 'member_memberships' THEN
    purged_at := customer_privacy_anchor_at(NEW.org_id, 'account', NEW.account_id, true);
    IF purged_at IS NOT NULL THEN NEW.reason := 'privacy_redacted'; END IF;
  ELSIF TG_TABLE_NAME = 'points_ledger' THEN
    purged_at := customer_privacy_anchor_at(NEW.org_id, 'account', NEW.account_id, true);
    IF purged_at IS NULL AND NEW.order_id IS NOT NULL THEN
      purged_at := customer_privacy_anchor_at(NEW.org_id, 'order', NEW.order_id, true);
    END IF;
    IF purged_at IS NOT NULL THEN
      NEW.note := CASE WHEN NEW.kind = 'redeem' THEN 'privacy_redacted' ELSE NULL END;
    END IF;
  ELSIF TG_TABLE_NAME = 'punch_cards' THEN
    purged_at := customer_privacy_anchor_at(NEW.org_id, 'account', NEW.account_id, true);
    IF purged_at IS NOT NULL THEN NEW.reason := 'privacy_redacted'; END IF;
  ELSIF TG_TABLE_NAME = 'punch_card_ledger' THEN
    purged_at := customer_privacy_anchor_at(NEW.org_id, 'account', NEW.account_id, true);
    IF purged_at IS NOT NULL THEN NEW.reason := 'privacy_redacted'; END IF;
  ELSIF TG_TABLE_NAME = 'coupon_grants' THEN
    purged_at := customer_privacy_anchor_at(NEW.org_id, 'account', NEW.account_id, true);
    IF purged_at IS NOT NULL THEN NEW.reason := 'privacy_redacted'; END IF;
  ELSIF TG_TABLE_NAME = 'coupon_redemption_reversals' THEN
    purged_at := customer_privacy_anchor_at(NEW.org_id, 'order', NEW.order_id, true);
    IF purged_at IS NOT NULL THEN NEW.reason := 'privacy_redacted'; END IF;
  ELSIF TG_TABLE_NAME IN ('customer_profiles', 'customer_addresses', 'customer_identifiers') THEN
    purged_at := customer_privacy_anchor_at(NEW.org_id, 'customer', NEW.customer_id, true);
    IF purged_at IS NOT NULL THEN
      RAISE SQLSTATE 'P0001' USING MESSAGE = 'CUSTOMER_ERASED';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.customer_audit_entity_purged(
  requested_org_id uuid,
  requested_entity text,
  requested_entity_id text,
  requested_after_json text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  entity_uuid uuid;
  candidate text;
  subject_id uuid;
  subject_kind text;
BEGIN
  IF requested_entity = 'garment_batch' THEN
    IF requested_after_json IS NULL THEN RETURN false; END IF;
    FOR candidate IN
      SELECT garment_id.value
        FROM jsonb_array_elements_text(
          CASE
            WHEN jsonb_typeof(requested_after_json::jsonb -> 'garment_ids') = 'array'
            THEN requested_after_json::jsonb -> 'garment_ids'
            ELSE '[]'::jsonb
          END
        ) garment_id(value)
       WHERE garment_id.value ~*
         '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       ORDER BY garment_id.value
    LOOP
      IF customer_privacy_anchor_at(
        requested_org_id, 'garment', candidate::uuid, true
      ) IS NOT NULL THEN
        RETURN true;
      END IF;
    END LOOP;
    RETURN false;
  END IF;
  IF requested_entity_id IS NULL OR requested_entity_id !~*
     '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  THEN RETURN false;
  END IF;
  entity_uuid := requested_entity_id::uuid;

  IF requested_entity IN ('customer', 'customer_profile', 'customer_discount_policy') THEN
    subject_kind := 'customer'; subject_id := entity_uuid;
  ELSIF requested_entity = 'order' THEN
    subject_kind := 'order'; subject_id := entity_uuid;
  ELSIF requested_entity = 'garment' THEN
    subject_kind := 'garment'; subject_id := entity_uuid;
  ELSIF requested_entity = 'payment' THEN
    SELECT payment.order_id INTO subject_id FROM payments payment
     WHERE payment.org_id = requested_org_id AND payment.id = entity_uuid;
    subject_kind := 'order';
  ELSIF requested_entity = 'garment_incident' THEN
    SELECT incident.garment_id INTO subject_id FROM garment_incidents incident
     WHERE incident.org_id = requested_org_id AND incident.id = entity_uuid;
    subject_kind := 'garment';
  ELSIF requested_entity = 'garment_photo' THEN
    SELECT photo.order_id INTO subject_id FROM garment_photos photo
     WHERE photo.org_id = requested_org_id AND photo.id = entity_uuid;
    subject_kind := 'order';
  ELSIF requested_entity = 'print_job' THEN
    SELECT print_job.order_id INTO subject_id FROM print_jobs print_job
     WHERE print_job.org_id = requested_org_id AND print_job.id = entity_uuid;
    subject_kind := 'order';
  ELSIF requested_entity IN ('member_account', 'member_membership') THEN
    subject_kind := 'account'; subject_id := entity_uuid;
  ELSIF requested_entity = 'member_ledger' THEN
    SELECT ledger.account_id INTO subject_id FROM member_ledger ledger
     WHERE ledger.org_id = requested_org_id AND ledger.id = entity_uuid;
    subject_kind := 'account';
  ELSIF requested_entity = 'points_ledger' THEN
    SELECT ledger.account_id INTO subject_id FROM points_ledger ledger
     WHERE ledger.org_id = requested_org_id AND ledger.id = entity_uuid;
    subject_kind := 'account';
  ELSIF requested_entity = 'member_asset' THEN
    SELECT asset.account_id INTO subject_id
      FROM (
        SELECT card.account_id FROM punch_cards card
         WHERE card.org_id = requested_org_id AND card.id = entity_uuid
        UNION ALL
        SELECT grant_row.account_id FROM coupon_grants grant_row
         WHERE grant_row.org_id = requested_org_id AND grant_row.id = entity_uuid
      ) asset LIMIT 1;
    subject_kind := 'account';
  ELSIF requested_entity = 'member_asset_usage' THEN
    SELECT usage.account_id INTO subject_id
      FROM (
        SELECT ledger.account_id FROM punch_card_ledger ledger
         WHERE ledger.org_id = requested_org_id AND ledger.id = entity_uuid
        UNION ALL
        SELECT redemption.account_id FROM coupon_redemptions redemption
         WHERE redemption.org_id = requested_org_id AND redemption.id = entity_uuid
      ) usage LIMIT 1;
    subject_kind := 'account';
  ELSE
    RETURN false;
  END IF;
  RETURN subject_id IS NOT NULL
     AND customer_privacy_anchor_at(requested_org_id, subject_kind, subject_id, true) IS NOT NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.customer_guard_audit_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF customer_audit_entity_purged(NEW.org_id, NEW.entity, NEW.entity_id, NEW.after_json) THEN
    NEW.before_json := CASE
      WHEN NEW.before_json IS NULL THEN NULL ELSE '{"privacy_redacted":true}'
    END;
    NEW.after_json := '{"privacy_redacted":true}';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.customer_guard_pending_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  candidate text;
  session_org uuid := NULLIF(current_setting('app.org_id', true), '')::uuid;
BEGIN
  IF session_user = 'laundry_app' AND session_org IS DISTINCT FROM NEW.org_id THEN
    RAISE insufficient_privilege USING MESSAGE = 'customer pending subject unavailable';
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended('customer-privacy-pending:' || NEW.org_id::text, 0)
  );
  -- Match the phone-writer order before taking any customer row lock:
  -- pending advisory -> phone advisory -> customer/account/order/garment.
  FOR candidate IN
    SELECT DISTINCT phone
      FROM unnest(ARRAY[
        NEW.args_json ->> 'phone',
        NEW.args_json ->> 'customer_phone'
      ]) phone
     WHERE phone ~ '^1[3-9][0-9]{9}$'
     ORDER BY phone
  LOOP
    IF customer_phone_erased_for_org(NEW.org_id, candidate)
    THEN RAISE SQLSTATE 'P0001' USING MESSAGE = 'CUSTOMER_ERASED'; END IF;
  END LOOP;

  IF NEW.privacy_subject_customer_id IS NOT NULL
     AND customer_privacy_anchor_at(
       NEW.org_id,
       'customer',
       NEW.privacy_subject_customer_id,
       true
     ) IS NOT NULL
  THEN RAISE SQLSTATE 'P0001' USING MESSAGE = 'CUSTOMER_ERASED'; END IF;
  FOR candidate IN
    SELECT DISTINCT customer_id
      FROM unnest(ARRAY[
        NEW.args_json ->> 'customer_id',
        NEW.args_json ->> 'source_customer_id',
        NEW.args_json ->> 'target_customer_id'
      ]) customer_id
     WHERE customer_id ~*
       '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     ORDER BY customer_id
  LOOP
    IF customer_privacy_anchor_at(NEW.org_id, 'customer', candidate::uuid, true) IS NOT NULL
    THEN RAISE SQLSTATE 'P0001' USING MESSAGE = 'CUSTOMER_ERASED'; END IF;
  END LOOP;

  candidate := NEW.args_json ->> 'account_id';
  IF candidate ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     AND customer_privacy_anchor_at(NEW.org_id, 'account', candidate::uuid, true) IS NOT NULL
  THEN RAISE SQLSTATE 'P0001' USING MESSAGE = 'CUSTOMER_ERASED'; END IF;
  candidate := NEW.args_json #>> '{asset,asset_id}';
  IF candidate ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    FOR candidate IN
      SELECT DISTINCT asset.account_id::text
        FROM (
          SELECT card.account_id
            FROM punch_cards card
           WHERE card.org_id = NEW.org_id
             AND card.id = (NEW.args_json #>> '{asset,asset_id}')::uuid
          UNION ALL
          SELECT grant_row.account_id
            FROM coupon_grants grant_row
           WHERE grant_row.org_id = NEW.org_id
             AND grant_row.id = (NEW.args_json #>> '{asset,asset_id}')::uuid
        ) asset
       ORDER BY asset.account_id::text
    LOOP
      IF customer_privacy_anchor_at(NEW.org_id, 'account', candidate::uuid, true) IS NOT NULL
      THEN RAISE SQLSTATE 'P0001' USING MESSAGE = 'CUSTOMER_ERASED'; END IF;
    END LOOP;
  END IF;

  FOR candidate IN
    SELECT DISTINCT order_id
      FROM (
        SELECT NEW.args_json ->> 'order_id' AS order_id
        UNION ALL
        SELECT order_arg.value
          FROM jsonb_array_elements_text(
            CASE
              WHEN jsonb_typeof(NEW.args_json -> 'order_ids') = 'array'
              THEN NEW.args_json -> 'order_ids'
              ELSE '[]'::jsonb
            END
          ) order_arg(value)
      ) orders
     WHERE order_id ~*
       '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     ORDER BY order_id
  LOOP
    IF customer_privacy_anchor_at(NEW.org_id, 'order', candidate::uuid, true) IS NOT NULL
    THEN RAISE SQLSTATE 'P0001' USING MESSAGE = 'CUSTOMER_ERASED'; END IF;
  END LOOP;

  FOR candidate IN
    SELECT DISTINCT garment_id
      FROM (
        SELECT NEW.args_json ->> 'garment_id' AS garment_id
        UNION ALL
        SELECT garment_arg.value
          FROM jsonb_array_elements_text(
            CASE
              WHEN jsonb_typeof(NEW.args_json -> 'garment_ids') = 'array'
              THEN NEW.args_json -> 'garment_ids'
              ELSE '[]'::jsonb
            END
          ) garment_arg(value)
      ) garments
     WHERE garment_id ~*
       '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     ORDER BY garment_id
  LOOP
    IF customer_privacy_anchor_at(NEW.org_id, 'garment', candidate::uuid, true) IS NOT NULL
    THEN RAISE SQLSTATE 'P0001' USING MESSAGE = 'CUSTOMER_ERASED'; END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

-- One-time cleanup for subjects erased by the pre-0051 implementation. The
-- permanent triggers below prevent these narrative fields from being revived.
UPDATE public.orders order_row
   SET customer_phone = NULL, customer_name = NULL, note = NULL
 WHERE order_row.customer_pii_purged_at IS NOT NULL
   AND (order_row.customer_phone IS NOT NULL OR order_row.customer_name IS NOT NULL
     OR order_row.note IS NOT NULL);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.print_jobs print_job
      JOIN public.orders order_row
        ON order_row.org_id = print_job.org_id
       AND order_row.store_id = print_job.store_id
       AND order_row.id = print_job.order_id
     WHERE order_row.customer_pii_purged_at IS NOT NULL
       AND print_job.snapshot_json IS NOT NULL
       AND (
         print_job.status IN ('queued', 'printing')
         OR print_job.receipt_envelope_sha256 IS NULL
       )
  ) THEN
    RAISE object_not_in_prerequisite_state
      USING MESSAGE = 'legacy customer print snapshot blocks privacy migration';
  END IF;
END;
$$;

UPDATE public.print_jobs print_job
   SET snapshot_json = NULL,
       snapshot_purged_at = COALESCE(
         print_job.snapshot_purged_at, order_row.customer_pii_purged_at
       ),
       updated_at = GREATEST(print_job.updated_at, order_row.customer_pii_purged_at)
  FROM public.orders order_row
 WHERE order_row.org_id = print_job.org_id
   AND order_row.store_id = print_job.store_id
   AND order_row.id = print_job.order_id
   AND order_row.customer_pii_purged_at IS NOT NULL
   AND print_job.status IN ('done', 'failed', 'uncertain')
   AND print_job.receipt_envelope_sha256 IS NOT NULL
   AND print_job.snapshot_json IS NOT NULL;

UPDATE public.order_lines line
   SET garment_details_json = customer_redact_garment_details(line.garment_details_json)
  FROM public.orders order_row
 WHERE order_row.org_id = line.org_id
   AND order_row.store_id = line.store_id
   AND order_row.id = line.order_id
   AND order_row.customer_pii_purged_at IS NOT NULL;

UPDATE public.garments garment
   SET defects = '[]'::jsonb, accessories = '[]'::jsonb, note = NULL
 WHERE garment.customer_pii_purged_at IS NOT NULL;

UPDATE public.payments payment
   SET note = NULL
  FROM public.orders order_row
 WHERE order_row.org_id = payment.org_id
   AND order_row.store_id = payment.store_id
   AND order_row.id = payment.order_id
   AND order_row.customer_pii_purged_at IS NOT NULL
   AND payment.note IS NOT NULL;

UPDATE public.garment_status_log status_row
   SET reason = NULL
  FROM public.garments garment
 WHERE garment.org_id = status_row.org_id
   AND garment.store_id = status_row.store_id
   AND garment.id = status_row.garment_id
   AND garment.customer_pii_purged_at IS NOT NULL
   AND status_row.reason IS NOT NULL;

UPDATE public.garment_incidents incident
   SET note = 'privacy_redacted'
  FROM public.garments garment
 WHERE garment.org_id = incident.org_id
   AND garment.store_id = incident.store_id
   AND garment.id = incident.garment_id
   AND garment.customer_pii_purged_at IS NOT NULL
   AND incident.note IS DISTINCT FROM 'privacy_redacted';

UPDATE public.member_accounts account
   SET status_reason = CASE WHEN account.status = 'active' THEN NULL ELSE 'privacy_redacted' END
 WHERE account.customer_pii_purged_at IS NOT NULL
   AND account.status_reason IS DISTINCT FROM
     CASE WHEN account.status = 'active' THEN NULL ELSE 'privacy_redacted' END;

UPDATE public.member_ledger ledger
   SET note = NULL
 WHERE ledger.note IS NOT NULL
   AND (
     EXISTS (
       SELECT 1 FROM public.member_accounts account
        WHERE account.org_id = ledger.org_id
          AND account.id = ledger.account_id
          AND account.customer_pii_purged_at IS NOT NULL
     )
     OR EXISTS (
       SELECT 1 FROM public.orders order_row
        WHERE order_row.org_id = ledger.org_id
          AND order_row.id = ledger.order_id
          AND order_row.customer_pii_purged_at IS NOT NULL
     )
   );

UPDATE public.member_memberships membership
   SET reason = 'privacy_redacted'
  FROM public.member_accounts account
 WHERE account.org_id = membership.org_id
   AND account.id = membership.account_id
   AND account.customer_pii_purged_at IS NOT NULL
   AND membership.reason <> 'privacy_redacted';

UPDATE public.points_ledger ledger
   SET note = CASE WHEN ledger.kind = 'redeem' THEN 'privacy_redacted' ELSE NULL END
 WHERE ledger.note IS DISTINCT FROM
       CASE WHEN ledger.kind = 'redeem' THEN 'privacy_redacted' ELSE NULL END
   AND (
     EXISTS (
       SELECT 1 FROM public.member_accounts account
        WHERE account.org_id = ledger.org_id
          AND account.id = ledger.account_id
          AND account.customer_pii_purged_at IS NOT NULL
     )
     OR EXISTS (
       SELECT 1 FROM public.orders order_row
        WHERE order_row.org_id = ledger.org_id
          AND order_row.id = ledger.order_id
          AND order_row.customer_pii_purged_at IS NOT NULL
     )
   );

UPDATE public.punch_cards card
   SET reason = 'privacy_redacted'
  FROM public.member_accounts account
 WHERE account.org_id = card.org_id AND account.id = card.account_id
   AND account.customer_pii_purged_at IS NOT NULL
   AND card.reason <> 'privacy_redacted';

UPDATE public.punch_card_ledger ledger
   SET reason = 'privacy_redacted'
  FROM public.member_accounts account
 WHERE account.org_id = ledger.org_id AND account.id = ledger.account_id
   AND account.customer_pii_purged_at IS NOT NULL
   AND ledger.reason <> 'privacy_redacted';

UPDATE public.coupon_grants grant_row
   SET reason = 'privacy_redacted'
  FROM public.member_accounts account
 WHERE account.org_id = grant_row.org_id AND account.id = grant_row.account_id
   AND account.customer_pii_purged_at IS NOT NULL
   AND grant_row.reason <> 'privacy_redacted';

UPDATE public.coupon_redemption_reversals reversal
   SET reason = 'privacy_redacted'
  FROM public.orders order_row
 WHERE order_row.org_id = reversal.org_id
   AND order_row.store_id = reversal.store_id
   AND order_row.id = reversal.order_id
   AND order_row.customer_pii_purged_at IS NOT NULL
   AND reversal.reason <> 'privacy_redacted';

UPDATE public.customer_profiles profile
   SET service_note = NULL
  FROM public.customers customer_row
 WHERE customer_row.org_id = profile.org_id
   AND customer_row.id = profile.customer_id
   AND customer_row.anonymized_at IS NOT NULL
   AND profile.service_note IS NOT NULL;

UPDATE public.customer_addresses address_row
   SET label = NULL, recipient = NULL, contact_phone = NULL, address_body = NULL,
       is_default = false,
       retired_at = COALESCE(address_row.retired_at, customer_row.anonymized_at),
       pii_purged_at = COALESCE(address_row.pii_purged_at, customer_row.anonymized_at),
       updated_at = GREATEST(address_row.updated_at, customer_row.anonymized_at)
  FROM public.customers customer_row
 WHERE customer_row.org_id = address_row.org_id
   AND customer_row.id = address_row.customer_id
   AND customer_row.anonymized_at IS NOT NULL;

UPDATE public.customer_identifiers identifier_row
   SET raw_value = NULL, normalized_value = NULL,
       retired_at = COALESCE(identifier_row.retired_at, customer_row.anonymized_at),
       pii_purged_at = COALESCE(identifier_row.pii_purged_at, customer_row.anonymized_at),
       updated_at = GREATEST(identifier_row.updated_at, customer_row.anonymized_at)
  FROM public.customers customer_row
 WHERE customer_row.org_id = identifier_row.org_id
   AND customer_row.id = identifier_row.customer_id
   AND customer_row.anonymized_at IS NOT NULL;

UPDATE public.audit_log audit_row
   SET before_json = CASE WHEN audit_row.before_json IS NULL THEN NULL
                          ELSE '{"privacy_redacted":true}' END,
       after_json = '{"privacy_redacted":true}'
 WHERE customer_audit_entity_purged(
   audit_row.org_id, audit_row.entity, audit_row.entity_id, audit_row.after_json
 );

DELETE FROM public.ai_pending_actions pending
 WHERE EXISTS (
   SELECT 1 FROM public.customers customer_row
    WHERE customer_row.org_id = pending.org_id
      AND customer_row.anonymized_at IS NOT NULL
      AND customer_row.id::text IN (
        pending.privacy_subject_customer_id::text,
        pending.args_json ->> 'customer_id',
        pending.args_json ->> 'source_customer_id',
        pending.args_json ->> 'target_customer_id'
      )
 )
 OR EXISTS (
   SELECT 1 FROM public.orders order_row
    WHERE order_row.org_id = pending.org_id
      AND order_row.customer_pii_purged_at IS NOT NULL
      AND (
        order_row.id::text = pending.args_json ->> 'order_id'
        OR order_row.id::text IN (
          SELECT order_id.value
            FROM jsonb_array_elements_text(
              CASE WHEN jsonb_typeof(pending.args_json -> 'order_ids') = 'array'
                   THEN pending.args_json -> 'order_ids' ELSE '[]'::jsonb END
            ) order_id(value)
        )
      )
 )
 OR EXISTS (
   SELECT 1 FROM public.member_accounts account
    WHERE account.org_id = pending.org_id
      AND account.customer_pii_purged_at IS NOT NULL
      AND (
        account.id::text = pending.args_json ->> 'account_id'
        OR account.id IN (
          SELECT asset.account_id FROM (
            SELECT card.account_id FROM public.punch_cards card
             WHERE card.org_id = pending.org_id
               AND card.id::text = pending.args_json #>> '{asset,asset_id}'
            UNION ALL
            SELECT grant_row.account_id FROM public.coupon_grants grant_row
             WHERE grant_row.org_id = pending.org_id
               AND grant_row.id::text = pending.args_json #>> '{asset,asset_id}'
          ) asset
        )
      )
 )
 OR EXISTS (
   SELECT 1 FROM public.garments garment
    WHERE garment.org_id = pending.org_id
      AND garment.customer_pii_purged_at IS NOT NULL
      AND (
        garment.id::text = pending.args_json ->> 'garment_id'
        OR garment.id::text IN (
          SELECT garment_id.value
            FROM jsonb_array_elements_text(
              CASE WHEN jsonb_typeof(pending.args_json -> 'garment_ids') = 'array'
                   THEN pending.args_json -> 'garment_ids' ELSE '[]'::jsonb END
            ) garment_id(value)
        )
      )
 )
 OR CASE
      WHEN pending.args_json ->> 'phone' ~ '^1[3-9][0-9]{9}$'
      THEN customer_phone_erased_for_org(pending.org_id, pending.args_json ->> 'phone')
      ELSE false
    END
 OR CASE
      WHEN pending.args_json ->> 'customer_phone' ~ '^1[3-9][0-9]{9}$'
      THEN customer_phone_erased_for_org(pending.org_id, pending.args_json ->> 'customer_phone')
      ELSE false
    END;

UPDATE public.command_idempotency idempotency
   SET result_json = jsonb_build_object(
         'ok', false,
         'error', jsonb_build_object(
           'code', 'CUSTOMER_ERASED',
           'message', 'Customer data was erased and cannot be recreated'
         )
       ),
       pii_purged_at = COALESCE(idempotency.pii_purged_at, now())
 WHERE idempotency.status = 'completed'
   AND (
     EXISTS (
       SELECT 1 FROM public.customers customer_row
        WHERE customer_row.org_id = idempotency.org_id
          AND customer_row.anonymized_at IS NOT NULL
          AND customer_row.id::text IN (
            idempotency.privacy_subject_customer_id::text,
            idempotency.result_json #>> '{data,result,customer_id}',
            idempotency.result_json #>> '{data,result,customer,customer_id}',
            idempotency.result_json #>> '{data,result,benefits,customer_id}'
          )
     )
     OR (
       idempotency.command = 'notification.manual_list.create'
       AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements(
             CASE
               WHEN jsonb_typeof(idempotency.result_json #> '{data,result,rows}') = 'array'
               THEN idempotency.result_json #> '{data,result,rows}'
               ELSE '[]'::jsonb
             END
           ) result_row(value)
           CROSS JOIN LATERAL jsonb_array_elements_text(
             CASE WHEN jsonb_typeof(result_row.value -> 'order_ids') = 'array'
                  THEN result_row.value -> 'order_ids' ELSE '[]'::jsonb END
           ) order_id(value)
           JOIN public.orders order_row
             ON order_row.org_id = idempotency.org_id
            AND order_row.id::text = order_id.value
            AND order_row.customer_pii_purged_at IS NOT NULL
       )
     )
   );

UPDATE public.edge_replay_records replay
   SET result_json = jsonb_build_object(
         'ok', false,
         'error', jsonb_build_object(
           'code', 'CUSTOMER_ERASED',
           'message', 'Customer data was erased and cannot be recreated'
         )
       ),
       pii_purged_at = COALESCE(replay.pii_purged_at, now())
 WHERE replay.result_json IS NOT NULL
   AND (
     EXISTS (
       SELECT 1 FROM public.customers customer_row
        WHERE customer_row.org_id = replay.org_id
          AND customer_row.anonymized_at IS NOT NULL
          AND customer_row.id::text IN (
            replay.privacy_subject_customer_id::text,
            replay.result_json #>> '{data,result,customer_id}',
            replay.result_json #>> '{data,result,customer,customer_id}',
            replay.result_json #>> '{data,result,benefits,customer_id}'
          )
     )
     OR (
       replay.command = 'notification.manual_list.create'
       AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements(
             CASE
               WHEN jsonb_typeof(replay.result_json #> '{data,result,rows}') = 'array'
               THEN replay.result_json #> '{data,result,rows}'
               ELSE '[]'::jsonb
             END
           ) result_row(value)
           CROSS JOIN LATERAL jsonb_array_elements_text(
             CASE WHEN jsonb_typeof(result_row.value -> 'order_ids') = 'array'
                  THEN result_row.value -> 'order_ids' ELSE '[]'::jsonb END
           ) order_id(value)
           JOIN public.orders order_row
             ON order_row.org_id = replay.org_id
            AND order_row.id::text = order_id.value
            AND order_row.customer_pii_purged_at IS NOT NULL
       )
     )
   );

CREATE TRIGGER customer_guard_orders_trg
BEFORE INSERT OR UPDATE ON public.orders
FOR EACH ROW EXECUTE FUNCTION public.customer_guard_subject_writes();
CREATE TRIGGER customer_guard_order_lines_trg
BEFORE INSERT OR UPDATE ON public.order_lines
FOR EACH ROW EXECUTE FUNCTION public.customer_guard_subject_writes();
CREATE TRIGGER customer_guard_garments_trg
BEFORE INSERT OR UPDATE ON public.garments
FOR EACH ROW EXECUTE FUNCTION public.customer_guard_subject_writes();
CREATE TRIGGER customer_guard_payments_trg
BEFORE INSERT OR UPDATE ON public.payments
FOR EACH ROW EXECUTE FUNCTION public.customer_guard_subject_writes();
CREATE TRIGGER customer_guard_garment_status_log_trg
BEFORE INSERT OR UPDATE ON public.garment_status_log
FOR EACH ROW EXECUTE FUNCTION public.customer_guard_subject_writes();
CREATE TRIGGER customer_guard_garment_incidents_trg
BEFORE INSERT OR UPDATE ON public.garment_incidents
FOR EACH ROW EXECUTE FUNCTION public.customer_guard_subject_writes();
CREATE TRIGGER customer_guard_garment_photos_trg
BEFORE INSERT ON public.garment_photos
FOR EACH ROW EXECUTE FUNCTION public.customer_guard_subject_writes();
CREATE TRIGGER customer_guard_print_jobs_trg
BEFORE INSERT OR UPDATE ON public.print_jobs
FOR EACH ROW EXECUTE FUNCTION public.customer_guard_subject_writes();
CREATE TRIGGER customer_guard_member_accounts_trg
BEFORE INSERT OR UPDATE ON public.member_accounts
FOR EACH ROW EXECUTE FUNCTION public.customer_guard_subject_writes();
CREATE TRIGGER customer_guard_member_ledger_trg
BEFORE INSERT OR UPDATE ON public.member_ledger
FOR EACH ROW EXECUTE FUNCTION public.customer_guard_subject_writes();
CREATE TRIGGER customer_guard_member_memberships_trg
BEFORE INSERT OR UPDATE ON public.member_memberships
FOR EACH ROW EXECUTE FUNCTION public.customer_guard_subject_writes();
CREATE TRIGGER customer_guard_points_ledger_trg
BEFORE INSERT OR UPDATE ON public.points_ledger
FOR EACH ROW EXECUTE FUNCTION public.customer_guard_subject_writes();
CREATE TRIGGER customer_guard_punch_cards_trg
BEFORE INSERT OR UPDATE ON public.punch_cards
FOR EACH ROW EXECUTE FUNCTION public.customer_guard_subject_writes();
CREATE TRIGGER customer_guard_punch_card_ledger_trg
BEFORE INSERT OR UPDATE ON public.punch_card_ledger
FOR EACH ROW EXECUTE FUNCTION public.customer_guard_subject_writes();
CREATE TRIGGER customer_guard_coupon_grants_trg
BEFORE INSERT OR UPDATE ON public.coupon_grants
FOR EACH ROW EXECUTE FUNCTION public.customer_guard_subject_writes();
CREATE TRIGGER customer_guard_coupon_reversals_trg
BEFORE INSERT OR UPDATE ON public.coupon_redemption_reversals
FOR EACH ROW EXECUTE FUNCTION public.customer_guard_subject_writes();
CREATE TRIGGER customer_guard_profiles_trg
BEFORE INSERT OR UPDATE ON public.customer_profiles
FOR EACH ROW EXECUTE FUNCTION public.customer_guard_subject_writes();
CREATE TRIGGER customer_guard_addresses_trg
BEFORE INSERT OR UPDATE ON public.customer_addresses
FOR EACH ROW EXECUTE FUNCTION public.customer_guard_subject_writes();
CREATE TRIGGER customer_guard_identifiers_trg
BEFORE INSERT OR UPDATE ON public.customer_identifiers
FOR EACH ROW EXECUTE FUNCTION public.customer_guard_subject_writes();
CREATE TRIGGER customer_guard_audit_log_trg
BEFORE INSERT ON public.audit_log
FOR EACH ROW EXECUTE FUNCTION public.customer_guard_audit_write();
CREATE TRIGGER customer_guard_pending_actions_trg
BEFORE INSERT ON public.ai_pending_actions
FOR EACH ROW EXECUTE FUNCTION public.customer_guard_pending_write();

REVOKE ALL ON FUNCTION public.customer_redact_garment_details(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.customer_privacy_anchor_at(uuid, text, uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.customer_guard_subject_writes() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.customer_audit_entity_purged(uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.customer_guard_audit_write() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.customer_guard_pending_write() FROM PUBLIC;

-- Runtime-wide retention cannot be scoped to LOCAL_PROFILE: Cloud Owner may
-- leave dormant stores with no later command to trigger tenant-local pruning.
-- One invocation selects one oldest eligible org, takes the same privacy /
-- pending advisory used by create, confirm and anonymize, then removes at most
-- 100 rows across that org's stores. The database owns the clock so an app-role
-- caller cannot manufacture a future cutoff.
CREATE OR REPLACE FUNCTION public.prune_expired_pending_actions_global(
  requested_batch integer DEFAULT 100
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  retention_cutoff bigint := floor(extract(epoch FROM clock_timestamp()))::bigint - 2592000;
  target_org uuid;
  deleted_count integer := 0;
BEGIN
  IF requested_batch IS NULL OR requested_batch < 1 OR requested_batch > 100 THEN
    RAISE EXCEPTION 'pending cleanup batch must be between 1 and 100'
      USING ERRCODE = '22023';
  END IF;

  SELECT pending.org_id
    INTO target_org
    FROM ai_pending_actions pending
   WHERE pending.expires_at_epoch <= retention_cutoff
     AND (
       pending.status IN ('pending', 'expired', 'denied')
       OR (
         pending.status = 'consumed'
         AND NOT EXISTS (
           SELECT 1
             FROM command_idempotency replay
            WHERE replay.org_id = pending.org_id
              AND replay.store_id = pending.store_id
              AND replay.command = pending.command
              AND replay.idempotency_key = pending.idempotency_key
              AND replay.status = 'completed'
              AND replay.completed_at > to_timestamp(retention_cutoff::double precision)
         )
       )
     )
   ORDER BY pending.expires_at_epoch, pending.org_id, pending.store_id, pending.nonce
   LIMIT 1;
  IF target_org IS NULL THEN RETURN 0; END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('customer-privacy-pending:' || target_org::text, 0)
  );
  WITH candidates AS (
    SELECT pending.nonce
      FROM ai_pending_actions pending
     WHERE pending.org_id = target_org
       AND pending.expires_at_epoch <= retention_cutoff
       AND (
         pending.status IN ('pending', 'expired', 'denied')
         OR (
           pending.status = 'consumed'
           AND NOT EXISTS (
             SELECT 1
               FROM command_idempotency replay
              WHERE replay.org_id = pending.org_id
                AND replay.store_id = pending.store_id
                AND replay.command = pending.command
                AND replay.idempotency_key = pending.idempotency_key
                AND replay.status = 'completed'
                AND replay.completed_at > to_timestamp(retention_cutoff::double precision)
           )
         )
       )
     ORDER BY pending.status, pending.expires_at_epoch, pending.store_id, pending.nonce
     LIMIT requested_batch
     FOR UPDATE OF pending SKIP LOCKED
  )
  DELETE FROM ai_pending_actions pending
   USING candidates
   WHERE pending.nonce = candidates.nonce;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

REVOKE ALL ON FUNCTION public.prune_expired_pending_actions_global(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.prune_expired_pending_actions_global(integer) TO laundry_app;

-- ---------------------------------------------------------------------------
-- Canonical-group privacy functions replace the single-row 0034 definitions.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.customer_privacy_status(requested_customer_id uuid)
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
  root_id uuid;
  group_ids uuid[];
BEGIN
  SELECT * INTO authority FROM assert_customer_privacy_authority();
  root_id := customer_canonical_root(requested_customer_id);
  IF root_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM customers root_customer
     WHERE root_customer.org_id = authority.org_id
       AND root_customer.id = root_id
       AND root_customer.merged_into_id IS NULL
       AND root_customer.anonymized_at IS NULL
  ) THEN
    RETURN;
  END IF;
  SELECT array_agg(group_row.group_customer_id)
    INTO group_ids
    FROM customer_canonical_group(root_id) group_row;

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
         AND linked_order.customer_id = ANY(group_ids)
    ),
    max(order_row.created_at)
  FROM orders order_row
  WHERE order_row.org_id = authority.org_id
    AND order_row.customer_id = ANY(group_ids);
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
  authority record;
  root_id uuid;
  root_customer record;
  group_ids uuid[];
  group_text_ids text[];
  group_phones text[];
  group_order_ids uuid[] := ARRAY[]::uuid[];
  group_account_ids uuid[] := ARRAY[]::uuid[];
  group_garment_ids uuid[] := ARRAY[]::uuid[];
  group_garment_text_ids text[] := ARRAY[]::text[];
  related_audit_entity_ids text[] := ARRAY[]::text[];
  canonical_customers jsonb;
  profile_rows jsonb;
  profile_count integer;
  profile_json jsonb;
  address_rows jsonb;
  address_count integer;
  retired_address_count integer;
  identifier_rows jsonb;
  identifier_count integer;
  retired_identifier_count integer;
  related_narrative_rows jsonb;
  related_narrative_count integer;
  retained_garment_photo_count integer;
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

  -- Freeze the complete inbound merge graph for the duration of the export.
  PERFORM pg_advisory_xact_lock(hashtextextended(authority.org_id::text, 42));

  root_id := customer_canonical_root(requested_customer_id);
  IF root_id IS NULL THEN RETURN NULL; END IF;
  SELECT root_row.id, root_row.phone, root_row.name, root_row.note,
         root_row.created_at, root_row.updated_at
    INTO root_customer
    FROM customers root_row
   WHERE root_row.org_id = authority.org_id
     AND root_row.id = root_id
     AND root_row.merged_into_id IS NULL
     AND root_row.anonymized_at IS NULL
   FOR UPDATE;
  IF root_customer.id IS NULL THEN RETURN NULL; END IF;

  SELECT array_agg(group_row.group_customer_id)
    INTO group_ids
    FROM customer_canonical_group(root_id) group_row;
  PERFORM customer_row.id
    FROM customers customer_row
   WHERE customer_row.org_id = authority.org_id
     AND customer_row.id = ANY(group_ids)
   ORDER BY customer_row.id
   FOR UPDATE;

  SELECT COALESCE(array_agg(customer_row.id::text ORDER BY customer_row.id), ARRAY[]::text[]),
         COALESCE(
           array_agg(customer_row.phone ORDER BY customer_row.id)
             FILTER (WHERE customer_row.phone ~ '^1[3-9][0-9]{9}$'),
           ARRAY[]::text[]
         )
    INTO group_text_ids, group_phones
    FROM customers customer_row
   WHERE customer_row.org_id = authority.org_id
     AND customer_row.id = ANY(group_ids);

  SELECT COALESCE(array_agg(account.id ORDER BY account.id), ARRAY[]::uuid[])
    INTO group_account_ids
    FROM member_accounts account
   WHERE account.org_id = authority.org_id
     AND account.customer_id = ANY(group_ids);
  PERFORM account.id
    FROM member_accounts account
   WHERE account.org_id = authority.org_id
     AND account.id = ANY(group_account_ids)
   ORDER BY account.id
   FOR UPDATE;

  SELECT COALESCE(array_agg(order_row.id ORDER BY order_row.id), ARRAY[]::uuid[])
    INTO group_order_ids
    FROM orders order_row
   WHERE order_row.org_id = authority.org_id
     AND order_row.customer_id = ANY(group_ids);
  PERFORM print_job.id
    FROM print_jobs print_job
   WHERE print_job.org_id = authority.org_id
     AND print_job.order_id = ANY(group_order_ids)
   ORDER BY print_job.org_id, print_job.store_id, print_job.id
   FOR UPDATE;
  PERFORM order_row.id
    FROM orders order_row
   WHERE order_row.org_id = authority.org_id
     AND order_row.id = ANY(group_order_ids)
   ORDER BY order_row.org_id, order_row.store_id, order_row.id
   FOR UPDATE;

  SELECT COALESCE(array_agg(garment.id ORDER BY garment.id), ARRAY[]::uuid[]),
         COALESCE(array_agg(garment.id::text ORDER BY garment.id), ARRAY[]::text[])
    INTO group_garment_ids, group_garment_text_ids
    FROM garments garment
   WHERE garment.org_id = authority.org_id
     AND garment.order_id = ANY(group_order_ids);
  PERFORM garment.id
    FROM garments garment
   WHERE garment.org_id = authority.org_id
     AND garment.id = ANY(group_garment_ids)
   ORDER BY garment.org_id, garment.store_id, garment.id
   FOR UPDATE;

  WITH related_entity(entity_id) AS (
    SELECT unnest(group_text_ids)
    UNION SELECT unnest(group_order_ids)::text
    UNION SELECT unnest(group_account_ids)::text
    UNION SELECT unnest(group_garment_ids)::text
    UNION SELECT payment.id::text FROM payments payment
      WHERE payment.org_id = authority.org_id AND payment.order_id = ANY(group_order_ids)
    UNION SELECT incident.id::text FROM garment_incidents incident
      WHERE incident.org_id = authority.org_id AND incident.order_id = ANY(group_order_ids)
    UNION SELECT photo.id::text FROM garment_photos photo
      WHERE photo.org_id = authority.org_id AND photo.order_id = ANY(group_order_ids)
    UNION SELECT print_job.id::text FROM print_jobs print_job
      WHERE print_job.org_id = authority.org_id AND print_job.order_id = ANY(group_order_ids)
    UNION SELECT ledger.id::text FROM member_ledger ledger
      WHERE ledger.org_id = authority.org_id
        AND (ledger.account_id = ANY(group_account_ids) OR ledger.order_id = ANY(group_order_ids))
    UNION SELECT ledger.id::text FROM points_ledger ledger
      WHERE ledger.org_id = authority.org_id
        AND (ledger.account_id = ANY(group_account_ids) OR ledger.order_id = ANY(group_order_ids))
    UNION SELECT card.id::text FROM punch_cards card
      WHERE card.org_id = authority.org_id AND card.account_id = ANY(group_account_ids)
    UNION SELECT ledger.id::text FROM punch_card_ledger ledger
      WHERE ledger.org_id = authority.org_id AND ledger.account_id = ANY(group_account_ids)
    UNION SELECT grant_row.id::text FROM coupon_grants grant_row
      WHERE grant_row.org_id = authority.org_id AND grant_row.account_id = ANY(group_account_ids)
    UNION SELECT redemption.id::text FROM coupon_redemptions redemption
      WHERE redemption.org_id = authority.org_id
        AND (redemption.account_id = ANY(group_account_ids) OR redemption.order_id = ANY(group_order_ids))
    UNION SELECT reversal.id::text FROM coupon_redemption_reversals reversal
      WHERE reversal.org_id = authority.org_id AND reversal.order_id = ANY(group_order_ids)
  )
  SELECT COALESCE(array_agg(entity_id ORDER BY entity_id), ARRAY[]::text[])
    INTO related_audit_entity_ids
    FROM related_entity;

  SELECT jsonb_agg(
           jsonb_build_object(
             'customer_id', customer_row.id,
             'phone', customer_row.phone,
             'name', customer_row.name,
             'note', customer_row.note,
             'merged_into_id', customer_row.merged_into_id,
             'created_at', extract(epoch FROM customer_row.created_at)::bigint,
             'updated_at', extract(epoch FROM customer_row.updated_at)::bigint
           ) ORDER BY customer_row.created_at, customer_row.id
         )
    INTO canonical_customers
    FROM customers customer_row
   WHERE customer_row.org_id = authority.org_id
     AND customer_row.id = ANY(group_ids);

  SELECT count(*)::integer,
         COALESCE(
           jsonb_agg(
             jsonb_build_object(
               'customer_id', profile.customer_id,
               'version', profile.version,
               'gender', profile.gender,
               'preferred_contact', profile.preferred_contact,
               'service_note', profile.service_note,
               'discount_bps', profile.discount_bps,
               'waivers', jsonb_build_object(
                 'skip_ticket_print', profile.skip_ticket_print,
                 'skip_label_print', profile.skip_label_print,
                 'skip_rack_assignment', profile.skip_rack_assignment
               ),
               'updated_at', extract(epoch FROM profile.updated_at)::bigint
             ) ORDER BY (profile.customer_id = root_id) DESC,
                        profile.updated_at DESC, profile.customer_id
           ),
           '[]'::jsonb
         )
    INTO profile_count, profile_rows
    FROM customer_profiles profile
   WHERE profile.org_id = authority.org_id
     AND profile.customer_id = ANY(group_ids);
  profile_json := profile_rows -> 0;

  SELECT count(*)::integer INTO address_count
    FROM customer_addresses address_row
   WHERE address_row.org_id = authority.org_id
     AND address_row.customer_id = ANY(group_ids)
     AND address_row.retired_at IS NULL;
  SELECT count(*)::integer INTO retired_address_count
    FROM customer_addresses address_row
   WHERE address_row.org_id = authority.org_id
     AND address_row.customer_id = ANY(group_ids)
     AND address_row.retired_at IS NOT NULL;
  SELECT COALESCE(jsonb_agg(to_jsonb(bounded) ORDER BY bounded.is_default DESC, bounded.created_at), '[]'::jsonb)
    INTO address_rows
    FROM (
      SELECT address_row.id AS address_id, address_row.customer_id,
             address_row.label, address_row.recipient, address_row.contact_phone,
             address_row.address_body AS address, address_row.is_default,
             address_row.profile_version, address_row.created_at
        FROM customer_addresses address_row
       WHERE address_row.org_id = authority.org_id
         AND address_row.customer_id = ANY(group_ids)
         AND address_row.retired_at IS NULL
       ORDER BY address_row.is_default DESC, address_row.created_at, address_row.id
       LIMIT 1000
    ) bounded;

  SELECT count(*)::integer INTO identifier_count
    FROM customer_identifiers identifier_row
   WHERE identifier_row.org_id = authority.org_id
     AND identifier_row.customer_id = ANY(group_ids)
     AND identifier_row.retired_at IS NULL;
  SELECT count(*)::integer INTO retired_identifier_count
    FROM customer_identifiers identifier_row
   WHERE identifier_row.org_id = authority.org_id
     AND identifier_row.customer_id = ANY(group_ids)
     AND identifier_row.retired_at IS NOT NULL;
  SELECT COALESCE(jsonb_agg(to_jsonb(bounded) ORDER BY bounded.kind, bounded.created_at), '[]'::jsonb)
    INTO identifier_rows
    FROM (
      SELECT identifier_row.id AS identifier_id, identifier_row.customer_id,
             identifier_row.kind, identifier_row.raw_value AS value,
             identifier_row.profile_version, identifier_row.created_at
        FROM customer_identifiers identifier_row
       WHERE identifier_row.org_id = authority.org_id
         AND identifier_row.customer_id = ANY(group_ids)
         AND identifier_row.retired_at IS NULL
       ORDER BY identifier_row.kind, identifier_row.created_at, identifier_row.id
       LIMIT 1000
    ) bounded;

  WITH narrative_rows AS (
    SELECT 'payment'::text AS source, payment.id AS entity_id,
           payment.order_id, NULL::uuid AS account_id,
           jsonb_build_object('note', payment.note) AS payload,
           payment.at AS recorded_at
      FROM payments payment
      JOIN orders order_row
        ON order_row.org_id = payment.org_id
       AND order_row.store_id = payment.store_id
       AND order_row.id = payment.order_id
     WHERE payment.org_id = authority.org_id
       AND order_row.customer_id = ANY(group_ids)
       AND payment.note IS NOT NULL
    UNION ALL
    SELECT 'order_line_garment_details', line.id, line.order_id, NULL::uuid,
           jsonb_build_object('garment_details', line.garment_details_json),
           order_row.created_at
      FROM order_lines line
      JOIN orders order_row
        ON order_row.org_id = line.org_id
       AND order_row.store_id = line.store_id
       AND order_row.id = line.order_id
     WHERE line.org_id = authority.org_id
       AND order_row.customer_id = ANY(group_ids)
       AND customer_redact_garment_details(line.garment_details_json)
           IS DISTINCT FROM line.garment_details_json
    UNION ALL
    SELECT 'garment', garment.id, garment.order_id, NULL::uuid,
           jsonb_build_object(
             'defects', garment.defects,
             'accessories', garment.accessories,
             'note', garment.note
           ),
           order_row.created_at
      FROM garments garment
      JOIN orders order_row
        ON order_row.org_id = garment.org_id
       AND order_row.store_id = garment.store_id
       AND order_row.id = garment.order_id
     WHERE garment.org_id = authority.org_id
       AND order_row.customer_id = ANY(group_ids)
       AND (
         garment.note IS NOT NULL
         OR garment.defects <> '[]'::jsonb
         OR garment.accessories <> '[]'::jsonb
       )
    UNION ALL
    SELECT 'garment_status', status_row.id, status_row.order_id, NULL::uuid,
           jsonb_build_object('reason', status_row.reason), status_row.at
      FROM garment_status_log status_row
      JOIN orders order_row
        ON order_row.org_id = status_row.org_id
       AND order_row.store_id = status_row.store_id
       AND order_row.id = status_row.order_id
     WHERE status_row.org_id = authority.org_id
       AND order_row.customer_id = ANY(group_ids)
       AND status_row.reason IS NOT NULL
    UNION ALL
    SELECT 'garment_incident', incident.id, incident.order_id, NULL::uuid,
           jsonb_build_object('note', incident.note), incident.created_at
      FROM garment_incidents incident
      JOIN orders order_row
        ON order_row.org_id = incident.org_id
       AND order_row.store_id = incident.store_id
       AND order_row.id = incident.order_id
     WHERE incident.org_id = authority.org_id
       AND order_row.customer_id = ANY(group_ids)
    UNION ALL
    SELECT 'member_account', account.id, NULL::uuid, account.id,
           jsonb_build_object('status_reason', account.status_reason),
           COALESCE(account.status_changed_at, account.opened_at)
      FROM member_accounts account
     WHERE account.org_id = authority.org_id
       AND account.customer_id = ANY(group_ids)
       AND account.status_reason IS NOT NULL
    UNION ALL
    SELECT 'member_ledger', ledger.id, ledger.order_id, ledger.account_id,
           jsonb_build_object('note', ledger.note), ledger.at
      FROM member_ledger ledger
      JOIN member_accounts account
        ON account.org_id = ledger.org_id
       AND account.id = ledger.account_id
     WHERE ledger.org_id = authority.org_id
       AND (
         account.customer_id = ANY(group_ids)
         OR ledger.order_id = ANY(group_order_ids)
       )
       AND ledger.note IS NOT NULL
    UNION ALL
    SELECT 'member_membership', membership.account_id, NULL::uuid, membership.account_id,
           jsonb_build_object('reason', membership.reason), membership.updated_at
      FROM member_memberships membership
      JOIN member_accounts account
        ON account.org_id = membership.org_id
       AND account.id = membership.account_id
     WHERE membership.org_id = authority.org_id
       AND account.customer_id = ANY(group_ids)
    UNION ALL
    SELECT 'points_ledger', ledger.id, ledger.order_id, ledger.account_id,
           jsonb_build_object('note', ledger.note), ledger.at
      FROM points_ledger ledger
      JOIN member_accounts account
        ON account.org_id = ledger.org_id
       AND account.id = ledger.account_id
     WHERE ledger.org_id = authority.org_id
       AND (
         account.customer_id = ANY(group_ids)
         OR ledger.order_id = ANY(group_order_ids)
       )
       AND ledger.note IS NOT NULL
    UNION ALL
    SELECT 'punch_card', card.id, NULL::uuid, card.account_id,
           jsonb_build_object('reason', card.reason), card.issued_at
      FROM punch_cards card
      JOIN member_accounts account
        ON account.org_id = card.org_id
       AND account.id = card.account_id
     WHERE card.org_id = authority.org_id
       AND account.customer_id = ANY(group_ids)
    UNION ALL
    SELECT 'punch_card_ledger', ledger.id, NULL::uuid, ledger.account_id,
           jsonb_build_object('reason', ledger.reason), ledger.at
      FROM punch_card_ledger ledger
      JOIN member_accounts account
        ON account.org_id = ledger.org_id
       AND account.id = ledger.account_id
     WHERE ledger.org_id = authority.org_id
       AND account.customer_id = ANY(group_ids)
    UNION ALL
    SELECT 'coupon_grant', grant_row.id, NULL::uuid, grant_row.account_id,
           jsonb_build_object('reason', grant_row.reason), grant_row.granted_at
      FROM coupon_grants grant_row
      JOIN member_accounts account
        ON account.org_id = grant_row.org_id
       AND account.id = grant_row.account_id
     WHERE grant_row.org_id = authority.org_id
       AND account.customer_id = ANY(group_ids)
    UNION ALL
    SELECT 'coupon_redemption_reversal', reversal.id, reversal.order_id,
           redemption.account_id,
           jsonb_build_object('reason', reversal.reason), reversal.at
      FROM coupon_redemption_reversals reversal
      JOIN coupon_redemptions redemption
        ON redemption.org_id = reversal.org_id
       AND redemption.id = reversal.redemption_id
      JOIN member_accounts account
        ON account.org_id = redemption.org_id
       AND account.id = redemption.account_id
     WHERE reversal.org_id = authority.org_id
       AND (
         account.customer_id = ANY(group_ids)
         OR reversal.order_id = ANY(group_order_ids)
       )
    UNION ALL
    SELECT 'audit_log', audit_row.id, NULL::uuid, NULL::uuid,
           jsonb_build_object(
             'command', audit_row.command,
             'entity', audit_row.entity,
             'entity_id', audit_row.entity_id,
             'before_json', audit_row.before_json,
             'after_json', audit_row.after_json
           ),
           audit_row.at
      FROM audit_log audit_row
     WHERE audit_row.org_id = authority.org_id
       AND (audit_row.before_json IS NOT NULL OR audit_row.after_json IS NOT NULL)
       AND (
         audit_row.entity_id = ANY(related_audit_entity_ids)
         OR (
           audit_row.entity = 'garment_batch'
           AND audit_row.after_json IS NOT NULL
           AND EXISTS (
             SELECT 1
               FROM jsonb_array_elements_text(
                 CASE
                   WHEN jsonb_typeof(audit_row.after_json::jsonb -> 'garment_ids') = 'array'
                   THEN audit_row.after_json::jsonb -> 'garment_ids'
                   ELSE '[]'::jsonb
                 END
               ) garment_id(value)
              WHERE garment_id.value = ANY(group_garment_text_ids)
           )
         )
         OR EXISTS (
           SELECT 1 FROM unnest(group_phones) phone(value)
            WHERE position(phone.value IN (
              COALESCE(audit_row.before_json, '') || COALESCE(audit_row.after_json, '')
            )) > 0
         )
       )
  ), bounded AS (
    SELECT source, entity_id, order_id, account_id, payload, recorded_at
      FROM narrative_rows
     ORDER BY recorded_at, source, entity_id
     LIMIT 1000
  )
  SELECT (SELECT count(*)::integer FROM narrative_rows),
         COALESCE(
           jsonb_agg(
             jsonb_build_object(
               'source', bounded.source,
               'entity_id', bounded.entity_id,
               'order_id', bounded.order_id,
               'account_id', bounded.account_id,
               'payload', bounded.payload,
               'recorded_at', extract(epoch FROM bounded.recorded_at)::bigint
             ) ORDER BY bounded.recorded_at, bounded.source, bounded.entity_id
           ),
           '[]'::jsonb
         )
    INTO related_narrative_count, related_narrative_rows
    FROM bounded;

  SELECT count(*)::integer
    INTO retained_garment_photo_count
    FROM garment_photos photo
    JOIN orders order_row
      ON order_row.org_id = photo.org_id
     AND order_row.store_id = photo.store_id
     AND order_row.id = photo.order_id
   WHERE photo.org_id = authority.org_id
     AND order_row.customer_id = ANY(group_ids);

  SELECT count(*)::integer INTO order_count
    FROM orders order_row
   WHERE order_row.org_id = authority.org_id
     AND order_row.customer_id = ANY(group_ids);
  SELECT COALESCE(jsonb_agg(to_jsonb(bounded) ORDER BY bounded.created_at DESC), '[]'::jsonb)
    INTO order_rows
    FROM (
      SELECT order_row.id AS order_id, order_row.store_id, order_row.ticket_no,
             order_row.status, order_row.customer_id, order_row.customer_phone,
             order_row.customer_name, order_row.note, order_row.payable_cents,
             order_row.paid_cents, order_row.balance_cents, order_row.business_date,
             order_row.customer_profile_version, order_row.discount_source,
             order_row.discount_bps, order_row.membership_version,
             order_row.tier_id, order_row.tier_definition_version,
             order_row.tier_code, order_row.tier_name, order_row.tier_level,
             order_row.tier_discount_bps, order_row.skip_ticket_print,
             order_row.skip_label_print, order_row.skip_rack_assignment,
             order_row.created_at,
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
         AND order_row.customer_id = ANY(group_ids)
       ORDER BY order_row.created_at DESC
       LIMIT 1000
    ) bounded;

  INSERT INTO customer_privacy_events (
    id, org_id, origin_store_id, customer_id, staff_id, action, reason,
    affected_order_count, created_at
  ) VALUES (
    event_id, authority.org_id, authority.store_id, root_id, authority.staff_id,
    'exported', btrim(requested_reason), order_count, requested_at
  );

  RETURN jsonb_build_object(
    'format_version', 2,
    'exported_at', extract(epoch FROM requested_at)::bigint,
    'customer', jsonb_build_object(
      'customer_id', root_customer.id,
      'phone', root_customer.phone,
      'name', root_customer.name,
      'note', root_customer.note,
      'created_at', extract(epoch FROM root_customer.created_at)::bigint,
      'updated_at', extract(epoch FROM root_customer.updated_at)::bigint
    ),
    'canonical_customers', COALESCE(canonical_customers, '[]'::jsonb),
    'canonical_customer_count', cardinality(group_ids),
    'profile', profile_json,
    'profiles', profile_rows,
    'profile_count', profile_count,
    'profiles_truncated', profile_count > 1000,
    'addresses', address_rows,
    'address_count', address_count,
    'addresses_truncated', address_count > 1000,
    'retired_address_count', retired_address_count,
    'identifiers', identifier_rows,
    'identifier_count', identifier_count,
    'identifiers_truncated', identifier_count > 1000,
    'retired_identifier_count', retired_identifier_count,
    'related_narratives', related_narrative_rows,
    'related_narrative_count', related_narrative_count,
    'related_narratives_truncated', related_narrative_count > 1000,
    'retained_garment_photo_count', retained_garment_photo_count,
    'orders', order_rows,
    'order_count', order_count,
    'truncated', order_count > 1000
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.customer_privacy_anonymize(
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
  root_id uuid;
  group_ids uuid[];
  group_text_ids text[];
  group_phones text[];
  group_order_ids uuid[] := ARRAY[]::uuid[];
  group_order_text_ids text[] := ARRAY[]::text[];
  group_account_ids uuid[] := ARRAY[]::uuid[];
  group_account_text_ids text[] := ARRAY[]::text[];
  group_garment_ids uuid[] := ARRAY[]::uuid[];
  group_garment_text_ids text[] := ARRAY[]::text[];
  related_audit_entity_ids text[] := ARRAY[]::text[];
  active_count integer;
  changed_count integer;
  privacy_redacted_text constant text := 'privacy_redacted';
  erased_result jsonb := jsonb_build_object(
    'ok', false,
    'error', jsonb_build_object(
      'code', 'CUSTOMER_ERASED',
      'message', 'Customer data was erased and cannot be recreated'
    )
  );
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

  -- Confirmation creation/consumption takes the same org lock before touching
  -- a pending row. Privacy then locks graph, phone namespace and domain rows.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('customer-privacy-pending:' || authority.org_id::text, 0)
  );
  PERFORM pg_advisory_xact_lock(hashtextextended(authority.org_id::text, 42));
  PERFORM pg_advisory_xact_lock(
    hashtextextended('customer-phone:' || authority.org_id::text, 0)
  );

  root_id := customer_canonical_root(requested_customer_id);
  IF root_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM customers root_customer
     WHERE root_customer.org_id = authority.org_id
       AND root_customer.id = root_id
       AND root_customer.merged_into_id IS NULL
       AND root_customer.anonymized_at IS NULL
  ) THEN
    RETURN;
  END IF;
  SELECT array_agg(group_row.group_customer_id)
    INTO group_ids
    FROM customer_canonical_group(root_id) group_row;
  SELECT array_agg(group_id::text) INTO group_text_ids FROM unnest(group_ids) group_id;

  SELECT array_agg(customer_row.phone)
    FILTER (WHERE customer_row.phone ~ '^1[3-9][0-9]{9}$')
    INTO group_phones
    FROM customers customer_row
   WHERE customer_row.org_id = authority.org_id
     AND customer_row.id = ANY(group_ids);

  PERFORM customer_row.id
    FROM customers customer_row
   WHERE customer_row.org_id = authority.org_id
     AND customer_row.id = ANY(group_ids)
   ORDER BY customer_row.id
   FOR UPDATE;

  -- The customer lock blocks new account/order anchors. Recompute the arrays
  -- only after it is held so no concurrent R2 write can escape this erasure.
  SELECT COALESCE(array_agg(account_row.id ORDER BY account_row.id), ARRAY[]::uuid[]),
         COALESCE(array_agg(account_row.id::text ORDER BY account_row.id), ARRAY[]::text[])
    INTO group_account_ids, group_account_text_ids
    FROM member_accounts account_row
   WHERE account_row.org_id = authority.org_id
     AND account_row.customer_id = ANY(group_ids);
  PERFORM account_row.id
    FROM member_accounts account_row
   WHERE account_row.org_id = authority.org_id
     AND account_row.customer_id = ANY(group_ids)
   ORDER BY account_row.customer_id, account_row.id
   FOR UPDATE;

  SELECT COALESCE(array_agg(order_row.id ORDER BY order_row.id), ARRAY[]::uuid[]),
         COALESCE(array_agg(order_row.id::text ORDER BY order_row.id), ARRAY[]::text[])
    INTO group_order_ids, group_order_text_ids
    FROM orders order_row
   WHERE order_row.org_id = authority.org_id
     AND order_row.customer_id = ANY(group_ids);

  -- Preserve the established print-row -> order-row lock order.
  PERFORM print_job.id
    FROM print_jobs print_job
    JOIN orders linked_order
      ON linked_order.org_id = print_job.org_id
     AND linked_order.store_id = print_job.store_id
     AND linked_order.id = print_job.order_id
   WHERE linked_order.org_id = authority.org_id
     AND linked_order.customer_id = ANY(group_ids)
     AND print_job.snapshot_json IS NOT NULL
   ORDER BY print_job.org_id, print_job.store_id, print_job.id
   FOR UPDATE OF print_job;
  PERFORM order_row.id
    FROM orders order_row
   WHERE order_row.org_id = authority.org_id
     AND order_row.customer_id = ANY(group_ids)
   ORDER BY order_row.org_id, order_row.store_id, order_row.id
   FOR UPDATE;

  -- An order lock blocks new linked garments. Resolve the final garment set
  -- after all order rows are locked, then lock garments deterministically.
  SELECT COALESCE(array_agg(garment_row.id ORDER BY garment_row.id), ARRAY[]::uuid[]),
         COALESCE(array_agg(garment_row.id::text ORDER BY garment_row.id), ARRAY[]::text[])
    INTO group_garment_ids, group_garment_text_ids
    FROM garments garment_row
   WHERE garment_row.org_id = authority.org_id
     AND garment_row.order_id = ANY(group_order_ids);
  PERFORM garment_row.id
    FROM garments garment_row
   WHERE garment_row.org_id = authority.org_id
     AND garment_row.id = ANY(group_garment_ids)
   ORDER BY garment_row.org_id, garment_row.store_id, garment_row.id
   FOR UPDATE;

  -- The org advisory lock prevents confirmation/create from taking a pending
  -- row while domain anchors are stabilized, so this final set cannot grow.
  PERFORM pending.nonce
    FROM ai_pending_actions pending
   WHERE pending.org_id = authority.org_id
     AND (
       pending.privacy_subject_customer_id = ANY(group_ids)
       OR pending.args_json ->> 'customer_id' = ANY(group_text_ids)
       OR pending.args_json ->> 'source_customer_id' = ANY(group_text_ids)
       OR pending.args_json ->> 'target_customer_id' = ANY(group_text_ids)
       OR pending.args_json ->> 'phone' = ANY(group_phones)
       OR pending.args_json ->> 'customer_phone' = ANY(group_phones)
       OR CASE
         WHEN pending.args_json ->> 'phone' ~ '^1[3-9][0-9]{9}$' THEN EXISTS (
           SELECT 1
             FROM customer_phone_history history
            WHERE history.org_id = authority.org_id
              AND history.customer_id = ANY(group_ids)
              AND history.phone_hmac = customer_phone_hmac(
                authority.org_id,
                pending.args_json ->> 'phone'
              )
         )
         ELSE false
       END
       OR CASE
         WHEN pending.args_json ->> 'customer_phone' ~ '^1[3-9][0-9]{9}$' THEN EXISTS (
           SELECT 1
             FROM customer_phone_history history
            WHERE history.org_id = authority.org_id
              AND history.customer_id = ANY(group_ids)
              AND history.phone_hmac = customer_phone_hmac(
                authority.org_id,
                pending.args_json ->> 'customer_phone'
              )
         )
         ELSE false
       END
       OR pending.args_json ->> 'order_id' = ANY(group_order_text_ids)
       OR EXISTS (
         SELECT 1
           FROM jsonb_array_elements_text(
             CASE
               WHEN jsonb_typeof(pending.args_json -> 'order_ids') = 'array'
               THEN pending.args_json -> 'order_ids'
               ELSE '[]'::jsonb
             END
           ) order_arg(value)
          WHERE order_arg.value = ANY(group_order_text_ids)
       )
       OR pending.args_json ->> 'account_id' = ANY(group_account_text_ids)
       OR pending.args_json ->> 'garment_id' = ANY(group_garment_text_ids)
       OR EXISTS (
         SELECT 1
           FROM (
             SELECT card.account_id
               FROM punch_cards card
              WHERE card.org_id = authority.org_id
                AND card.id::text = pending.args_json #>> '{asset,asset_id}'
             UNION ALL
             SELECT grant_row.account_id
               FROM coupon_grants grant_row
              WHERE grant_row.org_id = authority.org_id
                AND grant_row.id::text = pending.args_json #>> '{asset,asset_id}'
           ) asset
          WHERE asset.account_id = ANY(group_account_ids)
       )
       OR EXISTS (
         SELECT 1
           FROM jsonb_array_elements_text(
             CASE
               WHEN jsonb_typeof(pending.args_json -> 'garment_ids') = 'array'
               THEN pending.args_json -> 'garment_ids'
               ELSE '[]'::jsonb
             END
           ) garment_arg(value)
          WHERE garment_arg.value = ANY(group_garment_text_ids)
       )
     )
   ORDER BY pending.nonce
   FOR UPDATE;

  WITH related_entity(entity_id) AS (
    SELECT unnest(group_text_ids)
    UNION
    SELECT unnest(group_order_text_ids)
    UNION
    SELECT unnest(group_account_text_ids)
    UNION
    SELECT unnest(group_garment_text_ids)
    UNION
    SELECT payment.id::text
      FROM payments payment
     WHERE payment.org_id = authority.org_id
       AND payment.order_id = ANY(group_order_ids)
    UNION
    SELECT incident.id::text
      FROM garment_incidents incident
     WHERE incident.org_id = authority.org_id
       AND incident.order_id = ANY(group_order_ids)
    UNION
    SELECT photo.id::text
      FROM garment_photos photo
     WHERE photo.org_id = authority.org_id
       AND photo.order_id = ANY(group_order_ids)
    UNION
    SELECT print_job.id::text
      FROM print_jobs print_job
     WHERE print_job.org_id = authority.org_id
       AND print_job.order_id = ANY(group_order_ids)
    UNION
    SELECT ledger.id::text
      FROM member_ledger ledger
     WHERE ledger.org_id = authority.org_id
       AND (
         ledger.account_id = ANY(group_account_ids)
         OR ledger.order_id = ANY(group_order_ids)
       )
    UNION
    SELECT ledger.id::text
      FROM points_ledger ledger
     WHERE ledger.org_id = authority.org_id
       AND (
         ledger.account_id = ANY(group_account_ids)
         OR ledger.order_id = ANY(group_order_ids)
       )
    UNION
    SELECT card.id::text
      FROM punch_cards card
     WHERE card.org_id = authority.org_id
       AND card.account_id = ANY(group_account_ids)
    UNION
    SELECT ledger.id::text
      FROM punch_card_ledger ledger
     WHERE ledger.org_id = authority.org_id
       AND ledger.account_id = ANY(group_account_ids)
    UNION
    SELECT grant_row.id::text
      FROM coupon_grants grant_row
     WHERE grant_row.org_id = authority.org_id
       AND grant_row.account_id = ANY(group_account_ids)
    UNION
    SELECT redemption.id::text
      FROM coupon_redemptions redemption
     WHERE redemption.org_id = authority.org_id
       AND (
         redemption.account_id = ANY(group_account_ids)
         OR redemption.order_id = ANY(group_order_ids)
       )
    UNION
    SELECT reversal.id::text
      FROM coupon_redemption_reversals reversal
     WHERE reversal.org_id = authority.org_id
       AND reversal.order_id = ANY(group_order_ids)
  )
  SELECT COALESCE(array_agg(entity_id ORDER BY entity_id), ARRAY[]::text[])
    INTO related_audit_entity_ids
    FROM related_entity;

  SELECT count(*)::integer INTO active_count
    FROM orders order_row
   WHERE order_row.org_id = authority.org_id
     AND order_row.customer_id = ANY(group_ids)
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

  INSERT INTO customer_erasure_tombstones (
    org_id, phone_hmac, customer_id, erased_at, erased_by_staff_id
  )
  SELECT history.org_id, history.phone_hmac, history.customer_id,
         requested_at, authority.staff_id
    FROM customer_phone_history history
   WHERE history.org_id = authority.org_id
     AND history.customer_id = ANY(group_ids)
  ON CONFLICT (org_id, phone_hmac) DO NOTHING;

  DELETE FROM ai_pending_actions pending
   WHERE pending.org_id = authority.org_id
     AND (
       pending.privacy_subject_customer_id = ANY(group_ids)
       OR pending.args_json ->> 'customer_id' = ANY(group_text_ids)
       OR pending.args_json ->> 'source_customer_id' = ANY(group_text_ids)
       OR pending.args_json ->> 'target_customer_id' = ANY(group_text_ids)
       OR pending.args_json ->> 'phone' = ANY(group_phones)
       OR pending.args_json ->> 'customer_phone' = ANY(group_phones)
       OR CASE
         WHEN pending.args_json ->> 'phone' ~ '^1[3-9][0-9]{9}$' THEN EXISTS (
           SELECT 1
             FROM customer_phone_history history
            WHERE history.org_id = authority.org_id
              AND history.customer_id = ANY(group_ids)
              AND history.phone_hmac = customer_phone_hmac(
                authority.org_id,
                pending.args_json ->> 'phone'
              )
         )
         ELSE false
       END
       OR CASE
         WHEN pending.args_json ->> 'customer_phone' ~ '^1[3-9][0-9]{9}$' THEN EXISTS (
           SELECT 1
             FROM customer_phone_history history
            WHERE history.org_id = authority.org_id
              AND history.customer_id = ANY(group_ids)
              AND history.phone_hmac = customer_phone_hmac(
                authority.org_id,
                pending.args_json ->> 'customer_phone'
              )
         )
         ELSE false
       END
       OR pending.args_json ->> 'order_id' = ANY(group_order_text_ids)
       OR EXISTS (
         SELECT 1
           FROM jsonb_array_elements_text(
             CASE
               WHEN jsonb_typeof(pending.args_json -> 'order_ids') = 'array'
               THEN pending.args_json -> 'order_ids'
               ELSE '[]'::jsonb
             END
           ) order_arg(value)
          WHERE order_arg.value = ANY(group_order_text_ids)
       )
       OR pending.args_json ->> 'account_id' = ANY(group_account_text_ids)
       OR pending.args_json ->> 'garment_id' = ANY(group_garment_text_ids)
       OR EXISTS (
         SELECT 1
           FROM (
             SELECT card.account_id
               FROM punch_cards card
              WHERE card.org_id = authority.org_id
                AND card.id::text = pending.args_json #>> '{asset,asset_id}'
             UNION ALL
             SELECT grant_row.account_id
               FROM coupon_grants grant_row
              WHERE grant_row.org_id = authority.org_id
                AND grant_row.id::text = pending.args_json #>> '{asset,asset_id}'
           ) asset
          WHERE asset.account_id = ANY(group_account_ids)
       )
       OR EXISTS (
         SELECT 1
           FROM jsonb_array_elements_text(
             CASE
               WHEN jsonb_typeof(pending.args_json -> 'garment_ids') = 'array'
               THEN pending.args_json -> 'garment_ids'
               ELSE '[]'::jsonb
             END
           ) garment_arg(value)
          WHERE garment_arg.value = ANY(group_garment_text_ids)
       )
     );

  UPDATE command_idempotency idempotency
     SET result_json = erased_result,
         pii_purged_at = requested_at
   WHERE idempotency.org_id = authority.org_id
     AND idempotency.status = 'completed'
     AND (
       idempotency.privacy_subject_customer_id = ANY(group_ids)
       OR idempotency.result_json #>> '{data,result,customer_id}' = ANY(group_text_ids)
       OR idempotency.result_json #>> '{data,result,customer,customer_id}' = ANY(group_text_ids)
       OR idempotency.result_json #>> '{data,result,benefits,customer_id}' = ANY(group_text_ids)
       OR (
         idempotency.command = 'notification.manual_list.create'
         AND EXISTS (
           SELECT 1
             FROM jsonb_array_elements(
               CASE
                 WHEN jsonb_typeof(idempotency.result_json #> '{data,result,rows}') = 'array'
                 THEN idempotency.result_json #> '{data,result,rows}'
                 ELSE '[]'::jsonb
               END
             ) result_row(value)
             CROSS JOIN LATERAL jsonb_array_elements_text(
               CASE
                 WHEN jsonb_typeof(result_row.value -> 'order_ids') = 'array'
                 THEN result_row.value -> 'order_ids'
                 ELSE '[]'::jsonb
               END
             ) order_id(value)
            WHERE order_id.value = ANY(group_order_text_ids)
         )
       )
     );

  UPDATE edge_replay_records replay
     SET result_json = erased_result,
         pii_purged_at = requested_at
   WHERE replay.org_id = authority.org_id
     AND (
       replay.privacy_subject_customer_id = ANY(group_ids)
       OR replay.result_json #>> '{data,result,customer_id}' = ANY(group_text_ids)
       OR replay.result_json #>> '{data,result,customer,customer_id}' = ANY(group_text_ids)
       OR replay.result_json #>> '{data,result,benefits,customer_id}' = ANY(group_text_ids)
       OR (
         replay.command = 'notification.manual_list.create'
         AND EXISTS (
           SELECT 1
             FROM jsonb_array_elements(
               CASE
                 WHEN jsonb_typeof(replay.result_json #> '{data,result,rows}') = 'array'
                 THEN replay.result_json #> '{data,result,rows}'
                 ELSE '[]'::jsonb
               END
             ) result_row(value)
             CROSS JOIN LATERAL jsonb_array_elements_text(
               CASE
                 WHEN jsonb_typeof(result_row.value -> 'order_ids') = 'array'
                 THEN result_row.value -> 'order_ids'
                 ELSE '[]'::jsonb
               END
             ) order_id(value)
            WHERE order_id.value = ANY(group_order_text_ids)
         )
       )
     );

  UPDATE audit_log audit_row
     SET before_json = CASE
           WHEN audit_row.before_json IS NULL THEN NULL
           ELSE '{"privacy_redacted":true}'
         END,
         after_json = CASE
           WHEN audit_row.after_json IS NULL THEN '{"privacy_redacted":true}'
           ELSE '{"privacy_redacted":true}'
         END
     WHERE audit_row.org_id = authority.org_id
     AND (
       audit_row.entity_id = ANY(related_audit_entity_ids)
       OR (
         audit_row.entity = 'garment_batch'
         AND audit_row.after_json IS NOT NULL
         AND EXISTS (
           SELECT 1
             FROM jsonb_array_elements_text(
               CASE
                 WHEN jsonb_typeof(audit_row.after_json::jsonb -> 'garment_ids') = 'array'
                 THEN audit_row.after_json::jsonb -> 'garment_ids'
                 ELSE '[]'::jsonb
               END
             ) garment_id(value)
            WHERE garment_id.value = ANY(group_garment_text_ids)
         )
       )
       OR EXISTS (
         SELECT 1
           FROM unnest(group_phones) phone(value)
          WHERE position(phone.value IN (
            COALESCE(audit_row.before_json, '') || COALESCE(audit_row.after_json, '')
          )) > 0
       )
     );

  -- Redact customer-scoped narrative fields while retaining immutable money,
  -- status, quantity, timestamp and opaque-ID evidence.
  UPDATE payments payment
     SET note = NULL
   WHERE payment.org_id = authority.org_id
     AND payment.order_id = ANY(group_order_ids)
     AND payment.note IS NOT NULL;

  UPDATE order_lines line
     SET garment_details_json = customer_redact_garment_details(line.garment_details_json)
   WHERE line.org_id = authority.org_id
     AND line.order_id = ANY(group_order_ids);

  UPDATE garments garment
     SET defects = '[]'::jsonb,
         accessories = '[]'::jsonb,
         note = NULL,
         customer_pii_purged_at = COALESCE(garment.customer_pii_purged_at, requested_at)
   WHERE garment.org_id = authority.org_id
     AND garment.id = ANY(group_garment_ids);

  UPDATE garment_status_log status_row
     SET reason = NULL
   WHERE status_row.org_id = authority.org_id
     AND status_row.order_id = ANY(group_order_ids)
     AND status_row.reason IS NOT NULL;

  UPDATE garment_incidents incident
     SET note = privacy_redacted_text
   WHERE incident.org_id = authority.org_id
     AND incident.order_id = ANY(group_order_ids)
     AND incident.note <> privacy_redacted_text;

  UPDATE member_accounts account_row
     SET status_reason = CASE
           WHEN account_row.status_reason IS NULL THEN NULL
           ELSE privacy_redacted_text
         END,
         customer_pii_purged_at = COALESCE(account_row.customer_pii_purged_at, requested_at)
   WHERE account_row.org_id = authority.org_id
     AND account_row.id = ANY(group_account_ids)
     AND (
       account_row.customer_pii_purged_at IS NULL
       OR account_row.status_reason IS DISTINCT FROM CASE
         WHEN account_row.status_reason IS NULL THEN NULL
         ELSE privacy_redacted_text
       END
     );

  UPDATE member_ledger ledger
     SET note = NULL
   WHERE ledger.org_id = authority.org_id
     AND (
       ledger.account_id = ANY(group_account_ids)
       OR ledger.order_id = ANY(group_order_ids)
     )
     AND ledger.note IS NOT NULL;

  UPDATE member_memberships membership
     SET reason = privacy_redacted_text
   WHERE membership.org_id = authority.org_id
     AND membership.account_id = ANY(group_account_ids)
     AND membership.reason <> privacy_redacted_text;

  UPDATE points_ledger ledger
     SET note = CASE WHEN ledger.kind = 'redeem' THEN privacy_redacted_text ELSE NULL END
   WHERE ledger.org_id = authority.org_id
     AND (
       ledger.account_id = ANY(group_account_ids)
       OR ledger.order_id = ANY(group_order_ids)
     )
     AND ledger.note IS DISTINCT FROM
       CASE WHEN ledger.kind = 'redeem' THEN privacy_redacted_text ELSE NULL END;

  UPDATE punch_cards card
     SET reason = privacy_redacted_text
   WHERE card.org_id = authority.org_id
     AND card.account_id = ANY(group_account_ids)
     AND card.reason <> privacy_redacted_text;

  UPDATE punch_card_ledger ledger
     SET reason = privacy_redacted_text
   WHERE ledger.org_id = authority.org_id
     AND ledger.account_id = ANY(group_account_ids)
     AND ledger.reason <> privacy_redacted_text;

  UPDATE coupon_grants grant_row
     SET reason = privacy_redacted_text
   WHERE grant_row.org_id = authority.org_id
     AND grant_row.account_id = ANY(group_account_ids)
     AND grant_row.reason <> privacy_redacted_text;

  UPDATE coupon_redemption_reversals reversal
     SET reason = privacy_redacted_text
   WHERE reversal.org_id = authority.org_id
     AND reversal.order_id = ANY(group_order_ids)
     AND reversal.reason <> privacy_redacted_text;

  UPDATE customer_addresses address_row
     SET label = NULL,
         recipient = NULL,
         contact_phone = NULL,
         address_body = NULL,
         is_default = false,
         retired_at = COALESCE(address_row.retired_at, requested_at),
         pii_purged_at = COALESCE(address_row.pii_purged_at, requested_at),
         updated_at = requested_at
   WHERE address_row.org_id = authority.org_id
     AND address_row.customer_id = ANY(group_ids);

  UPDATE customer_identifiers identifier_row
     SET raw_value = NULL,
         normalized_value = NULL,
         retired_at = COALESCE(identifier_row.retired_at, requested_at),
         pii_purged_at = COALESCE(identifier_row.pii_purged_at, requested_at),
         updated_at = requested_at
   WHERE identifier_row.org_id = authority.org_id
     AND identifier_row.customer_id = ANY(group_ids);

  UPDATE customer_profiles profile
     SET service_note = NULL,
         updated_at = requested_at
   WHERE profile.org_id = authority.org_id
     AND profile.customer_id = ANY(group_ids);

  UPDATE orders order_row
     SET customer_phone = NULL,
         customer_name = NULL,
         note = NULL,
         customer_pii_purged_at = COALESCE(order_row.customer_pii_purged_at, requested_at),
         updated_at = requested_at
   WHERE order_row.org_id = authority.org_id
     AND order_row.customer_id = ANY(group_ids)
     AND order_row.status IN ('closed', 'cancelled');
  GET DIAGNOSTICS changed_count = ROW_COUNT;

  UPDATE print_jobs print_job
     SET snapshot_json = NULL,
         snapshot_purged_at = requested_at,
         updated_at = requested_at
    FROM orders linked_order
   WHERE linked_order.org_id = authority.org_id
     AND linked_order.customer_id = ANY(group_ids)
     AND print_job.org_id = linked_order.org_id
     AND print_job.store_id = linked_order.store_id
     AND print_job.order_id = linked_order.id
     AND print_job.status IN ('done', 'failed', 'uncertain')
     AND print_job.receipt_envelope_sha256 IS NOT NULL
     AND print_job.snapshot_json IS NOT NULL;

  UPDATE customers customer_row
     SET phone = 'anon-' || replace(customer_row.id::text, '-', ''),
         name = NULL,
         note = NULL,
         anonymized_at = requested_at,
         anonymized_by_staff_id = authority.staff_id,
         updated_at = requested_at,
         version = customer_row.version + 1
   WHERE customer_row.org_id = authority.org_id
     AND customer_row.id = ANY(group_ids);

  INSERT INTO customer_privacy_events (
    id, org_id, origin_store_id, customer_id, staff_id, action, reason,
    affected_order_count, created_at
  ) VALUES (
    event_id, authority.org_id, authority.store_id, root_id, authority.staff_id,
    'anonymized', btrim(requested_reason), changed_count, requested_at
  );
  RETURN QUERY SELECT true, changed_count, 0;
END;
$$;

REVOKE ALL ON FUNCTION public.customer_privacy_status(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.customer_privacy_export(uuid, text, uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.customer_privacy_anonymize(uuid, text, uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.customer_privacy_status(uuid) TO laundry_app;
GRANT EXECUTE ON FUNCTION public.customer_privacy_export(uuid, text, uuid, timestamptz) TO laundry_app;
GRANT EXECUTE ON FUNCTION public.customer_privacy_anonymize(uuid, text, uuid, timestamptz) TO laundry_app;
