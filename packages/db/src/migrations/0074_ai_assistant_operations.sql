-- ADR-82: bounded analysis and human-confirmed AI operation previews.
-- Existing tenant/session definer authority and grants are preserved. No business writes are added.

ALTER TABLE public.ai_stream_events DROP CONSTRAINT IF EXISTS ai_stream_events_shape_chk;
ALTER TABLE public.ai_stream_events
  ADD CONSTRAINT ai_stream_events_shape_chk CHECK (
    (event_type = 'content_delta' AND char_length(text_delta) BETWEEN 1 AND 4096
      AND tool_name IS NULL AND error_code IS NULL AND finish_reason IS NULL)
    OR (event_type = 'tool_call' AND text_delta IS NULL
      AND tool_name IN ('synthetic.lookup', 'business.summary', 'records.search',
        'procedure.troubleshoot', 'business.trend', 'pickup.candidates', 'operations.preview') AND tool_step BETWEEN 1 AND 4)
    OR (event_type = 'tool_result' AND (text_delta IS NULL OR (tool_name = 'operations.preview' AND tool_outcome = 'succeeded' AND char_length(text_delta) BETWEEN 1 AND 2048 AND jsonb_typeof(text_delta::jsonb) = 'object'))
      AND tool_name IN ('synthetic.lookup', 'business.summary', 'records.search',
        'procedure.troubleshoot', 'business.trend', 'pickup.candidates', 'operations.preview') AND tool_step BETWEEN 1 AND 4
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
    'synthetic.lookup', 'business.summary', 'records.search', 'procedure.troubleshoot', 'business.trend', 'pickup.candidates', 'operations.preview'
  ));
CREATE OR REPLACE FUNCTION public.ai_readonly_tool_attempt_append(
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
    'business.summary', 'records.search', 'procedure.troubleshoot', 'business.trend', 'pickup.candidates', 'operations.preview'
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
    'ai', CASE WHEN requested_tool_name IN ('business.trend', 'pickup.candidates', 'operations.preview') THEN 'ai.assistant_tool.execute' ELSE 'ai.readonly_tool.execute' END, target.idempotency_key::text, false,
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

-- An impossible provider usage report must not refund the reservation and permit
-- repeated paid calls. Called in the same transaction as metered failed finish.
CREATE FUNCTION public.ai_usage_quarantine(requested_turn uuid, requested_session uuid, requested_audit uuid, requested_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE authority record; target record; db_now timestamptz := statement_timestamp();
BEGIN
  IF requested_reason NOT IN ('usage_unknown','outside_contract') OR requested_reason IS NULL THEN
    RAISE invalid_parameter_value USING MESSAGE='AI usage quarantine reason unavailable';
  END IF;
  SELECT * INTO authority FROM public.assert_ai_stream_authority(requested_session);
  SELECT t.* INTO target FROM public.ai_turns t
    JOIN public.ai_usage u ON u.turn_id=t.id
    JOIN public.ai_cost_reservations r ON r.turn_id=t.id
    WHERE t.id=requested_turn AND t.org_id=authority.org_id AND t.store_id=authority.store_id
      AND t.staff_id=authority.staff_id AND t.auth_session_id=requested_session
      AND t.status IN ('failed','cancelled')
      AND (requested_reason='usage_unknown' OR (t.status='failed' AND t.error_code='AI_OUTPUT_LIMIT'))
      AND u.input_tokens=20000 AND u.output_tokens=t.max_output_tokens
      AND u.estimated_cost_micros=r.reserved_cost_micros AND r.released_at IS NOT NULL FOR UPDATE OF t;
  IF NOT FOUND THEN RAISE insufficient_privilege USING MESSAGE='AI usage quarantine unavailable'; END IF;
  IF EXISTS (SELECT 1 FROM public.audit_log WHERE org_id=authority.org_id
      AND command='ai.usage.quarantine' AND entity='ai_turn' AND entity_id=target.id::text) THEN RETURN; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(authority.org_id::text || ':ai-budget',0));
  UPDATE public.ai_safety_policies SET enabled=false,config_version=config_version+1,
    updated_at=db_now,updated_by=authority.staff_id WHERE org_id=authority.org_id;
  IF NOT FOUND THEN RAISE check_violation USING MESSAGE='AI usage policy unavailable'; END IF;
  INSERT INTO public.audit_log(id,org_id,store_id,staff_id,via,command,idempotency_key,dry_run,
    entity,entity_id,before_json,after_json,ip,device_id,at)
  VALUES(requested_audit,authority.org_id,authority.store_id,authority.staff_id,'ai','ai.usage.quarantine',
    target.idempotency_key::text,false,'ai_turn',target.id::text,NULL,
    jsonb_build_object('reason',requested_reason,'debit','full_reservation','runtime_enabled',false)::text,
    NULL,authority.device_id,db_now);
END $$;
ALTER FUNCTION public.ai_usage_quarantine(uuid,uuid,uuid,text) OWNER TO laundry_owner;
REVOKE ALL ON FUNCTION public.ai_usage_quarantine(uuid,uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ai_usage_quarantine(uuid,uuid,uuid,text) TO laundry_app;
