-- ADR-86: immutable customer/delegation receipt and business mutation commit together.
CREATE TABLE public.miniapp_profile_authority (
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  hmac_key bytea NOT NULL CHECK(octet_length(hmac_key)=32),
  PRIMARY KEY(org_id,store_id),
  FOREIGN KEY(org_id,store_id) REFERENCES stores(org_id,id)
);
ALTER TABLE public.miniapp_profile_authority ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.miniapp_profile_authority FORCE ROW LEVEL SECURITY;
CREATE POLICY miniapp_profile_authority_owner ON public.miniapp_profile_authority TO laundry_owner USING(true) WITH CHECK(true);
REVOKE ALL ON public.miniapp_profile_authority FROM PUBLIC,laundry_app;
CREATE TABLE public.miniapp_transaction_receipts (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  session_id uuid NOT NULL,
  delegated_staff_id uuid NOT NULL,
  config_version integer NOT NULL CHECK(config_version>0),
  permission_version integer NOT NULL CHECK(permission_version>0),
  action text NOT NULL CHECK(action IN ('appointments/create','appointments/cancel','payment/create','topup/create','balance/pay','benefits/coupon','benefits/punch','benefits/points','profile/update')),
  idempotency_key uuid NOT NULL,
  input_sha256 text NOT NULL CHECK(input_sha256 ~ '^[a-f0-9]{64}$'),
  result_json jsonb NOT NULL CHECK(jsonb_typeof(result_json)='object'),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE(org_id,store_id,customer_id,action,idempotency_key),
  FOREIGN KEY(org_id,store_id,session_id) REFERENCES miniapp_sessions(org_id,store_id,id),
  FOREIGN KEY(org_id,customer_id) REFERENCES customers(org_id,id),
  FOREIGN KEY(org_id,delegated_staff_id) REFERENCES staffs(org_id,id)
);
ALTER TABLE public.miniapp_transaction_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.miniapp_transaction_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON public.miniapp_transaction_receipts
  USING(org_id=NULLIF(current_setting('app.org_id',true),'')::uuid AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid)
  WITH CHECK(org_id=NULLIF(current_setting('app.org_id',true),'')::uuid AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid);
GRANT SELECT,INSERT ON public.miniapp_transaction_receipts TO laundry_app;
CREATE INDEX miniapp_receipts_session_idx ON public.miniapp_transaction_receipts(org_id,store_id,session_id);
GRANT SELECT(id,org_id,store_id,customer_id,delegated_staff_id,config_version,permission_version,action,result_json,created_at)
  ON public.miniapp_transaction_receipts TO laundry_store_exporter;
CREATE POLICY miniapp_receipts_export_reader ON public.miniapp_transaction_receipts FOR SELECT TO laundry_store_exporter
  USING(org_id=NULLIF(current_setting('app.org_id',true),'')::uuid AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid);
CREATE INDEX miniapp_receipts_staff_idx ON public.miniapp_transaction_receipts(org_id,delegated_staff_id);
CREATE OR REPLACE FUNCTION public.miniapp_profile_update(
  requested_session_id uuid,
  requested_expected_version integer,
  requested_preferred_contact text,
  requested_addresses jsonb,
  signed_payload text,
  signature_hex text
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
  authority_key bytea; claims jsonb; current_config integer;
BEGIN
  IF requested_org IS NULL OR requested_store IS NULL OR requested_customer IS NULL THEN
    RAISE insufficient_privilege USING MESSAGE = 'CUSTOMER_PORTAL_AUTHORITY_UNAVAILABLE';
  END IF;
  IF signed_payload IS NULL OR octet_length(signed_payload)>16384 OR signature_hex IS NULL OR signature_hex !~ '^[a-f0-9]{64}$' THEN
    RAISE insufficient_privilege USING MESSAGE='MINIAPP_PROFILE_PROOF_INVALID';
  END IF;
  SELECT key.hmac_key INTO authority_key FROM public.miniapp_profile_authority key WHERE key.org_id=requested_org AND key.store_id=requested_store;
  IF authority_key IS NULL OR encode(public.hmac(convert_to(signed_payload,'UTF8'),authority_key,'sha256'),'hex')<>signature_hex THEN
    RAISE insufficient_privilege USING MESSAGE='MINIAPP_PROFILE_PROOF_INVALID';
  END IF;
  claims:=signed_payload::jsonb;
  IF jsonb_typeof(claims->'expires_at_ms') IS DISTINCT FROM 'number' OR (claims->>'expires_at_ms') !~ '^[0-9]{1,16}$' THEN
    RAISE insufficient_privilege USING MESSAGE='MINIAPP_PROFILE_PROOF_INVALID';
  END IF;
  SELECT cfg.version INTO current_config FROM public.miniapp_settings cfg WHERE cfg.org_id=requested_org AND cfg.store_id=requested_store;
  IF (claims->>'expires_at_ms')::bigint < (extract(epoch FROM now_value)*1000)::bigint
     OR (claims->>'expires_at_ms')::bigint > (extract(epoch FROM now_value)*1000)::bigint+60000
     OR claims IS DISTINCT FROM jsonb_build_object('action','profile/update','org_id',requested_org,'store_id',requested_store,
       'session_id',requested_session_id,'customer_id',requested_customer,'staff_id',NULLIF(current_setting('app.staff_id',true),'')::uuid,
       'config_version',current_config,'expires_at_ms',(claims->>'expires_at_ms')::bigint,'expected_version',requested_expected_version,
       'preferred_contact',requested_preferred_contact,'addresses',requested_addresses) THEN
    RAISE insufficient_privilege USING MESSAGE='MINIAPP_PROFILE_PROOF_INVALID';
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
  IF NOT EXISTS (
    SELECT 1 FROM public.miniapp_sessions s
    JOIN public.miniapp_bindings b ON b.org_id=s.org_id AND b.store_id=s.store_id AND b.id=s.binding_id
    JOIN public.miniapp_settings cfg ON cfg.org_id=s.org_id AND cfg.store_id=s.store_id
    JOIN public.staffs staff ON staff.org_id=cfg.org_id AND staff.id=cfg.delegated_staff_id
    JOIN public.staff_store_roles role ON role.org_id=staff.org_id AND role.staff_id=staff.id AND role.store_id=cfg.store_id
    WHERE s.id=requested_session_id AND s.org_id=requested_org AND s.store_id=requested_store
      AND s.status='active' AND s.expires_at>statement_timestamp() AND b.status='active' AND b.customer_id=s.customer_id
      AND b.app_id=cfg.app_id AND cfg.enabled AND cfg.transactions_enabled AND cfg.version=s.config_version
      AND public.customer_canonical_root(s.customer_id)=requested_customer
      AND staff.id=NULLIF(current_setting('app.staff_id',true),'')::uuid AND staff.is_active AND role.is_active
      AND role.role IN ('admin','staff')
  ) THEN
    RAISE invalid_authorization_specification USING MESSAGE = 'MINIAPP_AUTHORITY_INVALID';
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

  RETURN QUERY SELECT next_version, requested_preferred_contact,
    preserved_count + jsonb_array_length(requested_addresses);
END;
$$;
REVOKE ALL ON FUNCTION public.miniapp_profile_update(uuid,integer,text,jsonb,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.miniapp_profile_update(uuid,integer,text,jsonb,text,text) TO laundry_app;

-- Shared safe projections serve independently authenticated miniapp sessions.
-- Legacy portal session validation still requires its own customer_portal feature flag.
CREATE OR REPLACE VIEW public.customer_portal_orders
WITH (security_barrier = true, security_invoker = true) AS
SELECT order_row.id AS order_id, order_row.ticket_no, order_row.status,
       order_row.original_cents, order_row.discount_cents, order_row.addon_cents,
       order_row.urgent_cents, order_row.freight_cents, order_row.payable_cents,
       order_row.paid_cents, order_row.balance_cents, order_row.business_date,
       order_row.created_at, order_row.updated_at,
       (SELECT count(*)::integer FROM public.garments garment_row
         WHERE garment_row.org_id = order_row.org_id
           AND garment_row.store_id = order_row.store_id
           AND garment_row.order_id = order_row.id) AS garment_count
  FROM public.orders order_row
 WHERE order_row.org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
   AND order_row.store_id = NULLIF(current_setting('app.store_id', true), '')::uuid
   AND order_row.customer_id IN (
     SELECT group_row.group_customer_id FROM public.customer_canonical_group(
       NULLIF(current_setting('app.customer_id', true), '')::uuid
     ) group_row
   )
   AND order_row.customer_pii_purged_at IS NULL
   AND order_row.ticket_no IS NOT NULL
   AND order_row.status IN ('open', 'closed', 'cancelled')
   AND EXISTS (
     SELECT 1 FROM public.store_features feature_row
      WHERE feature_row.org_id = order_row.org_id AND feature_row.store_id = order_row.store_id
        AND (feature_row.customer_portal OR EXISTS (
          SELECT 1 FROM public.miniapp_settings cfg
           WHERE cfg.org_id=feature_row.org_id AND cfg.store_id=feature_row.store_id AND cfg.enabled
        ))
   );

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
        AND (feature.customer_portal OR EXISTS (
          SELECT 1 FROM public.miniapp_settings cfg
           WHERE cfg.org_id=feature.org_id AND cfg.store_id=feature.store_id AND cfg.enabled
        ))
   )
 GROUP BY account.id, account.status;

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
        AND (feature.customer_portal OR EXISTS (
          SELECT 1 FROM public.miniapp_settings cfg
           WHERE cfg.org_id=feature.org_id AND cfg.store_id=feature.store_id AND cfg.enabled
        ))
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
        AND (feature.customer_portal OR EXISTS (
          SELECT 1 FROM public.miniapp_settings cfg
           WHERE cfg.org_id=feature.org_id AND cfg.store_id=feature.store_id AND cfg.enabled
        ))
   );
