-- ADR-58 / Stage 4.5 Item 14: provider-neutral, bounded AI conversations.
-- No provider, endpoint, header, credential, prompt, response, or tool arguments
-- are copied into audit rows. The public application role writes only through
-- the closed SECURITY DEFINER function surface below.

CREATE TABLE public.ai_sessions (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  staff_id uuid NOT NULL,
  auth_session_id uuid NOT NULL,
  status text NOT NULL,
  next_event_cursor bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  closed_at timestamptz,
  CONSTRAINT ai_sessions_store_fk
    FOREIGN KEY (org_id, store_id) REFERENCES public.stores (org_id, id),
  CONSTRAINT ai_sessions_staff_fk
    FOREIGN KEY (org_id, staff_id) REFERENCES public.staffs (org_id, id),
  CONSTRAINT ai_sessions_auth_fk FOREIGN KEY (auth_session_id) REFERENCES public.sessions (id),
  CONSTRAINT ai_sessions_tenant_id_uidx UNIQUE (org_id, store_id, id),
  CONSTRAINT ai_sessions_status_chk
    CHECK (status IN ('open', 'running', 'completed', 'failed', 'cancelled')),
  CONSTRAINT ai_sessions_cursor_chk CHECK (next_event_cursor >= 0),
  CONSTRAINT ai_sessions_time_chk CHECK (
    updated_at >= created_at
    AND ((status IN ('open', 'running') AND closed_at IS NULL)
      OR (status IN ('completed', 'failed', 'cancelled') AND closed_at IS NOT NULL))
  )
);

CREATE TABLE public.ai_turns (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  staff_id uuid NOT NULL,
  auth_session_id uuid NOT NULL,
  ai_session_id uuid NOT NULL,
  idempotency_key uuid NOT NULL,
  prompt_sha256 char(64) NOT NULL,
  prompt_chars integer NOT NULL,
  max_output_tokens integer NOT NULL,
  status text NOT NULL,
  output_bytes integer NOT NULL DEFAULT 0,
  event_count integer NOT NULL DEFAULT 0,
  tool_steps integer NOT NULL DEFAULT 0,
  error_code text,
  created_at timestamptz NOT NULL,
  started_at timestamptz,
  completed_at timestamptz,
  CONSTRAINT ai_turns_session_fk
    FOREIGN KEY (org_id, store_id, ai_session_id)
    REFERENCES public.ai_sessions (org_id, store_id, id),
  CONSTRAINT ai_turns_idempotency_uidx UNIQUE (ai_session_id, idempotency_key),
  CONSTRAINT ai_turns_tenant_id_uidx UNIQUE (org_id, store_id, id),
  CONSTRAINT ai_turns_hash_chk CHECK (prompt_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ai_turns_prompt_chars_chk CHECK (prompt_chars BETWEEN 1 AND 8000),
  CONSTRAINT ai_turns_output_tokens_chk CHECK (max_output_tokens BETWEEN 1 AND 1024),
  CONSTRAINT ai_turns_status_chk
    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  CONSTRAINT ai_turns_budget_chk CHECK (
    output_bytes BETWEEN 0 AND 32768
    AND event_count BETWEEN 0 AND 256
    AND tool_steps BETWEEN 0 AND 4
  ),
  CONSTRAINT ai_turns_error_chk CHECK (
    (status IN ('queued', 'running', 'completed') AND error_code IS NULL)
    OR (status IN ('failed', 'cancelled') AND error_code IN (
      'AI_UNAVAILABLE', 'AI_ABORTED', 'AI_DEADLINE_EXCEEDED', 'AI_OUTPUT_LIMIT',
      'AI_TOOL_LIMIT', 'AI_TOOL_TIMEOUT', 'AI_PROVIDER_FAILED'
    ))
  )
);

CREATE UNIQUE INDEX ai_turns_one_active_uidx ON public.ai_turns (ai_session_id)
  WHERE status IN ('queued', 'running');
CREATE INDEX ai_turns_staff_recent_idx
  ON public.ai_turns (org_id, store_id, staff_id, created_at DESC, id);

CREATE TABLE public.ai_messages (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  staff_id uuid NOT NULL,
  auth_session_id uuid NOT NULL,
  ai_session_id uuid NOT NULL,
  turn_id uuid NOT NULL,
  sequence integer NOT NULL,
  role text NOT NULL,
  content text NOT NULL,
  content_sha256 char(64) NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT ai_messages_session_fk
    FOREIGN KEY (org_id, store_id, ai_session_id)
    REFERENCES public.ai_sessions (org_id, store_id, id),
  CONSTRAINT ai_messages_turn_fk
    FOREIGN KEY (org_id, store_id, turn_id) REFERENCES public.ai_turns (org_id, store_id, id),
  CONSTRAINT ai_messages_sequence_uidx UNIQUE (ai_session_id, sequence),
  CONSTRAINT ai_messages_role_chk CHECK (role IN ('user', 'assistant')),
  CONSTRAINT ai_messages_content_chk CHECK (
    char_length(content) BETWEEN 1 AND 8000 AND octet_length(content) <= 32768
  ),
  CONSTRAINT ai_messages_hash_chk CHECK (content_sha256 ~ '^[0-9a-f]{64}$')
);

CREATE TABLE public.ai_stream_events (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  staff_id uuid NOT NULL,
  auth_session_id uuid NOT NULL,
  ai_session_id uuid NOT NULL,
  turn_id uuid NOT NULL,
  cursor bigint NOT NULL,
  event_type text NOT NULL,
  text_delta text,
  tool_name text,
  tool_step integer,
  tool_outcome text,
  finish_reason text,
  error_code text,
  input_tokens integer,
  output_tokens integer,
  created_at timestamptz NOT NULL,
  CONSTRAINT ai_stream_events_session_fk
    FOREIGN KEY (org_id, store_id, ai_session_id)
    REFERENCES public.ai_sessions (org_id, store_id, id),
  CONSTRAINT ai_stream_events_turn_fk
    FOREIGN KEY (org_id, store_id, turn_id) REFERENCES public.ai_turns (org_id, store_id, id),
  CONSTRAINT ai_stream_events_cursor_uidx UNIQUE (ai_session_id, cursor),
  CONSTRAINT ai_stream_events_cursor_chk CHECK (cursor BETWEEN 1 AND 256),
  CONSTRAINT ai_stream_events_type_chk
    CHECK (event_type IN ('content_delta', 'tool_call', 'tool_result', 'done', 'error')),
  CONSTRAINT ai_stream_events_shape_chk CHECK (
    (event_type = 'content_delta' AND char_length(text_delta) BETWEEN 1 AND 4096
      AND tool_name IS NULL AND error_code IS NULL AND finish_reason IS NULL)
    OR (event_type = 'tool_call' AND text_delta IS NULL
      AND tool_name = 'synthetic.lookup' AND tool_step BETWEEN 1 AND 4)
    OR (event_type = 'tool_result' AND text_delta IS NULL
      AND tool_name = 'synthetic.lookup' AND tool_step BETWEEN 1 AND 4
      AND tool_outcome IN ('succeeded', 'failed', 'timed_out', 'cancelled'))
    OR (event_type = 'done' AND text_delta IS NULL AND finish_reason IN ('stop', 'limit')
      AND input_tokens >= 0 AND output_tokens >= 0 AND error_code IS NULL)
    OR (event_type = 'error' AND text_delta IS NULL AND error_code IN (
      'AI_UNAVAILABLE', 'AI_ABORTED', 'AI_DEADLINE_EXCEEDED', 'AI_OUTPUT_LIMIT',
      'AI_TOOL_LIMIT', 'AI_TOOL_TIMEOUT', 'AI_PROVIDER_FAILED'
    ))
  )
);

CREATE TABLE public.ai_usage (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  staff_id uuid NOT NULL,
  auth_session_id uuid NOT NULL,
  ai_session_id uuid NOT NULL,
  turn_id uuid NOT NULL,
  input_tokens integer NOT NULL,
  output_tokens integer NOT NULL,
  output_bytes integer NOT NULL,
  event_count integer NOT NULL,
  tool_steps integer NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT ai_usage_turn_uidx UNIQUE (turn_id),
  CONSTRAINT ai_usage_turn_fk
    FOREIGN KEY (org_id, store_id, turn_id) REFERENCES public.ai_turns (org_id, store_id, id),
  CONSTRAINT ai_usage_bounded_chk CHECK (
    input_tokens BETWEEN 0 AND 20000 AND output_tokens BETWEEN 0 AND 1024
    AND output_bytes BETWEEN 0 AND 32768 AND event_count BETWEEN 0 AND 256
    AND tool_steps BETWEEN 0 AND 4
  )
);

CREATE TABLE public.ai_tool_attempts (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  staff_id uuid NOT NULL,
  auth_session_id uuid NOT NULL,
  ai_session_id uuid NOT NULL,
  turn_id uuid NOT NULL,
  step integer NOT NULL,
  tool_name text NOT NULL,
  request_sha256 char(64) NOT NULL,
  result_sha256 char(64),
  outcome text NOT NULL,
  duration_ms integer NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT ai_tool_attempts_turn_fk
    FOREIGN KEY (org_id, store_id, turn_id) REFERENCES public.ai_turns (org_id, store_id, id),
  CONSTRAINT ai_tool_attempts_step_uidx UNIQUE (turn_id, step),
  CONSTRAINT ai_tool_attempts_allowlist_chk CHECK (tool_name = 'synthetic.lookup'),
  CONSTRAINT ai_tool_attempts_hash_chk CHECK (
    request_sha256 ~ '^[0-9a-f]{64}$'
    AND (result_sha256 IS NULL OR result_sha256 ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT ai_tool_attempts_outcome_chk
    CHECK (outcome IN ('succeeded', 'failed', 'timed_out', 'cancelled')),
  CONSTRAINT ai_tool_attempts_duration_chk CHECK (duration_ms BETWEEN 0 AND 5000)
);

CREATE FUNCTION public.assert_ai_stream_authority(requested_auth_session_id uuid)
RETURNS TABLE (org_id uuid, store_id uuid, staff_id uuid, device_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  requested_org uuid := NULLIF(current_setting('app.org_id', true), '')::uuid;
  requested_store uuid := NULLIF(current_setting('app.store_id', true), '')::uuid;
  requested_staff uuid := NULLIF(current_setting('app.staff_id', true), '')::uuid;
  bound_auth_session uuid := NULLIF(current_setting('app.auth_session_id', true), '')::uuid;
BEGIN
  IF requested_org IS NULL OR requested_store IS NULL OR requested_staff IS NULL
     OR bound_auth_session IS NULL OR bound_auth_session <> requested_auth_session_id THEN
    RAISE insufficient_privilege USING MESSAGE = 'AI session authority unavailable';
  END IF;
  RETURN QUERY
    SELECT session_row.org_id, session_row.store_id, session_row.staff_id, session_row.device_id
      FROM public.sessions session_row
     WHERE session_row.id = requested_auth_session_id
       AND session_row.org_id = requested_org
       AND session_row.store_id = requested_store
       AND session_row.staff_id = requested_staff
       AND session_row.status = 'active'
     LIMIT 1 FOR SHARE;
  IF NOT FOUND THEN
    RAISE insufficient_privilege USING MESSAGE = 'AI session authority unavailable';
  END IF;
END
$$;

CREATE FUNCTION public.ai_session_create(
  requested_id uuid, requested_auth_session_id uuid, requested_audit_id uuid
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE authority record; db_now timestamptz := statement_timestamp();
BEGIN
  SELECT * INTO authority FROM public.assert_ai_stream_authority(requested_auth_session_id);
  INSERT INTO public.ai_sessions (
    id, org_id, store_id, staff_id, auth_session_id, status,
    next_event_cursor, created_at, updated_at, closed_at
  ) VALUES (
    requested_id, authority.org_id, authority.store_id, authority.staff_id,
    requested_auth_session_id, 'open', 0, db_now, db_now, NULL
  );
  INSERT INTO public.audit_log (
    id, org_id, store_id, staff_id, via, command, idempotency_key, dry_run,
    entity, entity_id, before_json, after_json, ip, device_id, at
  ) VALUES (
    requested_audit_id, authority.org_id, authority.store_id, authority.staff_id,
    'ui', 'ai.session.create', NULL, false, 'ai_session', requested_id::text,
    NULL, '{"status":"open"}', NULL, authority.device_id, db_now
  );
  RETURN requested_id;
END
$$;

CREATE FUNCTION public.ai_turn_create(
  requested_id uuid, requested_session_id uuid, requested_auth_session_id uuid,
  requested_idempotency_key uuid, requested_prompt text, requested_prompt_sha256 char(64),
  requested_max_output_tokens integer, requested_message_id uuid, requested_audit_id uuid
)
RETURNS TABLE (turn_id uuid, turn_status text, replayed boolean, created_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE authority record; session_row record; existing record; db_now timestamptz := statement_timestamp();
BEGIN
  SELECT * INTO authority FROM public.assert_ai_stream_authority(requested_auth_session_id);
  PERFORM pg_advisory_xact_lock(hashtextextended(requested_session_id::text, 0));
  SELECT * INTO session_row FROM public.ai_sessions session_value
   WHERE session_value.id = requested_session_id
     AND session_value.org_id = authority.org_id AND session_value.store_id = authority.store_id
     AND session_value.staff_id = authority.staff_id
     AND session_value.auth_session_id = requested_auth_session_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE object_not_in_prerequisite_state USING MESSAGE = 'AI session unavailable';
  END IF;
  SELECT * INTO existing FROM public.ai_turns turn_value
   WHERE turn_value.ai_session_id = requested_session_id
     AND turn_value.idempotency_key = requested_idempotency_key;
  IF FOUND THEN
    IF existing.prompt_sha256 <> requested_prompt_sha256
       OR existing.max_output_tokens <> requested_max_output_tokens THEN
      RAISE unique_violation USING MESSAGE = 'AI turn idempotency conflict';
    END IF;
    RETURN QUERY SELECT existing.id, existing.status, true, existing.created_at;
    RETURN;
  END IF;
  IF session_row.status NOT IN ('open', 'completed', 'failed', 'cancelled') THEN
    RAISE object_not_in_prerequisite_state USING MESSAGE = 'AI session unavailable';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ai_turns active_turn
    WHERE active_turn.ai_session_id = requested_session_id
      AND active_turn.status IN ('queued', 'running')) THEN
    RAISE serialization_failure USING MESSAGE = 'AI session already has an active turn';
  END IF;
  INSERT INTO public.ai_turns (
    id, org_id, store_id, staff_id, auth_session_id, ai_session_id,
    idempotency_key, prompt_sha256, prompt_chars, max_output_tokens, status, created_at
  ) VALUES (
    requested_id, authority.org_id, authority.store_id, authority.staff_id,
    requested_auth_session_id, requested_session_id, requested_idempotency_key,
    requested_prompt_sha256, char_length(requested_prompt), requested_max_output_tokens,
    'queued', db_now
  );
  INSERT INTO public.ai_messages (
    id, org_id, store_id, staff_id, auth_session_id, ai_session_id, turn_id,
    sequence, role, content, content_sha256, created_at
  ) VALUES (
    requested_message_id, authority.org_id, authority.store_id, authority.staff_id,
    requested_auth_session_id, requested_session_id, requested_id,
    COALESCE((SELECT MAX(message.sequence) + 1 FROM public.ai_messages message
      WHERE message.ai_session_id = requested_session_id), 1),
    'user', requested_prompt, requested_prompt_sha256, db_now
  );
  UPDATE public.ai_sessions SET status = 'open', updated_at = db_now, closed_at = NULL
   WHERE id = requested_session_id;
  INSERT INTO public.audit_log (
    id, org_id, store_id, staff_id, via, command, idempotency_key, dry_run,
    entity, entity_id, before_json, after_json, ip, device_id, at
  ) VALUES (
    requested_audit_id, authority.org_id, authority.store_id, authority.staff_id,
    'ui', 'ai.turn.create', requested_idempotency_key::text, false,
    'ai_turn', requested_id::text, NULL,
    jsonb_build_object('prompt_sha256', requested_prompt_sha256,
      'prompt_chars', char_length(requested_prompt),
      'max_output_tokens', requested_max_output_tokens)::text,
    NULL, authority.device_id, db_now
  );
  RETURN QUERY SELECT requested_id, 'queued'::text, false, db_now;
END
$$;

-- Store lifecycle/event writes are intentionally closed functions. Values are
-- validated again by table constraints; no arbitrary JSON or tool arguments enter storage.
CREATE FUNCTION public.ai_turn_start(requested_turn_id uuid, requested_auth_session_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE authority record; changed integer; db_now timestamptz := statement_timestamp();
BEGIN
  SELECT * INTO authority FROM public.assert_ai_stream_authority(requested_auth_session_id);
  UPDATE public.ai_turns SET status = 'running', started_at = db_now
   WHERE id = requested_turn_id AND org_id = authority.org_id AND store_id = authority.store_id
     AND staff_id = authority.staff_id AND auth_session_id = requested_auth_session_id
     AND status = 'queued';
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed = 1 THEN
    UPDATE public.ai_sessions SET status = 'running', updated_at = db_now
     WHERE id = (SELECT ai_session_id FROM public.ai_turns WHERE id = requested_turn_id);
  END IF;
  RETURN changed = 1;
END
$$;

CREATE FUNCTION public.ai_stream_event_append(
  requested_id uuid, requested_turn_id uuid, requested_auth_session_id uuid,
  requested_event_type text, requested_text_delta text, requested_tool_name text,
  requested_tool_step integer, requested_tool_outcome text, requested_finish_reason text,
  requested_error_code text, requested_input_tokens integer, requested_output_tokens integer
)
RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE authority record; target record; next_cursor bigint; db_now timestamptz := statement_timestamp();
BEGIN
  SELECT * INTO authority FROM public.assert_ai_stream_authority(requested_auth_session_id);
  SELECT * INTO target FROM public.ai_turns turn_value
   WHERE turn_value.id = requested_turn_id AND turn_value.org_id = authority.org_id
     AND turn_value.store_id = authority.store_id AND turn_value.staff_id = authority.staff_id
     AND turn_value.auth_session_id = requested_auth_session_id FOR UPDATE;
  IF NOT FOUND OR target.status <> 'running' THEN
    RAISE object_not_in_prerequisite_state USING MESSAGE = 'AI turn is not running';
  END IF;
  UPDATE public.ai_sessions SET next_event_cursor = next_event_cursor + 1, updated_at = db_now
   WHERE id = target.ai_session_id RETURNING next_event_cursor INTO next_cursor;
  INSERT INTO public.ai_stream_events (
    id, org_id, store_id, staff_id, auth_session_id, ai_session_id, turn_id, cursor,
    event_type, text_delta, tool_name, tool_step, tool_outcome, finish_reason,
    error_code, input_tokens, output_tokens, created_at
  ) VALUES (
    requested_id, authority.org_id, authority.store_id, authority.staff_id,
    requested_auth_session_id, target.ai_session_id, requested_turn_id, next_cursor,
    requested_event_type, requested_text_delta, requested_tool_name, requested_tool_step,
    requested_tool_outcome, requested_finish_reason, requested_error_code,
    requested_input_tokens, requested_output_tokens, db_now
  );
  UPDATE public.ai_turns SET
    output_bytes = output_bytes + COALESCE(octet_length(requested_text_delta), 0),
    event_count = event_count + 1,
    tool_steps = GREATEST(tool_steps, COALESCE(requested_tool_step, 0))
   WHERE id = requested_turn_id;
  RETURN next_cursor;
END
$$;

CREATE FUNCTION public.ai_tool_attempt_append(
  requested_id uuid, requested_turn_id uuid, requested_auth_session_id uuid,
  requested_step integer, requested_request_sha256 char(64), requested_result_sha256 char(64),
  requested_outcome text, requested_duration_ms integer
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE authority record; target record;
BEGIN
  SELECT * INTO authority FROM public.assert_ai_stream_authority(requested_auth_session_id);
  SELECT * INTO target FROM public.ai_turns turn_value
   WHERE turn_value.id = requested_turn_id AND turn_value.org_id = authority.org_id
     AND turn_value.store_id = authority.store_id AND turn_value.staff_id = authority.staff_id
     AND turn_value.auth_session_id = requested_auth_session_id FOR SHARE;
  IF NOT FOUND THEN RAISE insufficient_privilege USING MESSAGE = 'AI turn unavailable'; END IF;
  INSERT INTO public.ai_tool_attempts (
    id, org_id, store_id, staff_id, auth_session_id, ai_session_id, turn_id,
    step, tool_name, request_sha256, result_sha256, outcome, duration_ms, created_at
  ) VALUES (
    requested_id, authority.org_id, authority.store_id, authority.staff_id,
    requested_auth_session_id, target.ai_session_id, requested_turn_id,
    requested_step, 'synthetic.lookup', requested_request_sha256,
    requested_result_sha256, requested_outcome, requested_duration_ms, statement_timestamp()
  );
  RETURN requested_id;
END
$$;

CREATE FUNCTION public.ai_turn_finish(
  requested_turn_id uuid, requested_auth_session_id uuid, requested_status text,
  requested_error_code text, requested_input_tokens integer, requested_output_tokens integer,
  requested_assistant_message_id uuid, requested_assistant_text text,
  requested_assistant_sha256 char(64), requested_usage_id uuid, requested_audit_id uuid
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE authority record; target record; db_now timestamptz := statement_timestamp(); changed integer;
BEGIN
  SELECT * INTO authority FROM public.assert_ai_stream_authority(requested_auth_session_id);
  SELECT * INTO target FROM public.ai_turns turn_value
   WHERE turn_value.id = requested_turn_id AND turn_value.org_id = authority.org_id
     AND turn_value.store_id = authority.store_id AND turn_value.staff_id = authority.staff_id
     AND turn_value.auth_session_id = requested_auth_session_id FOR UPDATE;
  IF NOT FOUND OR target.status <> 'running' OR requested_status NOT IN ('completed', 'failed', 'cancelled') THEN
    RETURN false;
  END IF;
  UPDATE public.ai_turns SET status = requested_status, error_code = requested_error_code,
    completed_at = db_now WHERE id = requested_turn_id;
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF requested_assistant_text IS NOT NULL AND char_length(requested_assistant_text) > 0 THEN
    INSERT INTO public.ai_messages (
      id, org_id, store_id, staff_id, auth_session_id, ai_session_id, turn_id,
      sequence, role, content, content_sha256, created_at
    ) VALUES (
      requested_assistant_message_id, authority.org_id, authority.store_id, authority.staff_id,
      requested_auth_session_id, target.ai_session_id, requested_turn_id,
      COALESCE((SELECT MAX(message.sequence) + 1 FROM public.ai_messages message
        WHERE message.ai_session_id = target.ai_session_id), 1),
      'assistant', requested_assistant_text, requested_assistant_sha256, db_now
    );
  END IF;
  INSERT INTO public.ai_usage (
    id, org_id, store_id, staff_id, auth_session_id, ai_session_id, turn_id,
    input_tokens, output_tokens, output_bytes, event_count, tool_steps, created_at
  ) VALUES (
    requested_usage_id, authority.org_id, authority.store_id, authority.staff_id,
    requested_auth_session_id, target.ai_session_id, requested_turn_id,
    requested_input_tokens, requested_output_tokens, target.output_bytes,
    target.event_count, target.tool_steps, db_now
  );
  UPDATE public.ai_sessions SET status = requested_status, updated_at = db_now, closed_at = db_now
   WHERE id = target.ai_session_id;
  INSERT INTO public.audit_log (
    id, org_id, store_id, staff_id, via, command, idempotency_key, dry_run,
    entity, entity_id, before_json, after_json, ip, device_id, at
  ) VALUES (
    requested_audit_id, authority.org_id, authority.store_id, authority.staff_id,
    'ai', 'ai.turn.finish', target.idempotency_key::text, false,
    'ai_turn', requested_turn_id::text, NULL,
    jsonb_build_object('status', requested_status, 'input_tokens', requested_input_tokens,
      'output_tokens', requested_output_tokens, 'output_bytes', target.output_bytes,
      'event_count', target.event_count, 'tool_steps', target.tool_steps)::text,
    NULL, authority.device_id, db_now
  );
  RETURN changed = 1;
END
$$;

-- Staff + store RLS prevents another authenticated actor in the same tenant from
-- reading conversations. Every query also binds auth_session_id in server SQL.
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'ai_sessions', 'ai_turns', 'ai_messages', 'ai_stream_events', 'ai_usage', 'ai_tool_attempts'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS PERMISSIVE FOR SELECT TO laundry_app USING (
        org_id = NULLIF(current_setting(''app.org_id'', true), '''')::uuid
        AND store_id = NULLIF(current_setting(''app.store_id'', true), '''')::uuid
        AND staff_id = NULLIF(current_setting(''app.staff_id'', true), '''')::uuid
        AND auth_session_id = NULLIF(current_setting(''app.auth_session_id'', true), '''')::uuid)',
      table_name || '_staff_scope', table_name
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS PERMISSIVE FOR ALL TO laundry_owner
       USING (true) WITH CHECK (true)', table_name || '_maintenance', table_name
    );
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, laundry_app', table_name);
    EXECUTE format('GRANT SELECT ON TABLE public.%I TO laundry_app', table_name);
  END LOOP;
END
$$;

REVOKE ALL ON FUNCTION public.assert_ai_stream_authority(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ai_session_create(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ai_turn_create(uuid, uuid, uuid, uuid, text, char, integer, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ai_turn_start(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ai_stream_event_append(uuid, uuid, uuid, text, text, text, integer, text, text, text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ai_tool_attempt_append(uuid, uuid, uuid, integer, char, char, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ai_turn_finish(uuid, uuid, text, text, integer, integer, uuid, text, char, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ai_session_create(uuid, uuid, uuid) TO laundry_app;
GRANT EXECUTE ON FUNCTION public.ai_turn_create(uuid, uuid, uuid, uuid, text, char, integer, uuid, uuid) TO laundry_app;
GRANT EXECUTE ON FUNCTION public.ai_turn_start(uuid, uuid) TO laundry_app;
GRANT EXECUTE ON FUNCTION public.ai_stream_event_append(uuid, uuid, uuid, text, text, text, integer, text, text, text, integer, integer) TO laundry_app;
GRANT EXECUTE ON FUNCTION public.ai_tool_attempt_append(uuid, uuid, uuid, integer, char, char, text, integer) TO laundry_app;
GRANT EXECUTE ON FUNCTION public.ai_turn_finish(uuid, uuid, text, text, integer, integer, uuid, text, char, uuid, uuid) TO laundry_app;
