-- ADR-57 / Stage 4.5 Item 12: local BYOK custody and an initially empty,
-- officially-verified model registry. This migration intentionally seeds no model.

CREATE TABLE public.ai_model_registry (
  provider_code text NOT NULL,
  model_id text NOT NULL,
  display_name text NOT NULL,
  adapter_family text NOT NULL,
  supports_streaming boolean NOT NULL,
  supports_tools boolean NOT NULL,
  supports_vision boolean NOT NULL,
  max_input_tokens integer NOT NULL,
  max_output_tokens integer NOT NULL,
  status text NOT NULL,
  registry_version integer NOT NULL,
  source_url text NOT NULL,
  verified_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT ai_model_registry_pkey PRIMARY KEY (provider_code, model_id),
  CONSTRAINT ai_model_registry_provider_chk
    CHECK (provider_code ~ '^[a-z][a-z0-9._-]{0,63}$'),
  CONSTRAINT ai_model_registry_model_id_chk
    CHECK (length(model_id) BETWEEN 1 AND 128 AND model_id !~ '[[:cntrl:]]'),
  CONSTRAINT ai_model_registry_display_name_chk
    CHECK (length(display_name) BETWEEN 1 AND 128 AND display_name !~ '[[:cntrl:]]'),
  CONSTRAINT ai_model_registry_adapter_chk
    CHECK (adapter_family IN ('anthropic', 'openai_compatible', 'gemini')),
  CONSTRAINT ai_model_registry_status_chk
    CHECK (status IN ('disabled', 'available', 'deprecated')),
  CONSTRAINT ai_model_registry_token_limits_chk CHECK (
    max_input_tokens BETWEEN 1 AND 10000000
    AND max_output_tokens BETWEEN 1 AND 10000000
  ),
  CONSTRAINT ai_model_registry_version_chk CHECK (registry_version > 0),
  CONSTRAINT ai_model_registry_source_chk CHECK (
    length(source_url) BETWEEN 9 AND 2048
    AND source_url ~ '^https://'
    AND verified_at <= updated_at
  ),
  CONSTRAINT ai_model_registry_time_chk CHECK (updated_at >= created_at)
);

COMMENT ON TABLE public.ai_model_registry IS
  'Owner-maintained registry; every row requires official source verification; migration 0064 seeds none.';

CREATE TABLE public.ai_provider_keys (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  provider_code text NOT NULL,
  credential_version integer NOT NULL,
  row_version integer NOT NULL,
  status text NOT NULL,
  ciphertext bytea NOT NULL,
  nonce bytea NOT NULL,
  auth_tag bytea NOT NULL,
  wrapped_dek bytea NOT NULL,
  kms_key_id text NOT NULL,
  kms_key_version text NOT NULL,
  envelope_schema_version integer NOT NULL,
  last4 text NOT NULL,
  created_by_staff_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  updated_by_staff_id uuid NOT NULL,
  updated_at timestamptz NOT NULL,
  activated_at timestamptz,
  revoked_at timestamptz,
  superseded_at timestamptz,
  CONSTRAINT ai_provider_keys_org_id_uidx UNIQUE (org_id, id),
  CONSTRAINT ai_provider_keys_version_uidx
    UNIQUE (org_id, provider_code, credential_version),
  CONSTRAINT ai_provider_keys_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs (id),
  CONSTRAINT ai_provider_keys_created_staff_fk
    FOREIGN KEY (org_id, created_by_staff_id) REFERENCES public.staffs (org_id, id),
  CONSTRAINT ai_provider_keys_updated_staff_fk
    FOREIGN KEY (org_id, updated_by_staff_id) REFERENCES public.staffs (org_id, id),
  CONSTRAINT ai_provider_keys_provider_chk
    CHECK (provider_code ~ '^[a-z][a-z0-9._-]{0,63}$'),
  CONSTRAINT ai_provider_keys_version_chk CHECK (credential_version > 0),
  CONSTRAINT ai_provider_keys_row_version_chk CHECK (row_version > 0),
  CONSTRAINT ai_provider_keys_status_chk CHECK (
    status IN ('pending_verification', 'active', 'invalid', 'superseded', 'revoked')
  ),
  CONSTRAINT ai_provider_keys_ciphertext_chk
    CHECK (octet_length(ciphertext) BETWEEN 1 AND 8192),
  CONSTRAINT ai_provider_keys_nonce_chk CHECK (octet_length(nonce) = 12),
  CONSTRAINT ai_provider_keys_auth_tag_chk CHECK (octet_length(auth_tag) = 16),
  CONSTRAINT ai_provider_keys_wrapped_dek_chk
    CHECK (octet_length(wrapped_dek) BETWEEN 16 AND 16384),
  CONSTRAINT ai_provider_keys_kms_metadata_chk CHECK (
    length(kms_key_id) BETWEEN 1 AND 512
    AND length(kms_key_version) BETWEEN 1 AND 128
    AND kms_key_id !~ '[[:cntrl:]]'
    AND kms_key_version !~ '[[:cntrl:]]'
  ),
  CONSTRAINT ai_provider_keys_schema_chk CHECK (envelope_schema_version = 1),
  CONSTRAINT ai_provider_keys_last4_chk
    CHECK (octet_length(last4) = 4 AND last4 ~ '^[!-~]{4}$'),
  CONSTRAINT ai_provider_keys_time_chk CHECK (
    updated_at >= created_at
    AND (activated_at IS NULL OR activated_at >= created_at)
    AND (revoked_at IS NULL OR revoked_at >= created_at)
    AND (superseded_at IS NULL OR superseded_at >= created_at)
  ),
  CONSTRAINT ai_provider_keys_terminal_time_chk CHECK (
    (status = 'pending_verification'
      AND activated_at IS NULL AND revoked_at IS NULL AND superseded_at IS NULL)
    OR (status = 'active'
      AND activated_at IS NOT NULL AND revoked_at IS NULL AND superseded_at IS NULL)
    OR (status = 'invalid'
      AND revoked_at IS NULL AND superseded_at IS NULL)
    OR (status = 'superseded'
      AND superseded_at IS NOT NULL AND revoked_at IS NULL)
    OR (status = 'revoked'
      AND revoked_at IS NOT NULL AND superseded_at IS NULL)
  )
);

CREATE UNIQUE INDEX ai_provider_keys_one_active_uidx
  ON public.ai_provider_keys (org_id, provider_code)
  WHERE status = 'active';
CREATE UNIQUE INDEX ai_provider_keys_one_pending_uidx
  ON public.ai_provider_keys (org_id, provider_code)
  WHERE status = 'pending_verification';
CREATE UNIQUE INDEX ai_pending_byok_idempotency_uidx
  ON public.ai_pending_actions (org_id, store_id, command, idempotency_key)
  WHERE command IN (
    'ai.provider_credential.replace',
    'ai.provider_credential.revoke'
  );
CREATE INDEX ai_provider_keys_org_provider_history_idx
  ON public.ai_provider_keys (org_id, provider_code, credential_version DESC, id);

CREATE FUNCTION public.enforce_ai_provider_key_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF session_user = 'laundry_app' AND NEW.status <> 'pending_verification' THEN
      RAISE EXCEPTION 'application credentials must begin pending verification';
    END IF;
    IF session_user = 'laundry_app' AND (
      NEW.created_by_staff_id IS DISTINCT FROM NULLIF(current_setting('app.staff_id', true), '')::uuid
      OR NEW.updated_by_staff_id IS DISTINCT FROM NULLIF(current_setting('app.staff_id', true), '')::uuid
    ) THEN
      RAISE EXCEPTION 'credential actor must match authenticated staff';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id <> OLD.id
     OR NEW.org_id <> OLD.org_id
     OR NEW.provider_code <> OLD.provider_code
     OR NEW.credential_version <> OLD.credential_version
     OR NEW.ciphertext <> OLD.ciphertext
     OR NEW.nonce <> OLD.nonce
     OR NEW.auth_tag <> OLD.auth_tag
     OR NEW.envelope_schema_version <> OLD.envelope_schema_version
     OR NEW.last4 <> OLD.last4
     OR NEW.created_by_staff_id <> OLD.created_by_staff_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'credential identity and encrypted payload are immutable';
  END IF;

  IF NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION 'credential row version must advance exactly once';
  END IF;
  IF session_user = 'laundry_app'
     AND NEW.updated_by_staff_id IS DISTINCT FROM NULLIF(current_setting('app.staff_id', true), '')::uuid THEN
    RAISE EXCEPTION 'credential actor must match authenticated staff';
  END IF;

  IF NEW.status <> OLD.status AND NOT (
    (OLD.status = 'pending_verification'
      AND NEW.status IN ('active', 'invalid', 'superseded', 'revoked'))
    OR (OLD.status = 'active'
      AND NEW.status IN ('invalid', 'superseded', 'revoked'))
    OR (OLD.status = 'invalid' AND NEW.status = 'revoked')
  ) THEN
    RAISE EXCEPTION 'invalid credential lifecycle transition';
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION public.assert_ai_provider_key_admin()
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
    RAISE insufficient_privilege USING MESSAGE = 'BYOK administrator authority unavailable';
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
    RAISE insufficient_privilege USING MESSAGE = 'BYOK administrator authority unavailable';
  END IF;
  RETURN QUERY SELECT requested_org, requested_store, requested_staff;
END
$$;

CREATE FUNCTION public.assert_ai_provider_key_operation(
  requested_command text,
  requested_provider_code text,
  requested_credential_id uuid
)
RETURNS TABLE (org_id uuid, store_id uuid, staff_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  authority record;
  operation_ref uuid := NULLIF(current_setting('app.byok_operation_ref', true), '')::uuid;
  proof_ref uuid := NULLIF(current_setting('app.byok_proof_ref', true), '')::uuid;
  expected_operation text := CASE requested_command
    WHEN 'ai.provider_credential.replace' THEN 'replace'
    WHEN 'ai.provider_credential.revoke' THEN 'revoke'
    ELSE NULL
  END;
  authorized boolean := false;
BEGIN
  SELECT * INTO authority FROM public.assert_ai_provider_key_admin();
  IF operation_ref IS NULL OR proof_ref IS NULL OR expected_operation IS NULL THEN
    RAISE insufficient_privilege USING MESSAGE = 'BYOK R5 operation authority unavailable';
  END IF;
  SELECT true INTO authorized
    FROM public.ai_pending_actions pending
    JOIN public.step_up_proofs proof
      ON proof.org_id = pending.org_id
     AND proof.store_id = pending.store_id
     AND proof.pending_action_ref = pending.nonce
    JOIN public.staffs approver
      ON approver.org_id = pending.org_id AND approver.id = pending.consumed_by_staff_id
    JOIN public.staff_store_roles approver_role
      ON approver_role.org_id = pending.org_id
     AND approver_role.store_id = pending.store_id
     AND approver_role.staff_id = pending.consumed_by_staff_id
   WHERE pending.nonce = operation_ref
     AND pending.org_id = authority.org_id
     AND pending.store_id = authority.store_id
     AND pending.creator_staff_id = authority.staff_id
     AND pending.command = requested_command
     AND pending.command_version = '1.0.0'
     AND pending.status = 'consumed'
     AND pending.effective_risk = 'R5'
     AND pending.policy_outcome = 'step_up'
     AND pending.requires_other_approver
     AND pending.consumed_by_staff_id IS DISTINCT FROM authority.staff_id
     AND pending.args_json ->> 'operation' = expected_operation
     AND pending.args_json ->> 'provider_code' = requested_provider_code
     AND pending.args_json ->> 'idempotency_key' = pending.idempotency_key::text
     AND (
       requested_credential_id IS NULL
       OR pending.args_json ->> 'credential_ref' = requested_credential_id::text
     )
     AND proof.proof_id = proof_ref
     AND proof.status = 'consumed'
     AND proof.requester_staff_id = authority.staff_id
     AND proof.approver_staff_id = pending.consumed_by_staff_id
     AND proof.args_hash = pending.args_hash
     AND proof.entity_versions_json = pending.entity_versions_json
     AND proof.idempotency_key = pending.idempotency_key
     AND approver.is_active
     AND approver_role.is_active
     AND approver_role.role = 'admin'
   LIMIT 1
   FOR SHARE OF pending, proof, approver, approver_role;
  IF NOT COALESCE(authorized, false) THEN
    RAISE insufficient_privilege USING MESSAGE = 'BYOK R5 operation authority unavailable';
  END IF;
  RETURN QUERY SELECT authority.org_id, authority.store_id, authority.staff_id;
END
$$;

CREATE FUNCTION public.ai_provider_key_stage(
  requested_id uuid,
  requested_provider_code text,
  expected_credential_version integer,
  requested_ciphertext bytea,
  requested_nonce bytea,
  requested_auth_tag bytea,
  requested_wrapped_dek bytea,
  requested_kms_key_id text,
  requested_kms_key_version text,
  requested_schema_version integer,
  requested_last4 text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  authority record;
  db_now timestamptz := statement_timestamp();
  next_version integer;
BEGIN
  SELECT * INTO authority FROM public.assert_ai_provider_key_operation(
    'ai.provider_credential.replace', requested_provider_code, NULL
  );
  PERFORM pg_advisory_xact_lock(
    hashtextextended(authority.org_id::text || '|' || requested_provider_code, 0)
  );
  SELECT COALESCE(MAX(key_row.credential_version), 0)::integer + 1
    INTO next_version
    FROM public.ai_provider_keys key_row
   WHERE key_row.org_id = authority.org_id
     AND key_row.provider_code = requested_provider_code;
  IF next_version <> expected_credential_version THEN
    RAISE serialization_failure USING MESSAGE = 'BYOK credential version authority changed';
  END IF;
  UPDATE public.ai_provider_keys key_row
     SET status = 'superseded', row_version = key_row.row_version + 1,
         updated_by_staff_id = authority.staff_id, updated_at = db_now,
         superseded_at = db_now
   WHERE key_row.org_id = authority.org_id
     AND key_row.provider_code = requested_provider_code
     AND key_row.status = 'pending_verification';
  INSERT INTO public.ai_provider_keys (
    id, org_id, provider_code, credential_version, row_version, status,
    ciphertext, nonce, auth_tag, wrapped_dek, kms_key_id, kms_key_version,
    envelope_schema_version, last4, created_by_staff_id, created_at,
    updated_by_staff_id, updated_at, activated_at, revoked_at, superseded_at
  ) VALUES (
    requested_id, authority.org_id, requested_provider_code,
    expected_credential_version, 1, 'pending_verification',
    requested_ciphertext, requested_nonce, requested_auth_tag, requested_wrapped_dek,
    requested_kms_key_id, requested_kms_key_version, requested_schema_version,
    requested_last4, authority.staff_id, db_now, authority.staff_id, db_now,
    NULL, NULL, NULL
  );
  RETURN requested_id;
END
$$;

CREATE FUNCTION public.ai_provider_key_revoke(
  requested_id uuid,
  requested_provider_code text,
  expected_row_version integer
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
  changed_count integer;
BEGIN
  SELECT * INTO authority FROM public.assert_ai_provider_key_operation(
    'ai.provider_credential.revoke', requested_provider_code, requested_id
  );
  PERFORM pg_advisory_xact_lock(
    hashtextextended(authority.org_id::text || '|' || requested_provider_code, 0)
  );
  SELECT key_row.status, key_row.row_version
    INTO target
    FROM public.ai_provider_keys key_row
   WHERE key_row.org_id = authority.org_id
     AND key_row.id = requested_id
     AND key_row.provider_code = requested_provider_code
   FOR UPDATE;
  IF NOT FOUND OR target.row_version <> expected_row_version
     OR target.status NOT IN ('pending_verification', 'active', 'invalid') THEN
    RETURN false;
  END IF;
  UPDATE public.ai_provider_keys key_row
     SET status = 'revoked', row_version = key_row.row_version + 1,
         updated_by_staff_id = authority.staff_id, updated_at = db_now,
         revoked_at = db_now
   WHERE key_row.org_id = authority.org_id
     AND key_row.id = requested_id
     AND key_row.provider_code = requested_provider_code
     AND key_row.row_version = expected_row_version
     AND key_row.status IN ('pending_verification', 'active', 'invalid');
  GET DIAGNOSTICS changed_count = ROW_COUNT;
  RETURN changed_count = 1;
END
$$;

CREATE FUNCTION public.ai_provider_key_verify_transition(
  requested_id uuid,
  expected_row_version integer,
  verification_status text
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
BEGIN
  SELECT * INTO authority FROM public.assert_ai_provider_key_admin();
  IF verification_status NOT IN ('active', 'invalid') THEN
    RAISE invalid_parameter_value USING MESSAGE = 'invalid BYOK verification result';
  END IF;
  SELECT key_row.provider_code, key_row.status, key_row.row_version
    INTO target
    FROM public.ai_provider_keys key_row
   WHERE key_row.org_id = authority.org_id AND key_row.id = requested_id
   FOR UPDATE;
  IF NOT FOUND OR target.status <> 'pending_verification'
     OR target.row_version <> expected_row_version THEN
    RETURN false;
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended(authority.org_id::text || '|' || target.provider_code, 0)
  );
  IF verification_status = 'active' THEN
    UPDATE public.ai_provider_keys key_row
       SET status = 'superseded', row_version = key_row.row_version + 1,
           updated_by_staff_id = authority.staff_id, updated_at = db_now,
           superseded_at = db_now
     WHERE key_row.org_id = authority.org_id
       AND key_row.provider_code = target.provider_code
       AND key_row.status = 'active';
  END IF;
  UPDATE public.ai_provider_keys key_row
     SET status = verification_status, row_version = key_row.row_version + 1,
         updated_by_staff_id = authority.staff_id, updated_at = db_now,
         activated_at = CASE WHEN verification_status = 'active' THEN db_now ELSE NULL END
   WHERE key_row.org_id = authority.org_id
     AND key_row.id = requested_id
     AND key_row.row_version = expected_row_version
     AND key_row.status = 'pending_verification';
  RETURN FOUND;
END
$$;

CREATE FUNCTION public.ai_provider_key_rewrap(
  requested_id uuid,
  expected_row_version integer,
  replacement_wrapped_dek bytea,
  replacement_kms_key_id text,
  replacement_kms_key_version text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  authority record;
  changed_count integer;
BEGIN
  SELECT * INTO authority FROM public.assert_ai_provider_key_admin();
  UPDATE public.ai_provider_keys key_row
     SET wrapped_dek = replacement_wrapped_dek,
         kms_key_id = replacement_kms_key_id,
         kms_key_version = replacement_kms_key_version,
         row_version = key_row.row_version + 1,
         updated_by_staff_id = authority.staff_id,
         updated_at = statement_timestamp()
   WHERE key_row.org_id = authority.org_id
     AND key_row.id = requested_id
     AND key_row.row_version = expected_row_version
     AND key_row.status <> 'revoked';
  GET DIAGNOSTICS changed_count = ROW_COUNT;
  RETURN changed_count = 1;
END
$$;

CREATE TRIGGER ai_provider_keys_lifecycle_guard
BEFORE INSERT OR UPDATE ON public.ai_provider_keys
FOR EACH ROW EXECUTE FUNCTION public.enforce_ai_provider_key_lifecycle();

ALTER TABLE public.ai_provider_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_provider_keys FORCE ROW LEVEL SECURITY;

CREATE POLICY ai_provider_keys_org_scope ON public.ai_provider_keys
  AS PERMISSIVE FOR ALL TO laundry_app
  USING (
    org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
  );

CREATE POLICY ai_provider_keys_maintenance ON public.ai_provider_keys
  AS PERMISSIVE FOR ALL TO laundry_owner USING (true) WITH CHECK (true);

REVOKE ALL ON TABLE public.ai_model_registry FROM PUBLIC, laundry_app;
GRANT SELECT ON TABLE public.ai_model_registry TO laundry_app;

REVOKE ALL ON TABLE public.ai_provider_keys FROM PUBLIC, laundry_app;
GRANT SELECT ON TABLE public.ai_provider_keys TO laundry_app;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.ai_provider_keys FROM laundry_app;

REVOKE ALL ON FUNCTION public.enforce_ai_provider_key_lifecycle() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_ai_provider_key_admin() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_ai_provider_key_operation(text, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ai_provider_key_stage(
  uuid, text, integer, bytea, bytea, bytea, bytea, text, text, integer, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ai_provider_key_revoke(uuid, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ai_provider_key_verify_transition(uuid, integer, text)
  FROM PUBLIC, laundry_app;
REVOKE ALL ON FUNCTION public.ai_provider_key_rewrap(uuid, integer, bytea, text, text)
  FROM PUBLIC, laundry_app;
GRANT EXECUTE ON FUNCTION public.ai_provider_key_stage(
  uuid, text, integer, bytea, bytea, bytea, bytea, text, text, integer, text
) TO laundry_app;
GRANT EXECUTE ON FUNCTION public.ai_provider_key_revoke(uuid, text, integer) TO laundry_app;
GRANT EXECUTE ON FUNCTION public.ai_provider_key_verify_transition(uuid, integer, text)
  TO laundry_owner;
GRANT EXECUTE ON FUNCTION public.ai_provider_key_rewrap(uuid, integer, bytea, text, text)
  TO laundry_owner;
