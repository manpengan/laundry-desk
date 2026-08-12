-- ADR-46 store delivery coverage, fee and appointment policy.
--
-- Expand-only: no row is seeded and store_features.delivery remains unchanged.
-- Policy configuration never creates a customer, address, reservation or capacity hold.

CREATE OR REPLACE FUNCTION public.delivery_policy_json_exact_keys(
  value jsonb,
  expected text[]
) RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT jsonb_typeof(value) = 'object'
     AND (SELECT COALESCE(array_agg(key ORDER BY key), ARRAY[]::text[])
            FROM jsonb_object_keys(value) AS key) = expected;
$$;

CREATE OR REPLACE FUNCTION public.delivery_service_areas_are_valid(value jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
DECLARE
  area jsonb;
  area_count integer;
  codes text[] := ARRAY[]::text[];
BEGIN
  IF jsonb_typeof(value) <> 'array' THEN RETURN false; END IF;
  area_count := jsonb_array_length(value);
  IF area_count > 20 THEN RETURN false; END IF;
  FOR area IN SELECT item FROM jsonb_array_elements(value) AS entry(item) LOOP
    IF NOT delivery_policy_json_exact_keys(
      area, ARRAY['code', 'fee_cents', 'is_active', 'name']
    ) OR jsonb_typeof(area->'code') <> 'string'
      OR area->>'code' !~ '^[a-z0-9][a-z0-9_-]{0,31}$'
      OR jsonb_typeof(area->'name') <> 'string'
      OR char_length(btrim(area->>'name')) NOT BETWEEN 1 AND 64
      OR jsonb_typeof(area->'fee_cents') <> 'number'
      OR area->>'fee_cents' !~ '^[0-9]+$'
      OR (area->>'fee_cents')::numeric > 2147483647
      OR jsonb_typeof(area->'is_active') <> 'boolean' THEN
      RETURN false;
    END IF;
    IF (area->>'code') = ANY(codes) THEN RETURN false; END IF;
    codes := array_append(codes, area->>'code');
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.delivery_accepting_policy_is_valid(
  accepting boolean,
  areas jsonb,
  windows jsonb
) RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT NOT accepting OR (
    jsonb_typeof(areas) = 'array'
    AND jsonb_typeof(windows) = 'array'
    AND jsonb_array_length(windows) > 0
    AND COALESCE(
      (SELECT bool_or(item->>'is_active' = 'true')
         FROM jsonb_array_elements(areas) AS area(item)),
      false
    )
  );
$$;

CREATE OR REPLACE FUNCTION public.delivery_weekly_windows_are_valid(
  value jsonb,
  slot_length integer
) RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
DECLARE
  window_row jsonb;
  weekday_value integer;
  start_value integer;
  end_value integer;
  seen_starts text[] := ARRAY[]::text[];
  previous_end integer[] := ARRAY[0, 0, 0, 0, 0, 0, 0];
BEGIN
  IF jsonb_typeof(value) <> 'array' OR jsonb_array_length(value) > 28
     OR slot_length NOT BETWEEN 15 AND 240 THEN RETURN false; END IF;
  FOR window_row IN
    SELECT item FROM jsonb_array_elements(value) AS entry(item)
    ORDER BY (item->>'weekday')::integer, (item->>'start_minute')::integer
  LOOP
    IF NOT delivery_policy_json_exact_keys(
      window_row, ARRAY['end_minute', 'start_minute', 'weekday']
    ) OR jsonb_typeof(window_row->'weekday') <> 'number'
      OR jsonb_typeof(window_row->'start_minute') <> 'number'
      OR jsonb_typeof(window_row->'end_minute') <> 'number'
      OR window_row->>'weekday' !~ '^[0-9]+$'
      OR window_row->>'start_minute' !~ '^[0-9]+$'
      OR window_row->>'end_minute' !~ '^[0-9]+$' THEN RETURN false; END IF;
    weekday_value := (window_row->>'weekday')::integer;
    start_value := (window_row->>'start_minute')::integer;
    end_value := (window_row->>'end_minute')::integer;
    IF weekday_value NOT BETWEEN 1 AND 7 OR start_value NOT BETWEEN 0 AND 1439
       OR end_value NOT BETWEEN 1 AND 1440 OR end_value <= start_value
       OR end_value - start_value < slot_length
       OR (end_value - start_value) % slot_length <> 0
       OR start_value < previous_end[weekday_value]
       OR format('%s:%s', weekday_value, start_value) = ANY(seen_starts) THEN
      RETURN false;
    END IF;
    previous_end[weekday_value] := end_value;
    seen_starts := array_append(seen_starts, format('%s:%s', weekday_value, start_value));
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$$;

CREATE TABLE IF NOT EXISTS public.delivery_policies (
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  accepting_appointments boolean NOT NULL DEFAULT false,
  minimum_lead_minutes integer NOT NULL DEFAULT 120,
  maximum_advance_days integer NOT NULL DEFAULT 14,
  slot_minutes integer NOT NULL DEFAULT 60,
  max_appointments_per_slot integer NOT NULL DEFAULT 1,
  service_areas_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  weekly_windows_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL,
  updated_by_staff_id uuid NOT NULL,
  CONSTRAINT delivery_policies_pkey PRIMARY KEY (org_id, store_id),
  CONSTRAINT delivery_policies_store_fk
    FOREIGN KEY (org_id, store_id) REFERENCES public.stores (org_id, id),
  CONSTRAINT delivery_policies_staff_fk
    FOREIGN KEY (org_id, updated_by_staff_id) REFERENCES public.staffs (org_id, id),
  CONSTRAINT delivery_policies_minimum_lead_chk
    CHECK (minimum_lead_minutes BETWEEN 0 AND 10080),
  CONSTRAINT delivery_policies_maximum_advance_chk
    CHECK (maximum_advance_days BETWEEN 1 AND 365),
  CONSTRAINT delivery_policies_slot_minutes_chk CHECK (slot_minutes BETWEEN 15 AND 240),
  CONSTRAINT delivery_policies_slot_capacity_chk
    CHECK (max_appointments_per_slot BETWEEN 1 AND 100),
  CONSTRAINT delivery_policies_service_areas_json_chk CHECK (
    delivery_service_areas_are_valid(service_areas_json)
  ),
  CONSTRAINT delivery_policies_weekly_windows_json_chk CHECK (
    delivery_weekly_windows_are_valid(weekly_windows_json, slot_minutes)
  ),
  CONSTRAINT delivery_policies_accepting_shape_chk CHECK (
    delivery_accepting_policy_is_valid(
      accepting_appointments, service_areas_json, weekly_windows_json
    )
  ),
  CONSTRAINT delivery_policies_version_chk CHECK (version BETWEEN 1 AND 2147483647)
);

CREATE OR REPLACE FUNCTION public.guard_delivery_policy_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  db_now timestamptz := statement_timestamp();
  actor_id uuid := NULLIF(current_setting('app.staff_id', true), '')::uuid;
BEGIN
  IF session_user = 'laundry_app' THEN
    IF actor_id IS NULL OR NEW.updated_by_staff_id IS DISTINCT FROM actor_id OR NOT EXISTS (
      SELECT 1
        FROM staffs staff
        JOIN staff_store_roles role
          ON role.org_id = staff.org_id AND role.staff_id = staff.id
         AND role.store_id = NEW.store_id
       WHERE staff.org_id = NEW.org_id AND staff.id = actor_id
         AND staff.is_active = true
         AND role.is_active = true AND role.role = 'admin'
    ) THEN
      RAISE insufficient_privilege USING MESSAGE = 'delivery policy actor unavailable';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.version <> 1 THEN
      RAISE check_violation USING MESSAGE = 'delivery policy must begin at version one';
    END IF;
  ELSE
    IF NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.store_id IS DISTINCT FROM OLD.store_id THEN
      RAISE insufficient_privilege USING MESSAGE = 'delivery policy identity is immutable';
    END IF;
    IF NEW.version <> OLD.version + 1 THEN
      RAISE check_violation USING MESSAGE = 'delivery policy version must advance by one';
    END IF;
    IF db_now < OLD.updated_at THEN
      RAISE check_violation USING MESSAGE = 'delivery policy time must be monotonic';
    END IF;
  END IF;
  NEW.updated_at := db_now;
  RETURN NEW;
END;
$$;

CREATE TRIGGER delivery_policy_write_guard_trg
BEFORE INSERT OR UPDATE ON public.delivery_policies
FOR EACH ROW EXECUTE FUNCTION public.guard_delivery_policy_write();

ALTER TABLE public.delivery_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.delivery_policies FORCE ROW LEVEL SECURITY;

CREATE POLICY delivery_policies_store_scope ON public.delivery_policies
  AS PERMISSIVE FOR ALL TO laundry_app
  USING (
    org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid
  );

CREATE POLICY delivery_policies_maintenance ON public.delivery_policies
  AS PERMISSIVE FOR ALL TO laundry_owner USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE ON TABLE public.delivery_policies TO laundry_app;
REVOKE DELETE, TRUNCATE ON TABLE public.delivery_policies FROM laundry_app;
REVOKE ALL ON FUNCTION public.delivery_policy_json_exact_keys(jsonb, text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delivery_service_areas_are_valid(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delivery_weekly_windows_are_valid(jsonb, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delivery_accepting_policy_is_valid(boolean, jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_delivery_policy_write() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delivery_policy_json_exact_keys(jsonb, text[]) TO laundry_app;
GRANT EXECUTE ON FUNCTION public.delivery_service_areas_are_valid(jsonb) TO laundry_app;
GRANT EXECUTE ON FUNCTION public.delivery_weekly_windows_are_valid(jsonb, integer)
  TO laundry_app;
GRANT EXECUTE ON FUNCTION public.delivery_accepting_policy_is_valid(boolean, jsonb, jsonb)
  TO laundry_app;

-- A lost first-hop R5 response must resolve to the same frozen pending card.
CREATE UNIQUE INDEX IF NOT EXISTS ai_pending_delivery_policy_idempotency_uidx
  ON public.ai_pending_actions (org_id, store_id, command, idempotency_key)
  WHERE command = 'delivery.policy.set';
