-- ADR-59 / Stage 4.5 Item 18: provider-neutral AI safety and integer metering.
-- AI remains hard-off unless both a provider and an owner-managed enabled policy exist.

ALTER TABLE public.ai_turns
  ADD COLUMN input_redactions integer NOT NULL DEFAULT 0
    CHECK (input_redactions BETWEEN 0 AND 8000);
ALTER TABLE public.ai_usage
  ADD COLUMN estimated_cost_micros bigint NOT NULL DEFAULT 0
    CHECK (estimated_cost_micros BETWEEN 0 AND 9000000000000),
  ADD COLUMN input_redactions integer NOT NULL DEFAULT 0
    CHECK (input_redactions BETWEEN 0 AND 8000),
  ADD COLUMN output_redactions integer NOT NULL DEFAULT 0
    CHECK (output_redactions BETWEEN 0 AND 8000);

CREATE TABLE public.ai_safety_policies (
  org_id uuid PRIMARY KEY REFERENCES public.orgs (id),
  enabled boolean NOT NULL DEFAULT false,
  monthly_limit_micros bigint NOT NULL,
  input_micros_per_million bigint NOT NULL,
  output_micros_per_million bigint NOT NULL,
  circuit_failure_threshold integer NOT NULL DEFAULT 3,
  circuit_open_seconds integer NOT NULL DEFAULT 300,
  updated_at timestamptz NOT NULL,
  updated_by uuid NOT NULL,
  CONSTRAINT ai_safety_policy_staff_fk
    FOREIGN KEY (org_id, updated_by) REFERENCES public.staffs (org_id, id),
  CONSTRAINT ai_safety_policy_money_chk CHECK (
    monthly_limit_micros BETWEEN 0 AND 9000000000000
    AND input_micros_per_million BETWEEN 0 AND 1000000000000
    AND output_micros_per_million BETWEEN 0 AND 1000000000000
  ),
  CONSTRAINT ai_safety_policy_circuit_chk CHECK (
    circuit_failure_threshold BETWEEN 1 AND 20
    AND circuit_open_seconds BETWEEN 30 AND 3600
  )
);

CREATE TABLE public.ai_cost_reservations (
  turn_id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  staff_id uuid NOT NULL,
  auth_session_id uuid NOT NULL,
  usage_month date NOT NULL,
  reserved_cost_micros bigint NOT NULL,
  input_micros_per_million bigint NOT NULL,
  output_micros_per_million bigint NOT NULL,
  released_at timestamptz,
  created_at timestamptz NOT NULL,
  CONSTRAINT ai_cost_reservation_turn_fk
    FOREIGN KEY (org_id, store_id, turn_id) REFERENCES public.ai_turns (org_id, store_id, id),
  CONSTRAINT ai_cost_reservation_staff_fk
    FOREIGN KEY (org_id, staff_id) REFERENCES public.staffs (org_id, id),
  CONSTRAINT ai_cost_reservation_auth_fk
    FOREIGN KEY (auth_session_id) REFERENCES public.sessions (id),
  CONSTRAINT ai_cost_reservation_month_chk
    CHECK (usage_month = date_trunc('month', usage_month)::date),
  CONSTRAINT ai_cost_reservation_value_chk CHECK (
    reserved_cost_micros BETWEEN 0 AND 9000000000000
    AND input_micros_per_million BETWEEN 0 AND 1000000000000
    AND output_micros_per_million BETWEEN 0 AND 1000000000000
  ),
  CONSTRAINT ai_cost_reservation_time_chk
    CHECK (released_at IS NULL OR released_at >= created_at)
);
CREATE INDEX ai_cost_reservations_active_month_idx
  ON public.ai_cost_reservations (org_id, usage_month) WHERE released_at IS NULL;

CREATE TABLE public.ai_usage_daily (
  org_id uuid NOT NULL REFERENCES public.orgs (id),
  store_id uuid NOT NULL,
  usage_date date NOT NULL,
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  estimated_cost_micros bigint NOT NULL DEFAULT 0,
  turn_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (org_id, store_id, usage_date),
  CONSTRAINT ai_usage_daily_store_fk
    FOREIGN KEY (org_id, store_id) REFERENCES public.stores (org_id, id),
  CONSTRAINT ai_usage_daily_nonnegative_chk CHECK (
    input_tokens >= 0 AND output_tokens >= 0 AND estimated_cost_micros >= 0 AND turn_count >= 0
  )
);

CREATE TABLE public.ai_circuit_breakers (
  org_id uuid PRIMARY KEY REFERENCES public.orgs (id),
  consecutive_failures integer NOT NULL DEFAULT 0,
  opened_until timestamptz,
  updated_at timestamptz NOT NULL,
  CONSTRAINT ai_circuit_breaker_count_chk CHECK (consecutive_failures BETWEEN 0 AND 1000000)
);

CREATE TABLE public.ai_safety_events (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES public.orgs (id),
  store_id uuid NOT NULL,
  staff_id uuid NOT NULL,
  auth_session_id uuid NOT NULL,
  ai_session_id uuid,
  turn_id uuid,
  event_type text NOT NULL,
  reason_code text NOT NULL,
  content_sha256 char(64),
  created_at timestamptz NOT NULL,
  CONSTRAINT ai_safety_event_store_fk
    FOREIGN KEY (org_id, store_id) REFERENCES public.stores (org_id, id),
  CONSTRAINT ai_safety_event_staff_fk
    FOREIGN KEY (org_id, staff_id) REFERENCES public.staffs (org_id, id),
  CONSTRAINT ai_safety_event_auth_fk
    FOREIGN KEY (auth_session_id) REFERENCES public.sessions (id),
  CONSTRAINT ai_safety_event_session_fk
    FOREIGN KEY (org_id, store_id, ai_session_id)
    REFERENCES public.ai_sessions (org_id, store_id, id),
  CONSTRAINT ai_safety_event_turn_fk
    FOREIGN KEY (org_id, store_id, turn_id) REFERENCES public.ai_turns (org_id, store_id, id),
  CONSTRAINT ai_safety_event_type_chk
    CHECK (event_type IN ('prompt_rejected', 'budget_denied', 'circuit_denied', 'circuit_opened')),
  CONSTRAINT ai_safety_event_reason_chk
    CHECK (reason_code IN ('AI_PROMPT_INJECTION', 'AI_BUDGET_EXCEEDED', 'AI_CIRCUIT_OPEN')),
  CONSTRAINT ai_safety_event_hash_chk
    CHECK (content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ai_safety_event_shape_chk CHECK (
    (event_type = 'prompt_rejected' AND reason_code = 'AI_PROMPT_INJECTION'
      AND ai_session_id IS NOT NULL AND turn_id IS NULL AND content_sha256 IS NOT NULL)
    OR (event_type = 'budget_denied' AND reason_code = 'AI_BUDGET_EXCEEDED'
      AND ai_session_id IS NOT NULL AND turn_id IS NOT NULL AND content_sha256 IS NULL)
    OR (event_type IN ('circuit_denied', 'circuit_opened') AND reason_code = 'AI_CIRCUIT_OPEN'
      AND ai_session_id IS NOT NULL AND turn_id IS NOT NULL AND content_sha256 IS NULL)
  )
);

CREATE FUNCTION public.ai_turn_create_safe(
  requested_id uuid, requested_session_id uuid, requested_auth_session_id uuid,
  requested_idempotency_key uuid, requested_prompt text, requested_prompt_sha256 char(64),
  requested_max_output_tokens integer, requested_message_id uuid, requested_audit_id uuid,
  requested_input_redactions integer
)
RETURNS TABLE (turn_id uuid, replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE created record;
BEGIN
  IF requested_input_redactions NOT BETWEEN 0 AND 8000 THEN
    RAISE check_violation USING MESSAGE = 'AI redaction count is invalid';
  END IF;
  SELECT * INTO created FROM public.ai_turn_create(
      requested_id, requested_session_id, requested_auth_session_id,
      requested_idempotency_key, requested_prompt, requested_prompt_sha256,
      requested_max_output_tokens, requested_message_id, requested_audit_id
    );
  IF NOT created.replayed THEN
    UPDATE public.ai_turns SET input_redactions = requested_input_redactions
     WHERE id = requested_id;
  END IF;
  turn_id := created.turn_id;
  replayed := created.replayed;
  RETURN NEXT;
END
$$;

CREATE FUNCTION public.ai_turn_safety_authorize(
  requested_turn_id uuid, requested_auth_session_id uuid, requested_estimated_input_tokens integer
)
RETURNS TABLE (
  started boolean, denial_code text,
  input_micros_per_million bigint, output_micros_per_million bigint
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  authority record; target record;
  month_start date := date_trunc('month', statement_timestamp())::date;
  spent bigint := 0; reserved bigint := 0; reservation bigint := 0; denial text := NULL;
  policy_found boolean := false; policy_enabled boolean := false; policy_limit bigint := 0;
  input_price bigint := 0; output_price bigint := 0; breaker_until timestamptz := NULL;
BEGIN
  IF requested_estimated_input_tokens NOT BETWEEN 0 AND 20000 THEN
    RAISE check_violation USING MESSAGE = 'AI input estimate is invalid';
  END IF;
  SELECT * INTO authority FROM public.assert_ai_stream_authority(requested_auth_session_id);
  SELECT * INTO target FROM public.ai_turns turn_value
   WHERE turn_value.id = requested_turn_id AND turn_value.org_id = authority.org_id
     AND turn_value.store_id = authority.store_id AND turn_value.staff_id = authority.staff_id
     AND turn_value.auth_session_id = requested_auth_session_id FOR UPDATE;
  IF NOT FOUND OR target.status <> 'queued' THEN RETURN; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(authority.org_id::text || ':ai-budget', 0));
  SELECT policy.enabled, policy.monthly_limit_micros, policy.input_micros_per_million,
         policy.output_micros_per_million
    INTO policy_enabled, policy_limit, input_price, output_price
    FROM public.ai_safety_policies policy WHERE policy.org_id = authority.org_id FOR SHARE;
  policy_found := FOUND;
  policy_enabled := COALESCE(policy_enabled, false);
  policy_limit := COALESCE(policy_limit, 0);
  input_price := COALESCE(input_price, 0);
  output_price := COALESCE(output_price, 0);
  SELECT opened_until INTO breaker_until FROM public.ai_circuit_breakers
   WHERE org_id = authority.org_id FOR UPDATE;
  IF NOT policy_found OR NOT policy_enabled OR policy_limit <= 0 THEN
    denial := 'AI_BUDGET_EXCEEDED';
  ELSIF breaker_until IS NOT NULL AND breaker_until > statement_timestamp() THEN
    denial := 'AI_CIRCUIT_OPEN';
  ELSE
    SELECT COALESCE(SUM(estimated_cost_micros), 0) INTO spent FROM public.ai_usage_daily
     WHERE org_id = authority.org_id AND usage_date >= month_start;
    SELECT COALESCE(SUM(reserved_cost_micros), 0) INTO reserved
      FROM public.ai_cost_reservations
     WHERE org_id = authority.org_id AND usage_month = month_start AND released_at IS NULL;
    reservation := CEIL((requested_estimated_input_tokens::numeric * input_price
      + target.max_output_tokens::numeric * output_price) / 1000000)::bigint;
    IF spent + reserved + reservation > policy_limit THEN
      denial := 'AI_BUDGET_EXCEEDED'; reservation := 0;
    END IF;
  END IF;
  INSERT INTO public.ai_cost_reservations (
    turn_id, org_id, store_id, staff_id, auth_session_id, usage_month,
    reserved_cost_micros, input_micros_per_million, output_micros_per_million, created_at
  ) VALUES (
    target.id, authority.org_id, authority.store_id, authority.staff_id,
    requested_auth_session_id, month_start, reservation,
    input_price, output_price, statement_timestamp()
  );
  started := public.ai_turn_start(requested_turn_id, requested_auth_session_id);
  denial_code := denial;
  input_micros_per_million := input_price;
  output_micros_per_million := output_price;
  IF denial IS NOT NULL THEN
    INSERT INTO public.ai_safety_events (
      id, org_id, store_id, staff_id, auth_session_id, ai_session_id, turn_id,
      event_type, reason_code, created_at
    ) VALUES (
      requested_turn_id, authority.org_id, authority.store_id, authority.staff_id,
      requested_auth_session_id, target.ai_session_id, target.id,
      CASE WHEN denial = 'AI_CIRCUIT_OPEN' THEN 'circuit_denied' ELSE 'budget_denied' END,
      denial, statement_timestamp()
    );
  END IF;
  RETURN NEXT;
END
$$;

CREATE FUNCTION public.ai_turn_finish_metered(
  requested_turn_id uuid, requested_auth_session_id uuid, requested_status text,
  requested_error_code text, requested_input_tokens integer, requested_output_tokens integer,
  requested_assistant_message_id uuid, requested_assistant_text text,
  requested_assistant_sha256 char(64), requested_usage_id uuid, requested_audit_id uuid,
  requested_cost_micros bigint, requested_input_redactions integer,
  requested_output_redactions integer
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  authority record; target record; reservation record;
  calculated_cost bigint; changed boolean; db_now timestamptz := statement_timestamp();
  failure_threshold integer := 3; open_seconds integer := 300;
  was_open boolean := false; now_open boolean := false;
BEGIN
  SELECT * INTO authority FROM public.assert_ai_stream_authority(requested_auth_session_id);
  SELECT * INTO target FROM public.ai_turns turn_value
   WHERE turn_value.id = requested_turn_id AND turn_value.org_id = authority.org_id
     AND turn_value.store_id = authority.store_id AND turn_value.auth_session_id = requested_auth_session_id
   FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO reservation FROM public.ai_cost_reservations
   WHERE turn_id = requested_turn_id AND released_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  calculated_cost := CEIL((requested_input_tokens::numeric * reservation.input_micros_per_million
    + requested_output_tokens::numeric * reservation.output_micros_per_million) / 1000000)::bigint;
  IF calculated_cost <> requested_cost_micros OR requested_input_redactions <> target.input_redactions
     OR requested_output_redactions NOT BETWEEN 0 AND 8000 THEN
    RAISE check_violation USING MESSAGE = 'AI metering evidence mismatch';
  END IF;
  changed := public.ai_turn_finish(
    requested_turn_id, requested_auth_session_id, requested_status, requested_error_code,
    requested_input_tokens, requested_output_tokens, requested_assistant_message_id,
    requested_assistant_text, requested_assistant_sha256, requested_usage_id, requested_audit_id
  );
  IF NOT changed THEN RETURN false; END IF;
  UPDATE public.ai_usage SET estimated_cost_micros = calculated_cost,
    input_redactions = requested_input_redactions, output_redactions = requested_output_redactions
   WHERE turn_id = requested_turn_id;
  INSERT INTO public.ai_usage_daily (
    org_id, store_id, usage_date, input_tokens, output_tokens,
    estimated_cost_micros, turn_count, updated_at
  ) VALUES (
    authority.org_id, authority.store_id, db_now::date, requested_input_tokens,
    requested_output_tokens, calculated_cost, 1, db_now
  ) ON CONFLICT (org_id, store_id, usage_date) DO UPDATE SET
    input_tokens = ai_usage_daily.input_tokens + EXCLUDED.input_tokens,
    output_tokens = ai_usage_daily.output_tokens + EXCLUDED.output_tokens,
    estimated_cost_micros = ai_usage_daily.estimated_cost_micros + EXCLUDED.estimated_cost_micros,
    turn_count = ai_usage_daily.turn_count + 1, updated_at = EXCLUDED.updated_at;
  UPDATE public.ai_cost_reservations SET released_at = db_now WHERE turn_id = requested_turn_id;
  SELECT circuit_failure_threshold, circuit_open_seconds
    INTO failure_threshold, open_seconds FROM public.ai_safety_policies
   WHERE org_id = authority.org_id;
  failure_threshold := COALESCE(failure_threshold, 3);
  open_seconds := COALESCE(open_seconds, 300);
  IF requested_error_code = 'AI_PROVIDER_FAILED' THEN
    SELECT opened_until > db_now INTO was_open FROM public.ai_circuit_breakers
     WHERE org_id = authority.org_id;
    was_open := COALESCE(was_open, false);
    INSERT INTO public.ai_circuit_breakers (org_id, consecutive_failures, opened_until, updated_at)
    VALUES (
      authority.org_id, 1,
      CASE WHEN failure_threshold <= 1
        THEN db_now + make_interval(secs => open_seconds) END,
      db_now
    ) ON CONFLICT (org_id) DO UPDATE SET
      consecutive_failures = ai_circuit_breakers.consecutive_failures + 1,
      opened_until = CASE
        WHEN ai_circuit_breakers.consecutive_failures + 1
          >= failure_threshold
        THEN db_now + make_interval(secs => open_seconds)
        ELSE ai_circuit_breakers.opened_until END,
      updated_at = db_now;
    SELECT opened_until > db_now INTO now_open FROM public.ai_circuit_breakers
     WHERE org_id = authority.org_id;
    IF NOT was_open AND COALESCE(now_open, false) THEN
      INSERT INTO public.ai_safety_events (
        id, org_id, store_id, staff_id, auth_session_id, ai_session_id, turn_id,
        event_type, reason_code, created_at
      ) VALUES (
        requested_usage_id, authority.org_id, authority.store_id, authority.staff_id,
        requested_auth_session_id, target.ai_session_id, target.id,
        'circuit_opened', 'AI_CIRCUIT_OPEN', db_now
      );
    END IF;
  ELSIF requested_status = 'completed' THEN
    INSERT INTO public.ai_circuit_breakers (org_id, consecutive_failures, opened_until, updated_at)
    VALUES (authority.org_id, 0, NULL, db_now)
    ON CONFLICT (org_id) DO UPDATE SET consecutive_failures = 0,
      opened_until = NULL, updated_at = db_now;
  END IF;
  RETURN true;
END
$$;

CREATE FUNCTION public.ai_safety_rejection_record(
  requested_id uuid, requested_session_id uuid, requested_auth_session_id uuid,
  requested_code text, requested_content_sha256 char(64), requested_audit_id uuid
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE authority record; target record; db_now timestamptz := statement_timestamp();
BEGIN
  SELECT * INTO authority FROM public.assert_ai_stream_authority(requested_auth_session_id);
  SELECT * INTO target FROM public.ai_sessions session_value
   WHERE session_value.id = requested_session_id AND session_value.org_id = authority.org_id
     AND session_value.store_id = authority.store_id
     AND session_value.auth_session_id = requested_auth_session_id FOR SHARE;
  IF NOT FOUND OR requested_code <> 'AI_PROMPT_INJECTION' THEN
    RAISE insufficient_privilege USING MESSAGE = 'AI safety rejection unavailable';
  END IF;
  INSERT INTO public.ai_safety_events (
    id, org_id, store_id, staff_id, auth_session_id, ai_session_id,
    event_type, reason_code, content_sha256, created_at
  ) VALUES (
    requested_id, authority.org_id, authority.store_id, authority.staff_id,
    requested_auth_session_id, target.id, 'prompt_rejected', requested_code,
    requested_content_sha256, db_now
  );
  INSERT INTO public.audit_log (
    id, org_id, store_id, staff_id, via, command, idempotency_key, dry_run,
    entity, entity_id, before_json, after_json, ip, device_id, at
  ) VALUES (
    requested_audit_id, authority.org_id, authority.store_id, authority.staff_id,
    'ai', 'ai.safety.reject', requested_id::text, false, 'ai_session', target.id::text,
    NULL, jsonb_build_object('reason', requested_code,
      'content_sha256', requested_content_sha256)::text, NULL, authority.device_id, db_now
  );
  RETURN requested_id;
END
$$;

CREATE FUNCTION public.ai_safety_status(requested_auth_session_id uuid)
RETURNS TABLE (
  month text, input_tokens bigint, output_tokens bigint, estimated_cost_micros bigint,
  monthly_limit_micros bigint, remaining_micros bigint, circuit_state text,
  circuit_open_until timestamptz
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  authority record; cost bigint := 0; policy_limit bigint := 0;
  policy_enabled boolean := false; breaker_until timestamptz := NULL;
  db_now timestamptz := statement_timestamp();
BEGIN
  SELECT * INTO authority FROM public.assert_ai_stream_authority(requested_auth_session_id);
  IF NOT EXISTS (
    SELECT 1 FROM public.staffs staff
    JOIN public.staff_store_roles staff_role
      ON staff_role.org_id = staff.org_id AND staff_role.staff_id = staff.id
    WHERE staff.org_id = authority.org_id AND staff.id = authority.staff_id
      AND staff.is_active AND staff_role.store_id = authority.store_id
      AND staff_role.role = 'admin' AND staff_role.is_active
  ) THEN RAISE insufficient_privilege USING MESSAGE = 'AI owner status unavailable'; END IF;
  SELECT policy.enabled, policy.monthly_limit_micros INTO policy_enabled, policy_limit
    FROM public.ai_safety_policies policy WHERE policy.org_id = authority.org_id;
  SELECT opened_until INTO breaker_until FROM public.ai_circuit_breakers
   WHERE org_id = authority.org_id;
  SELECT COALESCE(SUM(daily.input_tokens), 0), COALESCE(SUM(daily.output_tokens), 0),
         COALESCE(SUM(daily.estimated_cost_micros), 0)
    INTO input_tokens, output_tokens, cost FROM public.ai_usage_daily daily
   WHERE daily.org_id = authority.org_id
     AND daily.usage_date >= date_trunc('month', db_now)::date
     AND daily.usage_date < (date_trunc('month', db_now) + interval '1 month')::date;
  month := to_char(db_now, 'YYYY-MM');
  estimated_cost_micros := cost;
  monthly_limit_micros := CASE WHEN COALESCE(policy_enabled, false) THEN policy_limit ELSE 0 END;
  remaining_micros := GREATEST(0, monthly_limit_micros - cost);
  circuit_state := CASE WHEN breaker_until > db_now THEN 'open' ELSE 'closed' END;
  circuit_open_until := CASE WHEN breaker_until > db_now THEN breaker_until END;
  RETURN NEXT;
END
$$;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'ai_safety_policies', 'ai_cost_reservations', 'ai_usage_daily',
    'ai_circuit_breakers', 'ai_safety_events'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS PERMISSIVE FOR ALL TO laundry_owner
       USING (true) WITH CHECK (true)', table_name || '_maintenance', table_name
    );
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, laundry_app', table_name);
  END LOOP;
END
$$;

REVOKE ALL ON FUNCTION public.ai_turn_create_safe(uuid, uuid, uuid, uuid, text, char, integer, uuid, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ai_turn_safety_authorize(uuid, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ai_turn_finish_metered(uuid, uuid, text, text, integer, integer, uuid, text, char, uuid, uuid, bigint, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ai_safety_rejection_record(uuid, uuid, uuid, text, char, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ai_safety_status(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.ai_turn_create(uuid, uuid, uuid, uuid, text, char, integer, uuid, uuid) FROM laundry_app;
REVOKE EXECUTE ON FUNCTION public.ai_turn_start(uuid, uuid) FROM laundry_app;
REVOKE EXECUTE ON FUNCTION public.ai_turn_finish(uuid, uuid, text, text, integer, integer, uuid, text, char, uuid, uuid) FROM laundry_app;
GRANT EXECUTE ON FUNCTION public.ai_turn_create_safe(uuid, uuid, uuid, uuid, text, char, integer, uuid, uuid, integer) TO laundry_app;
GRANT EXECUTE ON FUNCTION public.ai_turn_safety_authorize(uuid, uuid, integer) TO laundry_app;
GRANT EXECUTE ON FUNCTION public.ai_turn_finish_metered(uuid, uuid, text, text, integer, integer, uuid, text, char, uuid, uuid, bigint, integer, integer) TO laundry_app;
GRANT EXECUTE ON FUNCTION public.ai_safety_rejection_record(uuid, uuid, uuid, text, char, uuid) TO laundry_app;
GRANT EXECUTE ON FUNCTION public.ai_safety_status(uuid) TO laundry_app;
