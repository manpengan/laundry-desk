-- Separate privacy authority from the coarse admin role and make access
-- changes invalidate sessions through permission_version.

ALTER TABLE staff_store_roles
  ADD COLUMN IF NOT EXISTS is_privacy_admin boolean NOT NULL DEFAULT false;

UPDATE staff_store_roles
   SET is_privacy_admin = true
 WHERE role = 'admin'
   AND is_active = true
   AND is_privacy_admin = false;

ALTER TABLE staff_store_roles
  ADD CONSTRAINT staff_store_roles_role_chk
  CHECK (role IN ('admin', 'staff'));

ALTER TABLE staff_store_roles
  ADD CONSTRAINT staff_store_roles_privacy_admin_chk
  CHECK (NOT is_privacy_admin OR (role = 'admin' AND is_active));

CREATE OR REPLACE FUNCTION assert_customer_privacy_authority()
RETURNS TABLE (
  org_id uuid,
  store_id uuid,
  staff_id uuid,
  staff_role text
)
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
  SELECT role_row.role
    INTO resolved_role
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
  RETURN QUERY
    SELECT requested_org, requested_store, requested_staff, resolved_role;
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
REVOKE ALL ON FUNCTION customer_privacy_export(uuid, text, uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION customer_privacy_anonymize(uuid, text, uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION customer_privacy_export(uuid, text, uuid, timestamptz) TO laundry_app;
GRANT EXECUTE ON FUNCTION customer_privacy_anonymize(uuid, text, uuid, timestamptz) TO laundry_app;
