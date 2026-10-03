-- ADR-75: actual local provider selection shares the existing organization budget authority.
ALTER TABLE public.ai_safety_policies
  ADD COLUMN provider_code text,
  ADD COLUMN model_id text,
  ADD COLUMN config_version integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT ai_runtime_selection_chk CHECK (
    (config_version = 0 AND provider_code IS NULL AND model_id IS NULL) OR
    (config_version > 0 AND provider_code IS NOT NULL AND model_id IS NOT NULL
     AND provider_code IN ('deepseek', 'anthropic', 'gemini')
     AND length(model_id) BETWEEN 1 AND 128 AND model_id !~ '[[:cntrl:]]')
  );

CREATE FUNCTION public.ai_runtime_config_get(requested_session uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE authority record; result jsonb;
BEGIN
  SELECT * INTO authority FROM public.assert_ai_stream_authority(requested_session);
  SELECT jsonb_build_object('enabled', p.enabled, 'provider_code', p.provider_code,
    'model_id', p.model_id, 'version', p.config_version,
    'monthly_limit_micros', p.monthly_limit_micros,
    'input_micros_per_million', p.input_micros_per_million,
    'output_micros_per_million', p.output_micros_per_million)
    INTO result FROM public.ai_safety_policies p
    WHERE p.org_id = authority.org_id AND p.config_version > 0;
  RETURN result;
END $$;

CREATE FUNCTION public.ai_runtime_config_set(requested_session uuid, expected_version integer,
  requested_provider text, requested_model text, requested_enabled boolean,
  requested_limit bigint, requested_input_price bigint, requested_output_price bigint,
  requested_audit_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE authority record; previous jsonb; result jsonb; current_version integer := 0;
BEGIN
  SELECT * INTO authority FROM public.assert_ai_stream_authority(requested_session);
  PERFORM public.assert_ai_provider_key_admin();
  IF requested_provider IS NULL OR requested_provider NOT IN ('deepseek', 'anthropic', 'gemini')
     OR requested_model IS NULL OR length(requested_model) NOT BETWEEN 1 AND 128
     OR requested_model ~ '[[:cntrl:]]' OR expected_version IS NULL OR expected_version < 0
     OR requested_enabled IS NULL
     OR requested_limit IS NULL OR requested_limit NOT BETWEEN 1 AND 9000000000000
     OR requested_input_price IS NULL OR requested_input_price NOT BETWEEN 1 AND 1000000000000
     OR requested_output_price IS NULL OR requested_output_price NOT BETWEEN 1 AND 1000000000000
  THEN RAISE check_violation USING MESSAGE = 'AI runtime settings invalid'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(authority.org_id::text || ':ai-budget', 0));
  SELECT config_version INTO current_version FROM public.ai_safety_policies
    WHERE org_id = authority.org_id FOR UPDATE;
  IF COALESCE(current_version, 0) <> expected_version THEN
    RAISE serialization_failure USING MESSAGE = 'AI runtime settings changed'; END IF;
  IF requested_enabled AND NOT EXISTS (SELECT 1 FROM public.ai_provider_keys k
    WHERE k.org_id = authority.org_id AND k.provider_code = requested_provider AND k.status = 'active')
  THEN RAISE check_violation USING MESSAGE = 'AI active credential unavailable'; END IF;
  previous := public.ai_runtime_config_get(requested_session);
  INSERT INTO public.ai_safety_policies (org_id, enabled, monthly_limit_micros,
    input_micros_per_million, output_micros_per_million, updated_at, updated_by,
    provider_code, model_id, config_version)
  VALUES (authority.org_id, requested_enabled, requested_limit, requested_input_price,
    requested_output_price, statement_timestamp(), authority.staff_id, requested_provider,
    requested_model, COALESCE(current_version, 0) + 1)
  ON CONFLICT (org_id) DO UPDATE SET enabled = EXCLUDED.enabled,
    monthly_limit_micros = EXCLUDED.monthly_limit_micros,
    input_micros_per_million = EXCLUDED.input_micros_per_million,
    output_micros_per_million = EXCLUDED.output_micros_per_million,
    updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by,
    provider_code = EXCLUDED.provider_code, model_id = EXCLUDED.model_id,
    config_version = EXCLUDED.config_version;
  result := public.ai_runtime_config_get(requested_session);
  INSERT INTO public.audit_log (id, org_id, store_id, staff_id, via, command,
    idempotency_key, dry_run, entity, entity_id, before_json, after_json, ip, device_id, at)
  VALUES (requested_audit_id, authority.org_id, authority.store_id, authority.staff_id, 'ui',
    'ai.runtime.configure', NULL, false, 'ai_runtime_config', authority.org_id::text,
    previous::text, result::text, NULL, authority.device_id, statement_timestamp());
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.ai_runtime_config_get(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ai_runtime_config_set(uuid, integer, text, text, boolean, bigint, bigint, bigint, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ai_runtime_config_get(uuid) TO laundry_app;
GRANT EXECUTE ON FUNCTION public.ai_runtime_config_set(uuid, integer, text, text, boolean, bigint, bigint, bigint, uuid) TO laundry_app;
