-- ADR-82 r1 (ADR-91 P0-3): usage a provider never reported is still debited in full,
-- but one lost stream no longer disables the organisation's AI runtime. Only a usage
-- report outside the storage contract, or the third unknown usage for the store within
-- a rolling 24 hours, disables it. Counting restarts after an administrator re-enables
-- the runtime or otherwise saves the policy, because that save is the review.
CREATE OR REPLACE FUNCTION public.ai_usage_quarantine(requested_turn uuid, requested_session uuid, requested_audit uuid, requested_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE authority record; target record; db_now timestamptz := statement_timestamp();
  policy_saved timestamptz; prior_unknown integer := 0; disable boolean;
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
      AND command IN ('ai.usage.quarantine','ai.usage.unknown') AND entity='ai_turn'
      AND entity_id=target.id::text) THEN RETURN; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(authority.org_id::text || ':ai-budget',0));
  SELECT updated_at INTO policy_saved FROM public.ai_safety_policies
    WHERE org_id=authority.org_id FOR UPDATE;
  IF NOT FOUND THEN RAISE check_violation USING MESSAGE='AI usage policy unavailable'; END IF;
  IF requested_reason='usage_unknown' THEN
    SELECT count(*) INTO prior_unknown FROM public.audit_log
      WHERE org_id=authority.org_id AND store_id=authority.store_id
        AND at > greatest(db_now - interval '24 hours', policy_saved)
        AND command IN ('ai.usage.unknown','ai.usage.quarantine') AND entity='ai_turn';
  END IF;
  disable := requested_reason='outside_contract' OR prior_unknown >= 2;
  IF disable THEN
    UPDATE public.ai_safety_policies SET enabled=false,config_version=config_version+1,
      updated_at=db_now,updated_by=authority.staff_id WHERE org_id=authority.org_id;
  END IF;
  INSERT INTO public.audit_log(id,org_id,store_id,staff_id,via,command,idempotency_key,dry_run,
    entity,entity_id,before_json,after_json,ip,device_id,at)
  VALUES(requested_audit,authority.org_id,authority.store_id,authority.staff_id,'ai',
    CASE WHEN disable THEN 'ai.usage.quarantine' ELSE 'ai.usage.unknown' END,
    target.idempotency_key::text,false,'ai_turn',target.id::text,NULL,
    jsonb_build_object('reason',requested_reason,'debit','full_reservation',
      'runtime_enabled',NOT disable,'unknown_in_window',prior_unknown+1)::text,
    NULL,authority.device_id,db_now);
END $$;
ALTER FUNCTION public.ai_usage_quarantine(uuid,uuid,uuid,text) OWNER TO laundry_owner;
REVOKE ALL ON FUNCTION public.ai_usage_quarantine(uuid,uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ai_usage_quarantine(uuid,uuid,uuid,text) TO laundry_app;
