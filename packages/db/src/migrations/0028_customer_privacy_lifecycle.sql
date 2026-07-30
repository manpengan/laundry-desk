-- Customer privacy lifecycle: retain accounting rows while removing direct PII.
-- Export and anonymization run through narrowly granted SECURITY DEFINER
-- functions so an org-scoped profile can cover orders from every store without
-- granting laundry_app a general RLS bypass.

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS anonymized_at timestamptz,
  ADD COLUMN IF NOT EXISTS anonymized_by_staff_id uuid;

ALTER TABLE customers
  ADD CONSTRAINT customers_anonymized_by_staff_fk
  FOREIGN KEY (org_id, anonymized_by_staff_id)
  REFERENCES staffs (org_id, id)
  NOT VALID;

ALTER TABLE customers
  ADD CONSTRAINT customers_anonymized_pair_chk CHECK (
    (anonymized_at IS NULL AND anonymized_by_staff_id IS NULL)
    OR (anonymized_at IS NOT NULL AND anonymized_by_staff_id IS NOT NULL)
  );

-- Orders retain a stable customer identity. Phone/name remain immutable receipt
-- snapshots and can no longer decide which history a privacy action owns.
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS customer_id uuid;

UPDATE orders order_row
   SET customer_id = customer_row.id
  FROM customers customer_row
 WHERE order_row.org_id = customer_row.org_id
   AND order_row.customer_phone = customer_row.phone
   AND order_row.customer_id IS NULL;

ALTER TABLE orders
  ADD CONSTRAINT orders_customer_fk
  FOREIGN KEY (org_id, customer_id)
  REFERENCES customers (org_id, id)
  NOT VALID;

CREATE INDEX IF NOT EXISTS orders_org_customer_created_idx
  ON orders (org_id, customer_id, created_at DESC);

CREATE TABLE IF NOT EXISTS customer_privacy_events (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  origin_store_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  staff_id uuid NOT NULL,
  action text NOT NULL,
  reason text NOT NULL,
  affected_order_count integer NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT customer_privacy_events_org_id_uidx UNIQUE (org_id, id),
  CONSTRAINT customer_privacy_events_store_fk
    FOREIGN KEY (org_id, origin_store_id) REFERENCES stores (org_id, id),
  CONSTRAINT customer_privacy_events_staff_fk
    FOREIGN KEY (org_id, staff_id) REFERENCES staffs (org_id, id),
  CONSTRAINT customer_privacy_events_action_chk
    CHECK (action IN ('exported', 'anonymized')),
  CONSTRAINT customer_privacy_events_reason_chk
    CHECK (char_length(reason) BETWEEN 1 AND 256),
  CONSTRAINT customer_privacy_events_order_count_chk
    CHECK (affected_order_count >= 0)
);

CREATE INDEX IF NOT EXISTS customer_privacy_events_customer_idx
  ON customer_privacy_events (org_id, customer_id, created_at DESC);

ALTER TABLE customer_privacy_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_privacy_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS customer_privacy_events_org_scope ON customer_privacy_events;
CREATE POLICY customer_privacy_events_org_scope ON customer_privacy_events
  FOR ALL TO laundry_app
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

DROP POLICY IF EXISTS customer_privacy_events_maintenance ON customer_privacy_events;
CREATE POLICY customer_privacy_events_maintenance ON customer_privacy_events
  FOR ALL TO laundry_owner
  USING (true)
  WITH CHECK (true);

GRANT SELECT, INSERT ON TABLE customer_privacy_events TO laundry_app;

CREATE OR REPLACE FUNCTION assert_customer_privacy_authority()
RETURNS TABLE (org_id uuid, store_id uuid, staff_id uuid, staff_role text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  requested_org uuid := NULLIF(current_setting('app.org_id', true), '')::uuid;
  requested_store uuid := NULLIF(current_setting('app.store_id', true), '')::uuid;
  requested_staff uuid := NULLIF(current_setting('app.staff_id', true), '')::uuid;
  resolved_role text;
BEGIN
  IF requested_org IS NULL OR requested_store IS NULL OR requested_staff IS NULL THEN
    RAISE insufficient_privilege USING MESSAGE = 'customer privacy authority unavailable';
  END IF;
  SELECT role_row.role INTO resolved_role
      FROM staff_store_roles role_row
      JOIN staffs staff_row
        ON staff_row.org_id = role_row.org_id AND staff_row.id = role_row.staff_id
     WHERE role_row.org_id = requested_org
       AND role_row.store_id = requested_store
       AND role_row.staff_id = requested_staff
       AND role_row.is_active
       AND staff_row.is_active
     LIMIT 1;
  IF resolved_role IS NULL THEN
    RAISE insufficient_privilege USING MESSAGE = 'customer privacy authority unavailable';
  END IF;
  RETURN QUERY SELECT requested_org, requested_store, requested_staff, resolved_role;
END;
$$;

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
    count(*) FILTER (WHERE order_row.status IN ('draft', 'open')),
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
  IF authority.staff_role <> 'admin' THEN
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
      SELECT id AS order_id, store_id, ticket_no, status, customer_phone, customer_name,
             payable_cents, paid_cents, balance_cents, business_date, created_at
        FROM orders
       WHERE org_id = authority.org_id AND customer_id = customer_row.id
       ORDER BY created_at DESC
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
  IF authority.staff_role <> 'admin' THEN
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

  SELECT count(*)::integer INTO active_count
    FROM orders
   WHERE org_id = authority.org_id
     AND customer_id = customer_row.id
     AND status IN ('draft', 'open');
  IF active_count > 0 THEN
    RETURN QUERY SELECT false, 0, active_count;
    RETURN;
  END IF;

  UPDATE orders
     SET customer_phone = NULL, customer_name = NULL, updated_at = requested_at
   WHERE org_id = authority.org_id
     AND customer_id = customer_row.id
     AND status IN ('closed', 'cancelled');
  GET DIAGNOSTICS changed_count = ROW_COUNT;

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

REVOKE ALL ON FUNCTION assert_customer_privacy_authority() FROM PUBLIC;
REVOKE ALL ON FUNCTION customer_privacy_status(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION customer_privacy_export(uuid, text, uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION customer_privacy_anonymize(uuid, text, uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION customer_privacy_status(uuid) TO laundry_app;
GRANT EXECUTE ON FUNCTION customer_privacy_export(uuid, text, uuid, timestamptz) TO laundry_app;
GRANT EXECUTE ON FUNCTION customer_privacy_anonymize(uuid, text, uuid, timestamptz) TO laundry_app;
