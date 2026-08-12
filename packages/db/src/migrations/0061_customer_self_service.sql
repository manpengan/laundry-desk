-- ADR-55 / Stage 4.4 Item 10. Customer self-service is a dedicated, short-lived
-- browser authority. It projects existing orders, receipts and garment history;
-- no second order or receipt ledger is created.

ALTER TABLE public.store_features
  ADD COLUMN IF NOT EXISTS customer_portal boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS public.customer_portal_sessions (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  session_hash char(64) NOT NULL,
  csrf_hash char(64) NOT NULL,
  authority_hash char(64) NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CONSTRAINT customer_portal_sessions_tenant_id_uidx UNIQUE (org_id, store_id, id),
  CONSTRAINT customer_portal_sessions_hash_uidx UNIQUE (session_hash),
  CONSTRAINT customer_portal_sessions_store_fk
    FOREIGN KEY (org_id, store_id) REFERENCES public.stores (org_id, id),
  CONSTRAINT customer_portal_sessions_customer_fk
    FOREIGN KEY (org_id, customer_id) REFERENCES public.customers (org_id, id),
  CONSTRAINT customer_portal_sessions_hash_chk CHECK (
    session_hash ~ '^[0-9a-f]{64}$' AND csrf_hash ~ '^[0-9a-f]{64}$'
    AND authority_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT customer_portal_sessions_status_chk CHECK (status IN ('active', 'revoked')),
  CONSTRAINT customer_portal_sessions_time_chk CHECK (
    expires_at > created_at AND expires_at <= created_at + interval '15 minutes'
  ),
  CONSTRAINT customer_portal_sessions_revoke_chk CHECK (
    (status = 'active' AND revoked_at IS NULL)
    OR (status = 'revoked' AND revoked_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS customer_portal_sessions_expiry_idx
  ON public.customer_portal_sessions (org_id, store_id, expires_at)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS customer_portal_sessions_customer_idx
  ON public.customer_portal_sessions (org_id, store_id, customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS customer_portal_sessions_org_customer_idx
  ON public.customer_portal_sessions (org_id, customer_id, created_at DESC)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS public.customer_portal_access_log (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  session_id uuid NOT NULL,
  operation text NOT NULL,
  resource_id uuid,
  at timestamptz NOT NULL,
  CONSTRAINT customer_portal_access_log_tenant_id_uidx UNIQUE (org_id, store_id, id),
  CONSTRAINT customer_portal_access_log_store_fk
    FOREIGN KEY (org_id, store_id) REFERENCES public.stores (org_id, id),
  CONSTRAINT customer_portal_access_log_customer_fk
    FOREIGN KEY (org_id, customer_id) REFERENCES public.customers (org_id, id),
  CONSTRAINT customer_portal_access_log_session_fk
    FOREIGN KEY (org_id, store_id, session_id)
    REFERENCES public.customer_portal_sessions (org_id, store_id, id),
  CONSTRAINT customer_portal_access_log_operation_chk CHECK (operation IN (
    'auth.login', 'auth.logout', 'orders.list', 'order.get', 'receipt.get',
    'garments.list', 'garment.progress'
  ))
);

CREATE INDEX IF NOT EXISTS customer_portal_access_log_customer_at_idx
  ON public.customer_portal_access_log (org_id, store_id, customer_id, at DESC, id);

CREATE OR REPLACE FUNCTION public.reject_customer_portal_evidence_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE check_violation USING MESSAGE = 'CUSTOMER_PORTAL_EVIDENCE_IMMUTABLE';
END;
$$;

CREATE TRIGGER customer_portal_access_log_append_only_trg
  BEFORE UPDATE OR DELETE ON public.customer_portal_access_log
  FOR EACH ROW EXECUTE FUNCTION public.reject_customer_portal_evidence_mutation();

CREATE OR REPLACE FUNCTION public.customer_portal_session_create(
  requested_org_code text,
  requested_store_code text,
  requested_phone text,
  requested_pickup_code text,
  requested_session_hash text,
  requested_csrf_hash text,
  requested_authority_hash text
)
RETURNS TABLE (
  session_id uuid,
  org_id uuid,
  store_id uuid,
  customer_id uuid,
  csrf_hash text,
  authority_hash text,
  expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE requested_org uuid; requested_store uuid; matched_customer uuid;
        canonical_customer uuid; created_session uuid := gen_random_uuid();
        created_at_value timestamptz := statement_timestamp();
BEGIN
  IF requested_session_hash !~ '^[0-9a-f]{64}$'
     OR requested_csrf_hash !~ '^[0-9a-f]{64}$'
     OR requested_authority_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN;
  END IF;
  SELECT org_row.id, store_row.id, customer_row.id
    INTO requested_org, requested_store, matched_customer
    FROM public.orgs org_row
    JOIN public.stores store_row ON store_row.org_id = org_row.id
    JOIN public.store_features feature_row
      ON feature_row.org_id = store_row.org_id AND feature_row.store_id = store_row.id
    JOIN public.customers customer_row ON customer_row.org_id = org_row.id
   WHERE org_row.code = requested_org_code
     AND store_row.code = requested_store_code
     AND feature_row.customer_portal
     AND customer_row.phone = requested_phone
     AND customer_row.anonymized_at IS NULL
   LIMIT 1;
  IF requested_org IS NULL THEN RETURN; END IF;
  PERFORM set_config('app.org_id', requested_org::text, true);
  PERFORM set_config('app.store_id', requested_store::text, true);
  -- Serialize with canonical merges and concurrent portal logins before deriving
  -- the authority root or enforcing the five-session cap.
  PERFORM pg_advisory_xact_lock(hashtextextended(requested_org::text, 42));
  canonical_customer := public.customer_canonical_root(matched_customer);
  IF canonical_customer IS NULL THEN RETURN; END IF;
  PERFORM root_row.id
    FROM public.customers root_row
   WHERE root_row.org_id = requested_org AND root_row.id = canonical_customer
     AND root_row.anonymized_at IS NULL AND root_row.phone IS NOT NULL
   FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM public.orders order_row
     WHERE order_row.org_id = requested_org AND order_row.store_id = requested_store
       AND order_row.pickup_code = requested_pickup_code
       AND order_row.ticket_no IS NOT NULL
       AND order_row.customer_pii_purged_at IS NULL
       AND order_row.customer_id IN (
         SELECT group_row.group_customer_id
           FROM public.customer_canonical_group(canonical_customer) group_row
       )
  ) THEN
    RETURN;
  END IF;
  UPDATE public.customer_portal_sessions portal_session
     SET status = 'revoked', revoked_at = created_at_value
   WHERE portal_session.org_id = requested_org
     AND public.customer_canonical_root(portal_session.customer_id) = canonical_customer
     AND portal_session.status = 'active'
     AND portal_session.expires_at <= created_at_value;
  -- A merge can combine two roots that each already had five sessions. Keep
  -- only the four newest across the entire canonical group before inserting.
  UPDATE public.customer_portal_sessions portal_session
     SET status = 'revoked', revoked_at = created_at_value
   WHERE portal_session.id IN (
     SELECT excess_session.id
       FROM public.customer_portal_sessions excess_session
      WHERE excess_session.org_id = requested_org
        AND public.customer_canonical_root(excess_session.customer_id) = canonical_customer
        AND excess_session.status = 'active'
      ORDER BY excess_session.created_at DESC, excess_session.id DESC
      OFFSET 4
      FOR UPDATE
   );
  INSERT INTO public.customer_portal_sessions (
    id, org_id, store_id, customer_id, session_hash, csrf_hash, authority_hash, status,
    created_at, expires_at, revoked_at
  ) VALUES (
    created_session, requested_org, requested_store, canonical_customer,
    requested_session_hash, requested_csrf_hash, requested_authority_hash, 'active', created_at_value,
    created_at_value + interval '15 minutes', NULL
  );
  INSERT INTO public.customer_portal_access_log (
    id, org_id, store_id, customer_id, session_id, operation, resource_id, at
  ) VALUES (
    gen_random_uuid(), requested_org, requested_store, canonical_customer,
    created_session, 'auth.login', NULL, created_at_value
  );
  RETURN QUERY SELECT created_session, requested_org, requested_store, canonical_customer,
    requested_csrf_hash, requested_authority_hash, created_at_value + interval '15 minutes';
END;
$$;

-- Canonical merge is authoritative after this migration too: merging two
-- roots must not create a window with more than five live portal sessions.
CREATE OR REPLACE FUNCTION public.customer_portal_cap_sessions_after_merge()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE requested_org uuid := NULLIF(current_setting('app.org_id', true), '')::uuid;
        canonical_customer uuid; revoked_at_value timestamptz := statement_timestamp();
BEGIN
  IF requested_org IS NULL OR requested_org <> NEW.org_id THEN
    RAISE insufficient_privilege USING MESSAGE = 'customer merge authority unavailable';
  END IF;
  canonical_customer := public.customer_canonical_root(NEW.id);
  IF canonical_customer IS NULL THEN RETURN NEW; END IF;
  UPDATE public.customer_portal_sessions portal_session
     SET status = 'revoked', revoked_at = revoked_at_value
   WHERE portal_session.id IN (
     SELECT excess_session.id
       FROM public.customer_portal_sessions excess_session
      WHERE excess_session.org_id = requested_org
        AND public.customer_canonical_root(excess_session.customer_id) = canonical_customer
        AND excess_session.status = 'active'
      ORDER BY excess_session.created_at DESC, excess_session.id DESC
      OFFSET 5
      FOR UPDATE
   );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS customers_portal_session_cap_after_merge_trg ON public.customers;
CREATE TRIGGER customers_portal_session_cap_after_merge_trg
AFTER UPDATE OF merged_into_id ON public.customers
FOR EACH ROW
WHEN (NEW.merged_into_id IS NOT NULL AND OLD.merged_into_id IS DISTINCT FROM NEW.merged_into_id)
EXECUTE FUNCTION public.customer_portal_cap_sessions_after_merge();

CREATE OR REPLACE FUNCTION public.customer_portal_session_resolve(
  requested_session_hash text
)
RETURNS TABLE (
  session_id uuid,
  org_id uuid,
  store_id uuid,
  customer_id uuid,
  csrf_hash text,
  authority_hash text,
  expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE session_row public.customer_portal_sessions%ROWTYPE; canonical_customer uuid;
BEGIN
  IF requested_session_hash !~ '^[0-9a-f]{64}$' THEN RETURN; END IF;
  SELECT portal_session.* INTO session_row
    FROM public.customer_portal_sessions portal_session
    JOIN public.store_features feature_row
      ON feature_row.org_id = portal_session.org_id
     AND feature_row.store_id = portal_session.store_id
   WHERE portal_session.session_hash = requested_session_hash
     AND portal_session.status = 'active'
     AND portal_session.expires_at > statement_timestamp()
     AND feature_row.customer_portal;
  IF session_row.id IS NULL THEN RETURN; END IF;
  PERFORM set_config('app.org_id', session_row.org_id::text, true);
  PERFORM set_config('app.store_id', session_row.store_id::text, true);
  canonical_customer := public.customer_canonical_root(session_row.customer_id);
  IF canonical_customer IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.customers root_row
     WHERE root_row.org_id = session_row.org_id AND root_row.id = canonical_customer
       AND root_row.anonymized_at IS NULL AND root_row.phone IS NOT NULL
  ) THEN RETURN; END IF;
  RETURN QUERY SELECT session_row.id, session_row.org_id, session_row.store_id,
    canonical_customer, session_row.csrf_hash::text, session_row.authority_hash::text,
    session_row.expires_at;
END;
$$;

CREATE OR REPLACE FUNCTION public.customer_portal_session_validate(
  requested_session_id uuid,
  requested_session_hash text,
  requested_authority_hash text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.customer_portal_sessions portal_session
    JOIN public.store_features feature_row
      ON feature_row.org_id = portal_session.org_id
     AND feature_row.store_id = portal_session.store_id
   WHERE portal_session.id = requested_session_id
     AND portal_session.session_hash = requested_session_hash
     AND portal_session.authority_hash = requested_authority_hash
     AND portal_session.status = 'active'
     AND portal_session.expires_at > statement_timestamp()
     AND portal_session.org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
     AND portal_session.store_id = NULLIF(current_setting('app.store_id', true), '')::uuid
     AND public.customer_canonical_root(portal_session.customer_id)
       = NULLIF(current_setting('app.customer_id', true), '')::uuid
     AND feature_row.customer_portal
  )
$$;

CREATE OR REPLACE FUNCTION public.customer_portal_session_revoke(
  requested_session_hash text,
  requested_csrf_hash text,
  requested_authority_hash text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE session_row public.customer_portal_sessions%ROWTYPE; canonical_customer uuid;
BEGIN
  SELECT * INTO session_row FROM public.customer_portal_sessions
   WHERE session_hash = requested_session_hash AND csrf_hash = requested_csrf_hash
     AND authority_hash = requested_authority_hash
     AND status = 'active' AND expires_at > statement_timestamp() FOR UPDATE;
  IF session_row.id IS NULL THEN RETURN false; END IF;
  PERFORM set_config('app.org_id', session_row.org_id::text, true);
  canonical_customer := public.customer_canonical_root(session_row.customer_id);
  UPDATE public.customer_portal_sessions
     SET status = 'revoked', revoked_at = statement_timestamp()
   WHERE id = session_row.id;
  IF canonical_customer IS NOT NULL THEN
    INSERT INTO public.customer_portal_access_log (
      id, org_id, store_id, customer_id, session_id, operation, resource_id, at
    ) VALUES (
      gen_random_uuid(), session_row.org_id, session_row.store_id, canonical_customer,
      session_row.id, 'auth.logout', NULL, statement_timestamp()
    );
  END IF;
  RETURN true;
END;
$$;

-- Security-invoker, security-barrier views are the only business-data surface
-- consumed by the customer portal store. Every view applies store feature,
-- tenant and canonical-customer predicates before exposing safe columns.
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
        AND feature_row.customer_portal
   );

CREATE OR REPLACE VIEW public.customer_portal_order_lines
WITH (security_barrier = true, security_invoker = true) AS
SELECT line_row.order_id, line_row.line_index, line_row.service_code,
       line_row.category_code, line_row.unit_price_cents, line_row.qty,
       line_row.line_total_cents, line_row.color, line_row.brand
  FROM public.order_lines line_row
  JOIN public.customer_portal_orders portal_order ON portal_order.order_id = line_row.order_id
 WHERE line_row.org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
   AND line_row.store_id = NULLIF(current_setting('app.store_id', true), '')::uuid;

CREATE OR REPLACE VIEW public.customer_portal_payments
WITH (security_barrier = true, security_invoker = true) AS
SELECT payment_row.id AS payment_id, payment_row.order_id, payment_row.method,
       payment_row.kind, payment_row.amount_cents, payment_row.at
  FROM public.payments payment_row
  JOIN public.customer_portal_orders portal_order ON portal_order.order_id = payment_row.order_id
 WHERE payment_row.org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
   AND payment_row.store_id = NULLIF(current_setting('app.store_id', true), '')::uuid;

CREATE OR REPLACE VIEW public.customer_portal_garments
WITH (security_barrier = true, security_invoker = true) AS
SELECT garment_row.id AS garment_id, garment_row.order_id, garment_row.seq,
       garment_row.service_code, garment_row.category_code, garment_row.color,
       garment_row.brand, garment_row.status
  FROM public.garments garment_row
  JOIN public.customer_portal_orders portal_order ON portal_order.order_id = garment_row.order_id
 WHERE garment_row.org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
   AND garment_row.store_id = NULLIF(current_setting('app.store_id', true), '')::uuid
   AND garment_row.customer_pii_purged_at IS NULL;

CREATE OR REPLACE VIEW public.customer_portal_garment_progress
WITH (security_barrier = true, security_invoker = true) AS
SELECT status_row.order_id, status_row.garment_id, status_row.from_status,
       status_row.to_status, status_row.at
  FROM public.garment_status_log status_row
  JOIN public.customer_portal_garments portal_garment
    ON portal_garment.order_id = status_row.order_id
   AND portal_garment.garment_id = status_row.garment_id
 WHERE status_row.org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
   AND status_row.store_id = NULLIF(current_setting('app.store_id', true), '')::uuid;

ALTER TABLE public.customer_portal_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_portal_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.customer_portal_access_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_portal_access_log FORCE ROW LEVEL SECURITY;
CREATE POLICY customer_portal_sessions_maintenance ON public.customer_portal_sessions
  AS PERMISSIVE FOR ALL TO laundry_owner USING (true) WITH CHECK (true);
CREATE POLICY customer_portal_access_log_maintenance ON public.customer_portal_access_log
  AS PERMISSIVE FOR ALL TO laundry_owner USING (true) WITH CHECK (true);
CREATE POLICY customer_portal_access_log_store_insert ON public.customer_portal_access_log
  AS PERMISSIVE FOR INSERT TO laundry_app WITH CHECK (
    org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid
    AND customer_id = NULLIF(current_setting('app.customer_id', true), '')::uuid
  );

REVOKE ALL ON TABLE public.customer_portal_sessions FROM PUBLIC, laundry_app;
REVOKE ALL ON TABLE public.customer_portal_access_log FROM PUBLIC, laundry_app;
-- The application may edit profile/privacy fields, but canonical merge columns
-- are owner-only and can change only inside customer_merge_canonical(). That
-- primitive takes the org advisory lock before any customer row lock.
REVOKE UPDATE ON TABLE public.customers FROM laundry_app;
GRANT UPDATE (
  phone, name, note, updated_at, version, anonymized_at, anonymized_by_staff_id
) ON TABLE public.customers TO laundry_app;
GRANT INSERT ON TABLE public.customer_portal_access_log TO laundry_app;
GRANT SELECT ON public.customer_portal_orders, public.customer_portal_order_lines,
  public.customer_portal_payments, public.customer_portal_garments,
  public.customer_portal_garment_progress TO laundry_app;

REVOKE ALL ON FUNCTION public.reject_customer_portal_evidence_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.customer_portal_cap_sessions_after_merge() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.customer_portal_session_create(text, text, text, text, text, text, text)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.customer_portal_session_resolve(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.customer_portal_session_validate(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.customer_portal_session_revoke(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.customer_portal_session_create(text, text, text, text, text, text, text)
  TO laundry_app;
GRANT EXECUTE ON FUNCTION public.customer_portal_session_resolve(text) TO laundry_app;
GRANT EXECUTE ON FUNCTION public.customer_portal_session_validate(uuid, text, text) TO laundry_app;
GRANT EXECUTE ON FUNCTION public.customer_portal_session_revoke(text, text, text) TO laundry_app;
