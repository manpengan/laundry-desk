-- ADR-63 / Stage 4.5 Item 17: bounded, allowlisted automation.
-- There is deliberately no user supplied cron, code, SQL, URL, or free-form tool input.

CREATE TABLE public.automation_policies (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  name text NOT NULL,
  tool text NOT NULL,
  tool_version text NOT NULL,
  object_filter_json jsonb NOT NULL,
  schedule_json jsonb NOT NULL,
  limits_json jsonb NOT NULL,
  status text NOT NULL,
  row_version integer NOT NULL,
  valid_from timestamptz NOT NULL,
  valid_until timestamptz,
  approved_by_staff_id uuid,
  approved_at timestamptz,
  next_run_at timestamptz,
  active_run_id uuid,
  lease_token uuid,
  lease_until timestamptz,
  last_run_at timestamptz,
  last_outcome text,
  consecutive_failures integer NOT NULL DEFAULT 0,
  created_by_staff_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  updated_by_staff_id uuid NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT automation_policies_org_id_uidx UNIQUE (org_id, id),
  CONSTRAINT automation_policies_store_fk
    FOREIGN KEY (org_id, store_id) REFERENCES public.stores (org_id, id),
  CONSTRAINT automation_policies_approved_staff_fk
    FOREIGN KEY (org_id, approved_by_staff_id) REFERENCES public.staffs (org_id, id),
  CONSTRAINT automation_policies_created_staff_fk
    FOREIGN KEY (org_id, created_by_staff_id) REFERENCES public.staffs (org_id, id),
  CONSTRAINT automation_policies_updated_staff_fk
    FOREIGN KEY (org_id, updated_by_staff_id) REFERENCES public.staffs (org_id, id),
  CONSTRAINT automation_policies_name_chk
    CHECK (length(name) BETWEEN 1 AND 128 AND name !~ '[[:cntrl:]]'),
  CONSTRAINT automation_policies_tool_chk CHECK (
    tool = 'notification.delivery_batch.enqueue' AND tool_version = '0.1.0'
  ),
  CONSTRAINT automation_policies_filter_chk CHECK (
    jsonb_typeof(object_filter_json) = 'object'
    AND object_filter_json ?& ARRAY[
      'min_age_days', 'unpaid_only', 'garment_statuses', 'max_objects'
    ]
    AND object_filter_json - ARRAY[
      'min_age_days', 'unpaid_only', 'garment_statuses', 'max_objects'
    ] = '{}'::jsonb
    AND (object_filter_json ->> 'min_age_days')::integer IN (30, 90, 180)
    AND jsonb_typeof(object_filter_json -> 'unpaid_only') = 'boolean'
    AND jsonb_typeof(object_filter_json -> 'garment_statuses') = 'array'
    AND jsonb_array_length(object_filter_json -> 'garment_statuses') BETWEEN 1 AND 2
    AND object_filter_json -> 'garment_statuses' <@ '["ready", "racked"]'::jsonb
    AND (object_filter_json ->> 'max_objects')::integer BETWEEN 1 AND 10
  ),
  CONSTRAINT automation_policies_schedule_chk CHECK (
    jsonb_typeof(schedule_json) = 'object'
    AND schedule_json ?& ARRAY[
      'cadence', 'local_time', 'days_of_week', 'window_start_local', 'window_end_local'
    ]
    AND schedule_json - ARRAY[
      'cadence', 'local_time', 'days_of_week', 'window_start_local', 'window_end_local'
    ] = '{}'::jsonb
    AND schedule_json ->> 'cadence' = 'daily'
    AND schedule_json ->> 'local_time' ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$'
    AND schedule_json ->> 'window_start_local' ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$'
    AND schedule_json ->> 'window_end_local' ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$'
    AND schedule_json ->> 'window_start_local' < schedule_json ->> 'window_end_local'
    AND schedule_json ->> 'local_time' >= schedule_json ->> 'window_start_local'
    AND schedule_json ->> 'local_time' < schedule_json ->> 'window_end_local'
    AND jsonb_typeof(schedule_json -> 'days_of_week') = 'array'
    AND jsonb_array_length(schedule_json -> 'days_of_week') BETWEEN 1 AND 7
    AND NOT jsonb_path_exists(schedule_json, '$.days_of_week[*] ? (@ < 0 || @ > 6)')
  ),
  CONSTRAINT automation_policies_limits_chk CHECK (
    jsonb_typeof(limits_json) = 'object'
    AND limits_json ?& ARRAY['max_runs_per_day', 'max_amount_cents']
    AND limits_json - ARRAY['max_runs_per_day', 'max_amount_cents'] = '{}'::jsonb
    AND (limits_json ->> 'max_runs_per_day')::integer BETWEEN 1 AND 24
    AND (limits_json ->> 'max_amount_cents')::integer BETWEEN 0 AND 100000
  ),
  CONSTRAINT automation_policies_status_chk CHECK (
    status IN ('pending_approval', 'active', 'paused', 'quota_paused', 'archived')
  ),
  CONSTRAINT automation_policies_version_chk CHECK (row_version > 0),
  CONSTRAINT automation_policies_validity_chk CHECK (
    valid_until IS NULL OR valid_until > valid_from
  ),
  CONSTRAINT automation_policies_approval_chk CHECK (
    (approved_by_staff_id IS NULL AND approved_at IS NULL AND status = 'pending_approval')
    OR (approved_by_staff_id IS NOT NULL AND approved_at IS NOT NULL)
  ),
  CONSTRAINT automation_policies_lease_chk CHECK (
    (active_run_id IS NULL AND lease_token IS NULL AND lease_until IS NULL)
    OR (active_run_id IS NOT NULL AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
  ),
  CONSTRAINT automation_policies_outcome_chk CHECK (
    last_outcome IS NULL OR last_outcome IN ('executed', 'failed', 'skipped', 'denied')
  ),
  CONSTRAINT automation_policies_failures_chk CHECK (consecutive_failures BETWEEN 0 AND 3),
  CONSTRAINT automation_policies_time_chk CHECK (updated_at >= created_at)
);

CREATE INDEX automation_policies_due_idx
  ON public.automation_policies (status, next_run_at, id)
  WHERE status = 'active';
CREATE INDEX automation_policies_store_idx
  ON public.automation_policies (org_id, store_id, updated_at DESC, id);

CREATE TABLE public.automation_policy_usage_daily (
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  policy_id uuid NOT NULL,
  business_date date NOT NULL,
  run_count integer NOT NULL,
  amount_cents integer NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT automation_policy_usage_daily_pkey
    PRIMARY KEY (org_id, store_id, policy_id, business_date),
  CONSTRAINT automation_policy_usage_daily_policy_fk
    FOREIGN KEY (org_id, policy_id) REFERENCES public.automation_policies (org_id, id),
  CONSTRAINT automation_policy_usage_daily_store_fk
    FOREIGN KEY (org_id, store_id) REFERENCES public.stores (org_id, id),
  CONSTRAINT automation_policy_usage_daily_count_chk CHECK (run_count BETWEEN 0 AND 24),
  CONSTRAINT automation_policy_usage_daily_amount_chk CHECK (amount_cents BETWEEN 0 AND 100000)
);

CREATE TABLE public.ai_action_log (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  policy_id uuid NOT NULL,
  tool text NOT NULL,
  decision text NOT NULL,
  outcome text NOT NULL,
  args_sha256 text NOT NULL,
  object_count integer NOT NULL,
  amount_cents integer NOT NULL,
  error_code text,
  actor_staff_id uuid NOT NULL,
  started_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL,
  CONSTRAINT ai_action_log_org_id_uidx UNIQUE (org_id, id),
  CONSTRAINT ai_action_log_policy_fk
    FOREIGN KEY (org_id, policy_id) REFERENCES public.automation_policies (org_id, id),
  CONSTRAINT ai_action_log_store_fk
    FOREIGN KEY (org_id, store_id) REFERENCES public.stores (org_id, id),
  CONSTRAINT ai_action_log_staff_fk
    FOREIGN KEY (org_id, actor_staff_id) REFERENCES public.staffs (org_id, id),
  CONSTRAINT ai_action_log_tool_chk CHECK (tool = 'notification.delivery_batch.enqueue'),
  CONSTRAINT ai_action_log_decision_chk CHECK (decision = 'policy'),
  CONSTRAINT ai_action_log_outcome_chk CHECK (
    outcome IN ('executed', 'failed', 'skipped', 'denied')
  ),
  CONSTRAINT ai_action_log_hash_chk CHECK (args_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ai_action_log_objects_chk CHECK (object_count BETWEEN 0 AND 10),
  CONSTRAINT ai_action_log_amount_chk CHECK (amount_cents BETWEEN 0 AND 100000),
  CONSTRAINT ai_action_log_error_chk CHECK (
    error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'
  ),
  CONSTRAINT ai_action_log_time_chk CHECK (completed_at >= started_at)
);

CREATE INDEX ai_action_log_policy_idx
  ON public.ai_action_log (org_id, store_id, policy_id, started_at DESC, id);

CREATE FUNCTION public.assert_automation_admin()
RETURNS TABLE (org_id uuid, store_id uuid, staff_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  requested_org uuid := NULLIF(current_setting('app.org_id', true), '')::uuid;
  requested_store uuid := NULLIF(current_setting('app.store_id', true), '')::uuid;
  requested_staff uuid := NULLIF(current_setting('app.staff_id', true), '')::uuid;
  authorized boolean := false;
BEGIN
  IF requested_org IS NULL OR requested_store IS NULL OR requested_staff IS NULL THEN
    RAISE insufficient_privilege USING MESSAGE = 'automation administrator authority unavailable';
  END IF;
  SELECT true INTO authorized
    FROM public.staffs staff_row
    JOIN public.staff_store_roles role_row
      ON role_row.org_id = staff_row.org_id AND role_row.staff_id = staff_row.id
   WHERE staff_row.org_id = requested_org
     AND staff_row.id = requested_staff
     AND staff_row.is_active
     AND role_row.store_id = requested_store
     AND role_row.is_active
     AND role_row.role = 'admin'
   LIMIT 1
   FOR SHARE OF staff_row, role_row;
  IF NOT COALESCE(authorized, false) THEN
    RAISE insufficient_privilege USING MESSAGE = 'automation administrator authority unavailable';
  END IF;
  RETURN QUERY SELECT requested_org, requested_store, requested_staff;
END
$$;

CREATE FUNCTION public.automation_next_run(
  requested_schedule jsonb,
  requested_timezone text,
  requested_after timestamptz
)
RETURNS timestamptz
LANGUAGE plpgsql
STABLE
STRICT
SET search_path = pg_catalog, public
AS $$
DECLARE
  offset_days integer;
  local_day date := (requested_after AT TIME ZONE requested_timezone)::date;
  candidate timestamptz;
  weekday integer;
BEGIN
  FOR offset_days IN 0..7 LOOP
    weekday := EXTRACT(DOW FROM local_day + offset_days)::integer;
    IF requested_schedule -> 'days_of_week' @> to_jsonb(ARRAY[weekday]) THEN
      candidate := ((local_day + offset_days)::text || ' '
        || (requested_schedule ->> 'local_time'))::timestamp AT TIME ZONE requested_timezone;
      IF candidate > requested_after THEN
        RETURN candidate;
      END IF;
    END IF;
  END LOOP;
  RETURN NULL;
END
$$;

CREATE FUNCTION public.automation_policy_write(
  requested_operation text,
  requested_id uuid,
  requested_expected_version integer,
  requested_name text,
  requested_tool text,
  requested_tool_version text,
  requested_filter jsonb,
  requested_schedule jsonb,
  requested_limits jsonb,
  requested_valid_from timestamptz,
  requested_valid_until timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  authority record;
  target record;
  db_now timestamptz := statement_timestamp();
  store_timezone text;
BEGIN
  SELECT * INTO authority FROM public.assert_automation_admin();
  SELECT timezone INTO STRICT store_timezone
    FROM public.stores
   WHERE org_id = authority.org_id AND id = authority.store_id;

  IF requested_operation = 'create' THEN
    IF requested_expected_version IS NOT NULL OR requested_tool <> 'notification.delivery_batch.enqueue'
       OR requested_tool_version <> '0.1.0' THEN
      RETURN false;
    END IF;
    INSERT INTO public.automation_policies (
      id, org_id, store_id, name, tool, tool_version, object_filter_json,
      schedule_json, limits_json, status, row_version, valid_from, valid_until,
      approved_by_staff_id, approved_at, next_run_at, active_run_id, lease_token,
      lease_until, last_run_at, last_outcome, consecutive_failures,
      created_by_staff_id, created_at, updated_by_staff_id, updated_at
    ) VALUES (
      requested_id, authority.org_id, authority.store_id, requested_name,
      requested_tool, requested_tool_version, requested_filter, requested_schedule,
      requested_limits, 'pending_approval', 1, requested_valid_from,
      requested_valid_until, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0,
      authority.staff_id, db_now, authority.staff_id, db_now
    );
    RETURN true;
  END IF;

  SELECT policy_row.* INTO target
    FROM public.automation_policies policy_row
   WHERE policy_row.org_id = authority.org_id
     AND policy_row.store_id = authority.store_id
     AND policy_row.id = requested_id
   FOR UPDATE;
  IF NOT FOUND OR target.row_version <> requested_expected_version OR target.status = 'archived' THEN
    RETURN false;
  END IF;

  IF requested_operation = 'update' THEN
    IF requested_tool <> 'notification.delivery_batch.enqueue' OR requested_tool_version <> '0.1.0'
       OR (target.lease_until IS NOT NULL AND target.lease_until > db_now) THEN
      RETURN false;
    END IF;
    UPDATE public.automation_policies
       SET name = requested_name, tool = requested_tool, tool_version = requested_tool_version,
           object_filter_json = requested_filter, schedule_json = requested_schedule,
           limits_json = requested_limits, status = 'pending_approval',
           row_version = row_version + 1, valid_from = requested_valid_from,
           valid_until = requested_valid_until, approved_by_staff_id = NULL,
           approved_at = NULL, next_run_at = NULL, updated_by_staff_id = authority.staff_id,
           active_run_id = NULL, lease_token = NULL, lease_until = NULL, updated_at = db_now
     WHERE id = requested_id;
    RETURN true;
  END IF;

  IF requested_operation = 'approve' AND target.status = 'pending_approval'
     AND requested_valid_from IS NULL AND (target.valid_until IS NULL OR target.valid_until > db_now) THEN
    UPDATE public.automation_policies
       SET status = 'active', row_version = row_version + 1,
           approved_by_staff_id = authority.staff_id, approved_at = db_now,
           next_run_at = public.automation_next_run(target.schedule_json, store_timezone,
             GREATEST(db_now, target.valid_from - interval '1 millisecond')),
           updated_by_staff_id = authority.staff_id, updated_at = db_now
     WHERE id = requested_id;
    RETURN true;
  END IF;

  IF requested_operation = 'pause' AND target.status IN ('active', 'quota_paused')
     AND (target.lease_until IS NULL OR target.lease_until <= db_now)
     AND requested_valid_from IS NULL THEN
    UPDATE public.automation_policies
       SET status = 'paused', row_version = row_version + 1, next_run_at = NULL,
           active_run_id = NULL, lease_token = NULL, lease_until = NULL,
           updated_by_staff_id = authority.staff_id, updated_at = db_now
     WHERE id = requested_id;
    RETURN true;
  END IF;

  IF requested_operation = 'resume' AND target.status IN ('paused', 'quota_paused')
     AND target.approved_by_staff_id IS NOT NULL
     AND EXISTS (
       SELECT 1
         FROM public.staffs approver
         JOIN public.staff_store_roles approver_role
           ON approver_role.org_id = approver.org_id
          AND approver_role.staff_id = approver.id
          AND approver_role.store_id = target.store_id
          AND approver_role.is_active
          AND approver_role.role = 'admin'
        WHERE approver.org_id = target.org_id
          AND approver.id = target.approved_by_staff_id
          AND approver.is_active
     )
     AND (target.lease_until IS NULL OR target.lease_until <= db_now)
     AND requested_valid_from IS NULL AND (target.valid_until IS NULL OR target.valid_until > db_now) THEN
    UPDATE public.automation_policies
       SET status = 'active', row_version = row_version + 1,
           next_run_at = public.automation_next_run(target.schedule_json, store_timezone, db_now),
           active_run_id = NULL, lease_token = NULL, lease_until = NULL,
           updated_by_staff_id = authority.staff_id, updated_at = db_now
     WHERE id = requested_id;
    RETURN true;
  END IF;

  IF requested_operation = 'archive'
     AND (target.lease_until IS NULL OR target.lease_until <= db_now)
     AND requested_valid_from IS NULL THEN
    UPDATE public.automation_policies
       SET status = 'archived', row_version = row_version + 1, next_run_at = NULL,
           active_run_id = NULL, lease_token = NULL, lease_until = NULL,
           updated_by_staff_id = authority.staff_id, updated_at = db_now
     WHERE id = requested_id;
    RETURN true;
  END IF;
  RETURN false;
END
$$;

CREATE FUNCTION public.automation_due_policies(requested_now timestamptz, requested_limit integer)
RETURNS SETOF public.automation_policies
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT policy_row.*
    FROM public.assert_automation_admin() authority
    JOIN public.automation_policies policy_row
      ON policy_row.org_id = authority.org_id AND policy_row.store_id = authority.store_id
    JOIN public.staffs approver
      ON approver.org_id = policy_row.org_id
     AND approver.id = policy_row.approved_by_staff_id
     AND approver.is_active
    JOIN public.staff_store_roles approver_role
      ON approver_role.org_id = policy_row.org_id
     AND approver_role.store_id = policy_row.store_id
     AND approver_role.staff_id = policy_row.approved_by_staff_id
     AND approver_role.is_active
     AND approver_role.role = 'admin'
   WHERE policy_row.status = 'active'
     AND policy_row.next_run_at <= requested_now
     AND policy_row.valid_from <= requested_now
     AND (policy_row.valid_until IS NULL OR policy_row.valid_until > requested_now)
     AND (policy_row.lease_until IS NULL OR policy_row.lease_until <= requested_now)
   ORDER BY policy_row.next_run_at, policy_row.id
   LIMIT LEAST(GREATEST(requested_limit, 1), 50)
$$;

CREATE FUNCTION public.automation_attempt_begin(
  requested_policy_id uuid,
  requested_version integer,
  requested_run_id uuid,
  requested_lease_token uuid,
  requested_object_count integer,
  requested_amount_cents integer,
  requested_args_sha256 text,
  requested_now timestamptz
)
RETURNS TABLE (authorized boolean, reason text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  authority record;
  target record;
  usage_row record;
  local_date date;
  local_time time;
  weekday integer;
  store_timezone text;
  max_runs integer;
  max_amount integer;
BEGIN
  SELECT * INTO authority FROM public.assert_automation_admin();
  SELECT policy_row.*, store_row.timezone INTO target
    FROM public.automation_policies policy_row
    JOIN public.stores store_row
      ON store_row.org_id = policy_row.org_id AND store_row.id = policy_row.store_id
   WHERE policy_row.org_id = authority.org_id
     AND policy_row.store_id = authority.store_id
     AND policy_row.id = requested_policy_id
   FOR UPDATE OF policy_row;
  IF NOT FOUND OR target.row_version <> requested_version
     OR target.approved_by_staff_id <> authority.staff_id
     OR target.status <> 'active' OR target.next_run_at > requested_now
     OR target.valid_from > requested_now
     OR (target.valid_until IS NOT NULL AND target.valid_until <= requested_now)
     OR (target.lease_until IS NOT NULL AND target.lease_until > requested_now)
     OR target.tool <> 'notification.delivery_batch.enqueue'
     OR requested_object_count NOT BETWEEN 1 AND LEAST(10,
       (target.object_filter_json ->> 'max_objects')::integer)
     OR requested_amount_cents NOT BETWEEN 0 AND 100000
     OR requested_args_sha256 !~ '^[0-9a-f]{64}$' THEN
    RETURN QUERY SELECT false, 'POLICY_DENIED'::text;
    RETURN;
  END IF;

  IF COALESCE((
       SELECT SUM(log_row.object_count)::integer
         FROM public.ai_action_log log_row
        WHERE log_row.org_id = authority.org_id
          AND log_row.store_id = authority.store_id
          AND log_row.started_at >= requested_now - interval '24 hours'
     ), 0) + requested_object_count > 10 THEN
    RETURN QUERY SELECT false, 'POLICY_DENIED'::text;
    RETURN;
  END IF;

  store_timezone := target.timezone;
  local_date := (requested_now AT TIME ZONE store_timezone)::date;
  local_time := (requested_now AT TIME ZONE store_timezone)::time;
  weekday := EXTRACT(DOW FROM local_date)::integer;
  IF NOT target.schedule_json -> 'days_of_week' @> to_jsonb(ARRAY[weekday])
     OR local_time < (target.schedule_json ->> 'window_start_local')::time
     OR local_time >= (target.schedule_json ->> 'window_end_local')::time THEN
    RETURN QUERY SELECT false, 'OUTSIDE_WINDOW'::text;
    RETURN;
  END IF;

  INSERT INTO public.automation_policy_usage_daily (
    org_id, store_id, policy_id, business_date, run_count, amount_cents, updated_at
  ) VALUES (
    authority.org_id, authority.store_id, requested_policy_id, local_date, 0, 0, requested_now
  ) ON CONFLICT (org_id, store_id, policy_id, business_date) DO NOTHING;
  SELECT usage.* INTO STRICT usage_row
    FROM public.automation_policy_usage_daily usage
   WHERE usage.org_id = authority.org_id AND usage.store_id = authority.store_id
     AND usage.policy_id = requested_policy_id AND usage.business_date = local_date
   FOR UPDATE;
  max_runs := (target.limits_json ->> 'max_runs_per_day')::integer;
  max_amount := (target.limits_json ->> 'max_amount_cents')::integer;
  IF usage_row.run_count + 1 > max_runs
     OR usage_row.amount_cents + requested_amount_cents > max_amount THEN
    UPDATE public.automation_policies
       SET status = 'quota_paused', row_version = row_version + 1, next_run_at = NULL,
           active_run_id = NULL, lease_token = NULL, lease_until = NULL,
           last_run_at = requested_now, last_outcome = 'denied', updated_at = requested_now
     WHERE id = requested_policy_id;
    INSERT INTO public.ai_action_log (
      id, org_id, store_id, policy_id, tool, decision, outcome, args_sha256,
      object_count, amount_cents, error_code, actor_staff_id, started_at, completed_at
    ) VALUES (
      requested_run_id, authority.org_id, authority.store_id, requested_policy_id,
      target.tool, 'policy', 'denied', requested_args_sha256, requested_object_count,
      requested_amount_cents, 'QUOTA_EXCEEDED', authority.staff_id, requested_now, requested_now
    );
    RETURN QUERY SELECT false, 'QUOTA_EXCEEDED'::text;
    RETURN;
  END IF;

  UPDATE public.automation_policy_usage_daily
     SET run_count = run_count + 1, amount_cents = amount_cents + requested_amount_cents,
         updated_at = requested_now
   WHERE org_id = authority.org_id AND store_id = authority.store_id
     AND policy_id = requested_policy_id AND business_date = local_date;
  UPDATE public.automation_policies
     SET active_run_id = requested_run_id, lease_token = requested_lease_token,
         lease_until = requested_now + interval '5 minutes'
   WHERE id = requested_policy_id;
  RETURN QUERY SELECT true, 'AUTHORIZED'::text;
END
$$;

CREATE FUNCTION public.automation_attempt_settle(
  requested_policy_id uuid,
  requested_run_id uuid,
  requested_lease_token uuid,
  requested_outcome text,
  requested_args_sha256 text,
  requested_object_count integer,
  requested_amount_cents integer,
  requested_error_code text,
  requested_started_at timestamptz,
  requested_completed_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  authority record;
  target record;
  store_timezone text;
  next_failures integer;
  next_status text;
  next_time timestamptz;
BEGIN
  SELECT * INTO authority FROM public.assert_automation_admin();
  SELECT policy_row.*, store_row.timezone INTO target
    FROM public.automation_policies policy_row
    JOIN public.stores store_row
      ON store_row.org_id = policy_row.org_id AND store_row.id = policy_row.store_id
   WHERE policy_row.org_id = authority.org_id AND policy_row.store_id = authority.store_id
     AND policy_row.id = requested_policy_id
   FOR UPDATE OF policy_row;
  IF NOT FOUND OR target.active_run_id <> requested_run_id
     OR target.lease_token <> requested_lease_token
     OR target.approved_by_staff_id <> authority.staff_id
     OR requested_outcome NOT IN ('executed', 'failed') THEN
    RETURN false;
  END IF;
  next_failures := CASE WHEN requested_outcome = 'failed'
    THEN LEAST(target.consecutive_failures + 1, 3) ELSE 0 END;
  next_status := CASE WHEN next_failures >= 3 THEN 'paused' ELSE 'active' END;
  store_timezone := target.timezone;
  next_time := CASE WHEN next_status = 'active'
    THEN public.automation_next_run(target.schedule_json, store_timezone, requested_completed_at)
    ELSE NULL END;
  INSERT INTO public.ai_action_log (
    id, org_id, store_id, policy_id, tool, decision, outcome, args_sha256,
    object_count, amount_cents, error_code, actor_staff_id, started_at, completed_at
  ) VALUES (
    requested_run_id, authority.org_id, authority.store_id, requested_policy_id,
    target.tool, 'policy', requested_outcome, requested_args_sha256, requested_object_count,
    requested_amount_cents, requested_error_code, authority.staff_id,
    requested_started_at, requested_completed_at
  );
  UPDATE public.automation_policies
     SET status = next_status, next_run_at = next_time, active_run_id = NULL,
         lease_token = NULL, lease_until = NULL, last_run_at = requested_completed_at,
         last_outcome = requested_outcome, consecutive_failures = next_failures,
         updated_at = requested_completed_at
   WHERE id = requested_policy_id;
  RETURN true;
END
$$;

CREATE FUNCTION public.automation_attempt_record(
  requested_policy_id uuid,
  requested_version integer,
  requested_run_id uuid,
  requested_outcome text,
  requested_args_sha256 text,
  requested_error_code text,
  requested_now timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  authority record;
  target record;
  store_timezone text;
BEGIN
  SELECT * INTO authority FROM public.assert_automation_admin();
  SELECT policy_row.*, store_row.timezone INTO target
    FROM public.automation_policies policy_row
    JOIN public.stores store_row
      ON store_row.org_id = policy_row.org_id AND store_row.id = policy_row.store_id
   WHERE policy_row.org_id = authority.org_id AND policy_row.store_id = authority.store_id
     AND policy_row.id = requested_policy_id
   FOR UPDATE OF policy_row;
  IF NOT FOUND OR target.row_version <> requested_version OR target.status <> 'active'
     OR target.approved_by_staff_id <> authority.staff_id
     OR requested_outcome NOT IN ('skipped', 'failed') THEN
    RETURN false;
  END IF;
  store_timezone := target.timezone;
  INSERT INTO public.ai_action_log (
    id, org_id, store_id, policy_id, tool, decision, outcome, args_sha256,
    object_count, amount_cents, error_code, actor_staff_id, started_at, completed_at
  ) VALUES (
    requested_run_id, authority.org_id, authority.store_id, requested_policy_id,
    target.tool, 'policy', requested_outcome, requested_args_sha256, 0, 0,
    requested_error_code, authority.staff_id, requested_now, requested_now
  );
  UPDATE public.automation_policies
     SET next_run_at = CASE
           WHEN requested_outcome = 'failed' AND consecutive_failures >= 2 THEN NULL
           ELSE public.automation_next_run(target.schedule_json, store_timezone, requested_now)
         END,
         last_run_at = requested_now, last_outcome = requested_outcome,
         consecutive_failures = CASE WHEN requested_outcome = 'failed'
           THEN LEAST(consecutive_failures + 1, 3) ELSE 0 END,
         status = CASE WHEN requested_outcome = 'failed' AND consecutive_failures >= 2
           THEN 'paused' ELSE status END,
         updated_at = requested_now
   WHERE id = requested_policy_id;
  RETURN true;
END
$$;

ALTER TABLE public.automation_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_policies FORCE ROW LEVEL SECURITY;
ALTER TABLE public.automation_policy_usage_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_policy_usage_daily FORCE ROW LEVEL SECURITY;
ALTER TABLE public.ai_action_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_action_log FORCE ROW LEVEL SECURITY;

CREATE POLICY automation_policies_store_scope ON public.automation_policies
  AS PERMISSIVE FOR ALL TO laundry_app
  USING (
    org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid
  );
CREATE POLICY automation_policy_usage_daily_store_scope ON public.automation_policy_usage_daily
  AS PERMISSIVE FOR ALL TO laundry_app
  USING (
    org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid
  );
CREATE POLICY ai_action_log_store_scope ON public.ai_action_log
  AS PERMISSIVE FOR ALL TO laundry_app
  USING (
    org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid
  );

CREATE POLICY automation_policies_maintenance ON public.automation_policies
  AS PERMISSIVE FOR ALL TO laundry_owner USING (true) WITH CHECK (true);
CREATE POLICY automation_policy_usage_daily_maintenance ON public.automation_policy_usage_daily
  AS PERMISSIVE FOR ALL TO laundry_owner USING (true) WITH CHECK (true);
CREATE POLICY ai_action_log_maintenance ON public.ai_action_log
  AS PERMISSIVE FOR ALL TO laundry_owner USING (true) WITH CHECK (true);

REVOKE ALL ON TABLE public.automation_policies FROM PUBLIC, laundry_app;
REVOKE ALL ON TABLE public.automation_policy_usage_daily FROM PUBLIC, laundry_app;
REVOKE ALL ON TABLE public.ai_action_log FROM PUBLIC, laundry_app;
GRANT SELECT ON TABLE public.automation_policies TO laundry_app;
GRANT SELECT ON TABLE public.ai_action_log TO laundry_app;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.automation_policies FROM laundry_app;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.automation_policy_usage_daily FROM laundry_app;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.ai_action_log FROM laundry_app;

REVOKE ALL ON FUNCTION public.assert_automation_admin() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.automation_next_run(jsonb, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.automation_policy_write(
  text, uuid, integer, text, text, text, jsonb, jsonb, jsonb, timestamptz, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.automation_due_policies(timestamptz, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.automation_attempt_begin(
  uuid, integer, uuid, uuid, integer, integer, text, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.automation_attempt_settle(
  uuid, uuid, uuid, text, text, integer, integer, text, timestamptz, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.automation_attempt_record(
  uuid, integer, uuid, text, text, text, timestamptz
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.automation_policy_write(
  text, uuid, integer, text, text, text, jsonb, jsonb, jsonb, timestamptz, timestamptz
) TO laundry_app;
GRANT EXECUTE ON FUNCTION public.automation_due_policies(timestamptz, integer) TO laundry_app;
GRANT EXECUTE ON FUNCTION public.automation_attempt_begin(
  uuid, integer, uuid, uuid, integer, integer, text, timestamptz
) TO laundry_app;
GRANT EXECUTE ON FUNCTION public.automation_attempt_settle(
  uuid, uuid, uuid, text, text, integer, integer, text, timestamptz, timestamptz
) TO laundry_app;
GRANT EXECUTE ON FUNCTION public.automation_attempt_record(
  uuid, integer, uuid, text, text, text, timestamptz
) TO laundry_app;
