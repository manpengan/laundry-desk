-- ADR-56 / Stage 4.4 Item 11. The customer portal reads the existing 0032
-- stored-value ledger and 0050 benefit assets. Its only write surface is a
-- bounded portal-owned address set plus notification preference CAS.

ALTER TABLE public.customer_addresses
  ADD COLUMN IF NOT EXISTS portal_managed boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS customer_addresses_portal_active_idx
  ON public.customer_addresses (org_id, customer_id, portal_managed, created_at, id)
  WHERE retired_at IS NULL;

CREATE TABLE IF NOT EXISTS public.customer_portal_preferences (
  org_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  version integer NOT NULL,
  preferred_contact text NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT customer_portal_preferences_pkey PRIMARY KEY (org_id, customer_id),
  CONSTRAINT customer_portal_preferences_customer_fk
    FOREIGN KEY (org_id, customer_id) REFERENCES public.customers (org_id, id),
  CONSTRAINT customer_portal_preferences_version_chk CHECK (version > 0),
  CONSTRAINT customer_portal_preferences_contact_chk
    CHECK (preferred_contact IN ('none', 'phone', 'sms', 'wechat'))
);

ALTER TABLE public.customer_portal_access_log
  ADD COLUMN IF NOT EXISTS address_count integer,
  ADD COLUMN IF NOT EXISTS preference text,
  ADD COLUMN IF NOT EXISTS profile_version integer;

-- Compatibility-only broadening: Item 11 adds three reads and one bounded
-- profile mutation while retaining every Item 10 operation.
ALTER TABLE public.customer_portal_access_log DROP CONSTRAINT IF EXISTS customer_portal_access_log_operation_chk;
ALTER TABLE public.customer_portal_access_log
  ADD CONSTRAINT customer_portal_access_log_operation_chk CHECK (operation IN (
    'auth.login', 'auth.logout', 'orders.list', 'order.get', 'receipt.get',
    'garments.list', 'garment.progress', 'wallet.get', 'benefits.get',
    'profile.get', 'profile.update'
  ));

ALTER TABLE public.customer_portal_access_log
  ADD CONSTRAINT customer_portal_access_log_profile_shape_chk CHECK (
    (
      operation = 'profile.update'
      AND resource_id IS NULL
      AND address_count BETWEEN 0 AND 10
      AND preference IN ('none', 'phone', 'sms', 'wechat')
      AND profile_version > 0
    )
    OR
    (
      operation <> 'profile.update'
      AND address_count IS NULL
      AND preference IS NULL
      AND profile_version IS NULL
    )
  );

-- laundry_app retains the ordinary staff profile grant from 0051. It cannot
-- forge, edit, retire or delete portal-owned rows; only the definer CAS below
-- may do so. Owner privacy erasure remains able to purge every address.
CREATE OR REPLACE FUNCTION public.reject_direct_customer_portal_address_dml()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF current_user <> 'laundry_app' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF (TG_OP = 'INSERT' AND NEW.portal_managed)
     OR (TG_OP = 'UPDATE' AND (OLD.portal_managed OR NEW.portal_managed))
     OR (TG_OP = 'DELETE' AND OLD.portal_managed) THEN
    RAISE insufficient_privilege USING MESSAGE = 'CUSTOMER_PORTAL_ADDRESS_DML_DENIED';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS customer_addresses_portal_dml_guard_trg ON public.customer_addresses;
CREATE TRIGGER customer_addresses_portal_dml_guard_trg
BEFORE INSERT OR UPDATE OR DELETE ON public.customer_addresses
FOR EACH ROW EXECUTE FUNCTION public.reject_direct_customer_portal_address_dml();

-- All projections are security-invoker views. Existing RLS remains
-- authoritative, and each view additionally binds the canonical customer and
-- enabled portal store injected by the server transaction.
CREATE OR REPLACE VIEW public.customer_portal_wallet
WITH (security_barrier = true, security_invoker = true) AS
SELECT account.id AS account_id,
       account.status AS account_status,
       COALESCE(sum(ledger.principal_delta_cents), 0)::bigint AS principal_cents,
       COALESCE(sum(ledger.bonus_delta_cents), 0)::bigint AS bonus_cents,
       COALESCE(sum(ledger.principal_delta_cents + ledger.bonus_delta_cents), 0)::bigint
         AS balance_cents
  FROM public.member_accounts account
  LEFT JOIN public.member_ledger ledger
    ON ledger.org_id = account.org_id AND ledger.account_id = account.id
 WHERE account.org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
   AND account.customer_id IN (
     SELECT group_row.group_customer_id FROM public.customer_canonical_group(
       NULLIF(current_setting('app.customer_id', true), '')::uuid
     ) group_row
   )
   AND account.customer_pii_purged_at IS NULL
   AND EXISTS (
     SELECT 1 FROM public.store_features feature
      WHERE feature.org_id = account.org_id
        AND feature.store_id = NULLIF(current_setting('app.store_id', true), '')::uuid
        AND feature.customer_portal
   )
 GROUP BY account.id, account.status;

CREATE OR REPLACE VIEW public.customer_portal_wallet_ledger
WITH (security_barrier = true, security_invoker = true) AS
SELECT ledger.account_id, ledger.id AS ledger_id, ledger.kind, ledger.principal_delta_cents,
       ledger.bonus_delta_cents, ledger.order_id, ledger.business_date, ledger.at
  FROM public.member_ledger ledger
  JOIN public.customer_portal_wallet wallet ON wallet.account_id = ledger.account_id
 WHERE ledger.org_id = NULLIF(current_setting('app.org_id', true), '')::uuid;

CREATE OR REPLACE VIEW public.customer_portal_membership
WITH (security_barrier = true, security_invoker = true) AS
SELECT membership.account_id, membership.tier_name AS name,
       membership.tier_level AS level, membership.valid_until,
       CASE WHEN membership.valid_until < store_day.business_date
            THEN 'expired' ELSE 'active' END AS status
  FROM public.member_memberships membership
  JOIN public.customer_portal_wallet wallet ON wallet.account_id = membership.account_id
  CROSS JOIN LATERAL (
    SELECT (statement_timestamp() AT TIME ZONE store.timezone)::date AS business_date
      FROM public.stores store
     WHERE store.org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
       AND store.id = NULLIF(current_setting('app.store_id', true), '')::uuid
  ) store_day
 WHERE membership.org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
   AND membership.tier_id IS NOT NULL;

CREATE OR REPLACE VIEW public.customer_portal_points
WITH (security_barrier = true, security_invoker = true) AS
SELECT wallet.account_id,
       COALESCE(sum(GREATEST(earn.points_delta - COALESCE(used.points, 0), 0)), 0)::bigint
         AS available_points
  FROM public.customer_portal_wallet wallet
  LEFT JOIN public.points_ledger earn
    ON earn.org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
   AND earn.account_id = wallet.account_id
   AND earn.kind = 'earn'
   AND earn.expires_on >= (
     SELECT (statement_timestamp() AT TIME ZONE store.timezone)::date
       FROM public.stores store
      WHERE store.org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
        AND store.id = NULLIF(current_setting('app.store_id', true), '')::uuid
   )
  LEFT JOIN LATERAL (
    SELECT COALESCE(sum(allocation.points), 0)::bigint AS points
      FROM public.points_allocations allocation
     WHERE allocation.org_id = earn.org_id AND allocation.earn_ledger_id = earn.id
  ) used ON true
 GROUP BY wallet.account_id;

CREATE OR REPLACE VIEW public.customer_portal_punch_cards
WITH (security_barrier = true, security_invoker = true) AS
SELECT card.id AS asset_id, card.name, card.total_uses,
       COALESCE(usage.used_uses, 0)::integer AS used_uses,
       GREATEST(card.total_uses - COALESCE(usage.used_uses, 0), 0)::integer
         AS remaining_uses,
       card.expires_on,
       CASE WHEN card.expires_on < store_day.business_date THEN 'expired'
            WHEN COALESCE(usage.used_uses, 0) >= card.total_uses THEN 'exhausted'
            ELSE 'active' END AS status
  FROM public.punch_cards card
  JOIN public.customer_portal_wallet wallet ON wallet.account_id = card.account_id
  CROSS JOIN LATERAL (
    SELECT (statement_timestamp() AT TIME ZONE store.timezone)::date AS business_date
      FROM public.stores store
     WHERE store.org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
       AND store.id = NULLIF(current_setting('app.store_id', true), '')::uuid
  ) store_day
  LEFT JOIN LATERAL (
    SELECT COALESCE(sum(ledger.uses), 0)::integer AS used_uses
      FROM public.punch_card_ledger ledger
     WHERE ledger.org_id = card.org_id AND ledger.card_id = card.id
  ) usage ON true
 WHERE card.org_id = NULLIF(current_setting('app.org_id', true), '')::uuid;

CREATE OR REPLACE VIEW public.customer_portal_coupons
WITH (security_barrier = true, security_invoker = true) AS
SELECT grant_row.id AS asset_id, grant_row.name, grant_row.discount_cents,
       grant_row.min_order_cents, grant_row.expires_on,
       CASE WHEN grant_row.expires_on < store_day.business_date THEN 'expired'
            WHEN redeemed.redeemed THEN 'redeemed' ELSE 'active' END AS status
  FROM public.coupon_grants grant_row
  JOIN public.customer_portal_wallet wallet ON wallet.account_id = grant_row.account_id
  CROSS JOIN LATERAL (
    SELECT (statement_timestamp() AT TIME ZONE store.timezone)::date AS business_date
      FROM public.stores store
     WHERE store.org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
       AND store.id = NULLIF(current_setting('app.store_id', true), '')::uuid
  ) store_day
  LEFT JOIN LATERAL (
    SELECT EXISTS (
      SELECT 1 FROM public.coupon_redemptions redemption
       WHERE redemption.org_id = grant_row.org_id AND redemption.grant_id = grant_row.id
         AND NOT EXISTS (
           SELECT 1 FROM public.coupon_redemption_reversals reversal
            WHERE reversal.org_id = redemption.org_id
              AND reversal.redemption_id = redemption.id
         )
    ) AS redeemed
  ) redeemed ON true
 WHERE grant_row.org_id = NULLIF(current_setting('app.org_id', true), '')::uuid;

CREATE OR REPLACE VIEW public.customer_portal_profile_preference
WITH (security_barrier = true, security_invoker = true) AS
SELECT COALESCE(portal_preference.version, 0)::integer AS version,
       COALESCE(portal_preference.preferred_contact,
                staff_preference.preferred_contact, 'none') AS preferred_contact
  FROM (SELECT 1) seed
  LEFT JOIN LATERAL (
    SELECT preference.version, preference.preferred_contact
      FROM public.customer_portal_preferences preference
     WHERE preference.org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
       AND preference.customer_id IN (
         SELECT group_row.group_customer_id FROM public.customer_canonical_group(
           NULLIF(current_setting('app.customer_id', true), '')::uuid
         ) group_row
       )
     ORDER BY preference.version DESC, preference.updated_at DESC, preference.customer_id
     LIMIT 1
  ) portal_preference ON true
  LEFT JOIN LATERAL (
    SELECT profile.preferred_contact
      FROM public.customer_profiles profile
     WHERE profile.org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
       AND profile.customer_id IN (
         SELECT group_row.group_customer_id FROM public.customer_canonical_group(
           NULLIF(current_setting('app.customer_id', true), '')::uuid
         ) group_row
       )
     ORDER BY profile.updated_at DESC, profile.customer_id
     LIMIT 1
  ) staff_preference ON true
 WHERE EXISTS (
   SELECT 1 FROM public.customers customer
    WHERE customer.org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
      AND customer.id = NULLIF(current_setting('app.customer_id', true), '')::uuid
      AND customer.merged_into_id IS NULL AND customer.anonymized_at IS NULL
 )
   AND EXISTS (
     SELECT 1 FROM public.store_features feature
      WHERE feature.org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
        AND feature.store_id = NULLIF(current_setting('app.store_id', true), '')::uuid
        AND feature.customer_portal
   );

CREATE OR REPLACE VIEW public.customer_portal_addresses
WITH (security_barrier = true, security_invoker = true) AS
SELECT address.id AS address_id, address.label, address.recipient,
       address.contact_phone, address.address_body AS address, address.is_default,
       CASE WHEN address.portal_managed THEN 'portal' ELSE 'store' END AS source,
       address.created_at
  FROM public.customer_addresses address
 WHERE address.org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
   AND address.customer_id IN (
     SELECT group_row.group_customer_id FROM public.customer_canonical_group(
       NULLIF(current_setting('app.customer_id', true), '')::uuid
     ) group_row
   )
   AND address.retired_at IS NULL AND address.pii_purged_at IS NULL
   AND EXISTS (
     SELECT 1 FROM public.store_features feature
      WHERE feature.org_id = address.org_id
        AND feature.store_id = NULLIF(current_setting('app.store_id', true), '')::uuid
        AND feature.customer_portal
   );

-- Bound future canonical merges. This trigger runs while the 0051 merge
-- function already owns the org advisory lock and deterministic customer locks.
CREATE OR REPLACE FUNCTION public.customer_portal_address_merge_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE source_root uuid; target_root uuid; group_ids uuid[];
        active_count integer; default_count integer;
BEGIN
  IF NEW.merged_into_id IS NULL OR NEW.merged_into_id IS NOT DISTINCT FROM OLD.merged_into_id THEN
    RETURN NEW;
  END IF;
  source_root := public.customer_canonical_root(OLD.id);
  target_root := public.customer_canonical_root(NEW.merged_into_id);
  SELECT array_agg(DISTINCT combined.group_customer_id)
    INTO group_ids
    FROM (
      SELECT group_row.group_customer_id
        FROM public.customer_canonical_group(source_root) group_row
      UNION
      SELECT group_row.group_customer_id
        FROM public.customer_canonical_group(target_root) group_row
    ) combined;
  SELECT count(*)::integer, count(*) FILTER (WHERE address.is_default)::integer
    INTO active_count, default_count
    FROM public.customer_addresses address
   WHERE address.org_id = NEW.org_id AND address.customer_id = ANY(group_ids)
     AND address.retired_at IS NULL AND address.pii_purged_at IS NULL;
  IF active_count > 10 OR default_count > 1 THEN
    RAISE integrity_constraint_violation USING MESSAGE = 'CUSTOMER_PORTAL_ADDRESS_MERGE_CONFLICT';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS customers_portal_address_merge_guard_trg ON public.customers;
CREATE TRIGGER customers_portal_address_merge_guard_trg
BEFORE UPDATE OF merged_into_id ON public.customers
FOR EACH ROW EXECUTE FUNCTION public.customer_portal_address_merge_guard();

CREATE OR REPLACE FUNCTION public.customer_portal_profile_update(
  requested_session_id uuid,
  requested_session_hash text,
  requested_authority_hash text,
  requested_expected_version integer,
  requested_preferred_contact text,
  requested_addresses jsonb
)
RETURNS TABLE (version integer, preferred_contact text, address_count integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  requested_org uuid := NULLIF(current_setting('app.org_id', true), '')::uuid;
  requested_store uuid := NULLIF(current_setting('app.store_id', true), '')::uuid;
  requested_customer uuid := NULLIF(current_setting('app.customer_id', true), '')::uuid;
  root_id uuid; group_ids uuid[]; current_version integer; next_version integer;
  preserved_count integer; preserved_defaults integer; requested_defaults integer;
  now_value timestamptz := statement_timestamp();
BEGIN
  IF requested_org IS NULL OR requested_store IS NULL OR requested_customer IS NULL THEN
    RAISE insufficient_privilege USING MESSAGE = 'CUSTOMER_PORTAL_AUTHORITY_UNAVAILABLE';
  END IF;
  IF requested_expected_version IS NULL OR requested_expected_version < 0
     OR requested_preferred_contact IS NULL
     OR requested_preferred_contact NOT IN ('none', 'phone', 'sms', 'wechat')
     OR requested_addresses IS NULL
     OR jsonb_typeof(requested_addresses) IS DISTINCT FROM 'array'
     OR jsonb_array_length(requested_addresses) > 10 THEN
    RAISE invalid_parameter_value USING MESSAGE = 'CUSTOMER_PORTAL_PROFILE_INVALID';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(requested_addresses) address
     WHERE jsonb_typeof(address) IS DISTINCT FROM 'object'
        OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(address) key)
           IS DISTINCT FROM ARRAY['address', 'contact_phone', 'is_default', 'label', 'recipient']
        OR jsonb_typeof(address -> 'label') IS DISTINCT FROM 'string'
        OR char_length(btrim(address ->> 'label')) NOT BETWEEN 1 AND 32
        OR jsonb_typeof(address -> 'address') IS DISTINCT FROM 'string'
        OR char_length(btrim(address ->> 'address')) NOT BETWEEN 1 AND 256
        OR jsonb_typeof(address -> 'is_default') IS DISTINCT FROM 'boolean'
        OR jsonb_typeof(address -> 'recipient') NOT IN ('string', 'null')
        OR (jsonb_typeof(address -> 'recipient') = 'string'
            AND char_length(btrim(address ->> 'recipient')) NOT BETWEEN 1 AND 64)
        OR jsonb_typeof(address -> 'contact_phone') NOT IN ('string', 'null')
        OR (jsonb_typeof(address -> 'contact_phone') = 'string'
            AND ((address ->> 'contact_phone') !~ '^[+0-9() -]+$'
                 OR char_length(address ->> 'contact_phone') NOT BETWEEN 1 AND 32))
  ) THEN
    RAISE invalid_parameter_value USING MESSAGE = 'CUSTOMER_PORTAL_PROFILE_INVALID';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(requested_org::text, 42));
  IF NOT public.customer_portal_session_validate(
    requested_session_id, requested_session_hash, requested_authority_hash
  ) THEN
    RAISE invalid_authorization_specification USING MESSAGE = 'CUSTOMER_PORTAL_SESSION_INVALID';
  END IF;
  root_id := public.customer_canonical_root(requested_customer);
  IF root_id IS NULL OR root_id <> requested_customer THEN
    RAISE invalid_authorization_specification USING MESSAGE = 'CUSTOMER_PORTAL_SESSION_INVALID';
  END IF;
  SELECT array_agg(group_row.group_customer_id ORDER BY group_row.group_customer_id)
    INTO group_ids FROM public.customer_canonical_group(root_id) group_row;
  PERFORM customer.id FROM public.customers customer
   WHERE customer.org_id = requested_org AND customer.id = ANY(group_ids)
   ORDER BY customer.id FOR UPDATE;
  PERFORM preference.customer_id FROM public.customer_portal_preferences preference
   WHERE preference.org_id = requested_org AND preference.customer_id = ANY(group_ids)
   ORDER BY preference.customer_id FOR UPDATE;
  PERFORM address.id FROM public.customer_addresses address
   WHERE address.org_id = requested_org AND address.customer_id = ANY(group_ids)
   ORDER BY address.customer_id, address.id FOR UPDATE;

  SELECT COALESCE(max(preference.version), 0)::integer INTO current_version
    FROM public.customer_portal_preferences preference
   WHERE preference.org_id = requested_org AND preference.customer_id = ANY(group_ids);
  IF current_version <> requested_expected_version THEN
    RAISE serialization_failure USING MESSAGE = 'CUSTOMER_PORTAL_PROFILE_STALE';
  END IF;
  SELECT count(*)::integer, count(*) FILTER (WHERE address.is_default)::integer
    INTO preserved_count, preserved_defaults
    FROM public.customer_addresses address
   WHERE address.org_id = requested_org AND address.customer_id = ANY(group_ids)
     AND NOT address.portal_managed
     AND address.retired_at IS NULL AND address.pii_purged_at IS NULL;
  SELECT count(*) FILTER (WHERE (address ->> 'is_default')::boolean)::integer
    INTO requested_defaults FROM jsonb_array_elements(requested_addresses) address;
  IF preserved_count + jsonb_array_length(requested_addresses) > 10
     OR preserved_defaults + requested_defaults > 1 THEN
    RAISE serialization_failure USING MESSAGE = 'CUSTOMER_PORTAL_PROFILE_CONFLICT';
  END IF;

  next_version := current_version + 1;
  INSERT INTO public.customer_portal_preferences (
    org_id, customer_id, version, preferred_contact, updated_at
  ) VALUES (requested_org, root_id, next_version, requested_preferred_contact, now_value)
  ON CONFLICT (org_id, customer_id) DO UPDATE
    SET version = EXCLUDED.version,
        preferred_contact = EXCLUDED.preferred_contact,
        updated_at = EXCLUDED.updated_at;

  UPDATE public.customer_addresses address
     SET label = NULL, recipient = NULL, contact_phone = NULL, address_body = NULL,
         is_default = false, retired_at = now_value, pii_purged_at = now_value,
         updated_at = now_value
   WHERE address.org_id = requested_org AND address.customer_id = ANY(group_ids)
     AND address.portal_managed AND address.retired_at IS NULL;

  INSERT INTO public.customer_addresses (
    id, org_id, customer_id, profile_version, label, recipient, contact_phone,
    address_body, is_default, retired_at, pii_purged_at, created_at, updated_at,
    portal_managed
  )
  SELECT gen_random_uuid(), requested_org, root_id, next_version,
         btrim(address.label), NULLIF(btrim(address.recipient), ''),
         NULLIF(address.contact_phone, ''), btrim(address.address), address.is_default,
         NULL, NULL, now_value, now_value, true
    FROM jsonb_to_recordset(requested_addresses) AS address(
      label text, recipient text, contact_phone text, address text, is_default boolean
    );

  INSERT INTO public.customer_portal_access_log (
    id, org_id, store_id, customer_id, session_id, operation, resource_id, at,
    address_count, preference, profile_version
  ) VALUES (
    gen_random_uuid(), requested_org, requested_store, root_id, requested_session_id,
    'profile.update', NULL, now_value,
    preserved_count + jsonb_array_length(requested_addresses),
    requested_preferred_contact, next_version
  );
  RETURN QUERY SELECT next_version, requested_preferred_contact,
    preserved_count + jsonb_array_length(requested_addresses);
END;
$$;

ALTER TABLE public.customer_portal_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_portal_preferences FORCE ROW LEVEL SECURITY;
CREATE POLICY customer_portal_preferences_org_read ON public.customer_portal_preferences
  AS PERMISSIVE FOR SELECT TO laundry_app USING (
    org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND customer_id IN (
      SELECT group_row.group_customer_id FROM public.customer_canonical_group(
        NULLIF(current_setting('app.customer_id', true), '')::uuid
      ) group_row
    )
  );
CREATE POLICY customer_portal_preferences_maintenance ON public.customer_portal_preferences
  AS PERMISSIVE FOR ALL TO laundry_owner USING (true) WITH CHECK (true);

REVOKE ALL ON TABLE public.customer_portal_preferences FROM PUBLIC, laundry_app;
GRANT SELECT ON TABLE public.customer_portal_preferences TO laundry_app;
REVOKE ALL ON public.customer_portal_wallet, public.customer_portal_wallet_ledger,
  public.customer_portal_membership, public.customer_portal_points,
  public.customer_portal_punch_cards, public.customer_portal_coupons,
  public.customer_portal_profile_preference, public.customer_portal_addresses
  FROM PUBLIC, laundry_app;
GRANT SELECT ON public.customer_portal_wallet, public.customer_portal_wallet_ledger,
  public.customer_portal_membership, public.customer_portal_points,
  public.customer_portal_punch_cards, public.customer_portal_coupons,
  public.customer_portal_profile_preference, public.customer_portal_addresses
  TO laundry_app;

REVOKE ALL ON FUNCTION public.reject_direct_customer_portal_address_dml() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.customer_portal_address_merge_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.customer_portal_profile_update(uuid, text, text, integer, text, jsonb)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.customer_portal_profile_update(uuid, text, text, integer, text, jsonb)
  TO laundry_app;
