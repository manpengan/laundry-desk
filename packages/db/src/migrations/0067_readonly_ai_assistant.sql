-- ADR-62 / Stage 4.5 Item 15: closed, read-only business assistant tools.
-- This migration broadens only the Item 14 tool-name vocabulary. Arguments,
-- query results, prompts, PII, URLs, headers and provider material are never
-- stored in this table or in audit_log.

ALTER TABLE public.ai_stream_events DROP CONSTRAINT IF EXISTS ai_stream_events_shape_chk;
ALTER TABLE public.ai_stream_events
  ADD CONSTRAINT ai_stream_events_shape_chk CHECK (
    (event_type = 'content_delta' AND char_length(text_delta) BETWEEN 1 AND 4096
      AND tool_name IS NULL AND error_code IS NULL AND finish_reason IS NULL)
    OR (event_type = 'tool_call' AND text_delta IS NULL
      AND tool_name IN ('synthetic.lookup', 'business.summary', 'records.search',
        'procedure.troubleshoot') AND tool_step BETWEEN 1 AND 4)
    OR (event_type = 'tool_result' AND text_delta IS NULL
      AND tool_name IN ('synthetic.lookup', 'business.summary', 'records.search',
        'procedure.troubleshoot') AND tool_step BETWEEN 1 AND 4
      AND tool_outcome IN ('succeeded', 'failed', 'timed_out', 'cancelled'))
    OR (event_type = 'done' AND text_delta IS NULL AND finish_reason IN ('stop', 'limit')
      AND input_tokens >= 0 AND output_tokens >= 0 AND error_code IS NULL)
    OR (event_type = 'error' AND text_delta IS NULL AND error_code IN (
      'AI_UNAVAILABLE', 'AI_ABORTED', 'AI_DEADLINE_EXCEEDED', 'AI_OUTPUT_LIMIT',
      'AI_TOOL_LIMIT', 'AI_TOOL_TIMEOUT', 'AI_PROVIDER_FAILED'
    ))
  );

ALTER TABLE public.ai_tool_attempts DROP CONSTRAINT IF EXISTS ai_tool_attempts_allowlist_chk;
ALTER TABLE public.ai_tool_attempts
  ADD CONSTRAINT ai_tool_attempts_allowlist_chk CHECK (tool_name IN (
    'synthetic.lookup', 'business.summary', 'records.search', 'procedure.troubleshoot'
  ));
ALTER TABLE public.ai_tool_attempts
  ADD COLUMN result_count integer NOT NULL DEFAULT 0
    CHECK (result_count BETWEEN 0 AND 10),
  ADD COLUMN source_count integer NOT NULL DEFAULT 0
    CHECK (source_count BETWEEN 0 AND 3),
  ADD COLUMN filter_count integer NOT NULL DEFAULT 0
    CHECK (filter_count BETWEEN 0 AND 6);

CREATE FUNCTION public.ai_readonly_tool_attempt_append(
  requested_id uuid, requested_turn_id uuid, requested_auth_session_id uuid,
  requested_step integer, requested_tool_name text, requested_request_sha256 char(64),
  requested_result_sha256 char(64), requested_outcome text, requested_duration_ms integer,
  requested_result_count integer, requested_source_count integer,
  requested_filter_count integer, requested_audit_id uuid
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE authority record; target record; db_now timestamptz := statement_timestamp();
BEGIN
  SELECT * INTO authority FROM public.assert_ai_stream_authority(requested_auth_session_id);
  IF requested_tool_name NOT IN (
    'business.summary', 'records.search', 'procedure.troubleshoot'
  ) THEN
    RAISE invalid_parameter_value USING MESSAGE = 'AI read-only tool unavailable';
  END IF;
  SELECT * INTO target FROM public.ai_turns turn_value
   WHERE turn_value.id = requested_turn_id AND turn_value.org_id = authority.org_id
     AND turn_value.store_id = authority.store_id AND turn_value.staff_id = authority.staff_id
     AND turn_value.auth_session_id = requested_auth_session_id FOR SHARE;
  IF NOT FOUND OR target.status <> 'running' THEN
    RAISE insufficient_privilege USING MESSAGE = 'AI turn unavailable';
  END IF;
  INSERT INTO public.ai_tool_attempts (
    id, org_id, store_id, staff_id, auth_session_id, ai_session_id, turn_id,
    step, tool_name, request_sha256, result_sha256, outcome, duration_ms,
    result_count, source_count, filter_count, created_at
  ) VALUES (
    requested_id, authority.org_id, authority.store_id, authority.staff_id,
    requested_auth_session_id, target.ai_session_id, requested_turn_id,
    requested_step, requested_tool_name, requested_request_sha256,
    requested_result_sha256, requested_outcome, requested_duration_ms,
    requested_result_count, requested_source_count, requested_filter_count, db_now
  );
  INSERT INTO public.audit_log (
    id, org_id, store_id, staff_id, via, command, idempotency_key, dry_run,
    entity, entity_id, before_json, after_json, ip, device_id, at
  ) VALUES (
    requested_audit_id, authority.org_id, authority.store_id, authority.staff_id,
    'ai', 'ai.readonly_tool.execute', target.idempotency_key::text, false,
    'ai_tool_attempt', requested_id::text, NULL,
    jsonb_build_object('tool_name', requested_tool_name, 'step', requested_step,
      'outcome', requested_outcome, 'duration_ms', requested_duration_ms,
      'result_count', requested_result_count, 'source_count', requested_source_count,
      'filter_count', requested_filter_count)::text,
    NULL, authority.device_id, db_now
  );
  RETURN requested_id;
END
$$;

REVOKE ALL ON FUNCTION public.ai_readonly_tool_attempt_append(
  uuid, uuid, uuid, integer, text, char, char, text, integer,
  integer, integer, integer, uuid
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ai_readonly_tool_attempt_append(
  uuid, uuid, uuid, integer, text, char, char, text, integer,
  integer, integer, integer, uuid
) TO laundry_app;
