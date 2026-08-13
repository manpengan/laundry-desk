-- ADR-61 / Stage 4.5 Item 16. Migrations 0065-0067 are integrated before
-- this file on the shared delivery branch; this isolated item reserves 0068.
-- Async approval authorizes only an already-frozen R4 pending action. Business
-- execution continues through the existing command bus and consumes both rows.

CREATE UNIQUE INDEX IF NOT EXISTS ai_pending_actions_tenant_nonce_uidx
  ON public.ai_pending_actions (org_id, store_id, nonce);

CREATE TABLE public.ai_approval_requests (
  approval_ref uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  pending_action_ref uuid NOT NULL,
  command text NOT NULL,
  command_version text NOT NULL,
  args_json jsonb NOT NULL,
  args_hash char(64) NOT NULL,
  entity_versions_json jsonb NOT NULL,
  idempotency_key uuid NOT NULL,
  requester_staff_id uuid NOT NULL,
  requester_permission_version integer NOT NULL,
  status text NOT NULL,
  row_version integer NOT NULL,
  created_at_epoch bigint NOT NULL,
  expires_at_epoch bigint NOT NULL,
  decided_by_staff_id uuid,
  decided_by_permission_version integer,
  decided_at_epoch bigint,
  decision_reason text,
  consumed_at_epoch bigint,
  CONSTRAINT ai_approval_requests_store_fk
    FOREIGN KEY (org_id, store_id) REFERENCES public.stores (org_id, id),
  CONSTRAINT ai_approval_requests_pending_fk
    FOREIGN KEY (org_id, store_id, pending_action_ref)
      REFERENCES public.ai_pending_actions (org_id, store_id, nonce),
  CONSTRAINT ai_approval_requests_requester_fk
    FOREIGN KEY (org_id, requester_staff_id) REFERENCES public.staffs (org_id, id),
  CONSTRAINT ai_approval_requests_decider_fk
    FOREIGN KEY (org_id, decided_by_staff_id) REFERENCES public.staffs (org_id, id),
  CONSTRAINT ai_approval_requests_pending_uidx
    UNIQUE (org_id, store_id, pending_action_ref),
  CONSTRAINT ai_approval_requests_hash_chk CHECK (args_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ai_approval_requests_entities_chk
    CHECK (jsonb_typeof(entity_versions_json) = 'array'),
  CONSTRAINT ai_approval_requests_permission_versions_chk CHECK (
    requester_permission_version > 0
    AND (decided_by_permission_version IS NULL OR decided_by_permission_version > 0)
  ),
  CONSTRAINT ai_approval_requests_status_chk
    CHECK (status IN ('pending', 'approved', 'denied', 'expired', 'consumed')),
  CONSTRAINT ai_approval_requests_version_chk CHECK (row_version > 0),
  CONSTRAINT ai_approval_requests_expiry_chk CHECK (expires_at_epoch > created_at_epoch),
  CONSTRAINT ai_approval_requests_decision_chk CHECK (
    (status = 'pending'
      AND decided_by_staff_id IS NULL AND decided_by_permission_version IS NULL
      AND decided_at_epoch IS NULL AND decision_reason IS NULL AND consumed_at_epoch IS NULL)
    OR (status = 'expired'
      AND decided_by_staff_id IS NULL AND decided_by_permission_version IS NULL
      AND decided_at_epoch IS NULL AND decision_reason IS NULL AND consumed_at_epoch IS NULL)
    OR (status = 'approved'
      AND decided_by_staff_id IS NOT NULL AND decided_by_permission_version IS NOT NULL
      AND decided_at_epoch IS NOT NULL AND decision_reason IS NULL AND consumed_at_epoch IS NULL)
    OR (status = 'denied'
      AND decided_by_staff_id IS NOT NULL AND decided_by_permission_version IS NOT NULL
      AND decided_at_epoch IS NOT NULL AND length(btrim(decision_reason)) BETWEEN 1 AND 500
      AND consumed_at_epoch IS NULL)
    OR (status = 'consumed'
      AND decided_by_staff_id IS NOT NULL AND decided_by_permission_version IS NOT NULL
      AND decided_at_epoch IS NOT NULL AND decision_reason IS NULL
      AND consumed_at_epoch IS NOT NULL AND consumed_at_epoch >= decided_at_epoch)
  ),
  CONSTRAINT ai_approval_requests_other_admin_chk
    CHECK (decided_by_staff_id IS NULL OR decided_by_staff_id <> requester_staff_id)
);

CREATE INDEX ai_approval_requests_queue_idx
  ON public.ai_approval_requests (org_id, store_id, status, expires_at_epoch, created_at_epoch);
CREATE INDEX ai_approval_requests_requester_idx
  ON public.ai_approval_requests (org_id, requester_staff_id, created_at_epoch DESC);
CREATE INDEX ai_approval_requests_decider_idx
  ON public.ai_approval_requests (org_id, decided_by_staff_id, decided_at_epoch DESC)
  WHERE decided_by_staff_id IS NOT NULL;

ALTER TABLE public.ai_approval_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_approval_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY ai_approval_requests_store_scope ON public.ai_approval_requests
  FOR ALL TO laundry_app
  USING (
    org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid
  );
CREATE POLICY ai_approval_requests_maintenance ON public.ai_approval_requests
  FOR ALL TO laundry_owner USING (true) WITH CHECK (true);

CREATE FUNCTION public.ai_approval_request_create(
  requested_ref uuid,
  requested_pending_ref uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  tenant_org uuid := NULLIF(current_setting('app.org_id', true), '')::uuid;
  tenant_store uuid := NULLIF(current_setting('app.store_id', true), '')::uuid;
  actor_staff uuid := NULLIF(current_setting('app.staff_id', true), '')::uuid;
  db_now bigint := floor(extract(epoch FROM statement_timestamp()))::bigint;
  pending_row public.ai_pending_actions%ROWTYPE;
  permission_version integer;
BEGIN
  IF requested_ref IS NULL OR requested_pending_ref IS NULL THEN
    RAISE check_violation USING MESSAGE = 'approval request reference invalid';
  END IF;
  SELECT * INTO pending_row
    FROM public.ai_pending_actions
   WHERE org_id = tenant_org AND store_id = tenant_store AND nonce = requested_pending_ref
   FOR UPDATE;
  IF NOT FOUND
     OR pending_row.creator_staff_id <> actor_staff
     OR pending_row.status <> 'pending'
     OR pending_row.expires_at_epoch <= db_now
     OR pending_row.effective_risk <> 'R4'
     OR pending_row.policy_outcome <> 'step_up'
     OR NOT pending_row.requires_other_approver THEN
    RAISE insufficient_privilege USING MESSAGE = 'R4 pending action unavailable';
  END IF;
  SELECT staff_row.permission_version INTO permission_version
    FROM public.staffs staff_row
   WHERE staff_row.org_id = tenant_org AND staff_row.id = actor_staff AND staff_row.is_active
   FOR SHARE;
  IF permission_version IS NULL THEN
    RAISE insufficient_privilege USING MESSAGE = 'approval requester unavailable';
  END IF;
  INSERT INTO public.ai_approval_requests (
    approval_ref, org_id, store_id, pending_action_ref, command, command_version,
    args_json, args_hash, entity_versions_json, idempotency_key,
    requester_staff_id, requester_permission_version, status, row_version,
    created_at_epoch, expires_at_epoch
  ) VALUES (
    requested_ref, tenant_org, tenant_store, pending_row.nonce,
    pending_row.command, pending_row.command_version, pending_row.args_json,
    pending_row.args_hash, pending_row.entity_versions_json, pending_row.idempotency_key,
    actor_staff, permission_version, 'pending', 1, db_now, pending_row.expires_at_epoch
  )
  ON CONFLICT (org_id, store_id, pending_action_ref) DO NOTHING;
  RETURN COALESCE(
    (SELECT approval_ref FROM public.ai_approval_requests
      WHERE org_id = tenant_org AND store_id = tenant_store
        AND pending_action_ref = requested_pending_ref),
    requested_ref
  );
END
$$;

CREATE FUNCTION public.assert_ai_approval_admin()
RETURNS TABLE (org_id uuid, store_id uuid, staff_id uuid, permission_version integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN QUERY
  SELECT staff_row.org_id, role_row.store_id, staff_row.id, staff_row.permission_version
    FROM public.staffs staff_row
    JOIN public.staff_store_roles role_row
      ON role_row.org_id = staff_row.org_id AND role_row.staff_id = staff_row.id
   WHERE staff_row.org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
     AND role_row.store_id = NULLIF(current_setting('app.store_id', true), '')::uuid
     AND staff_row.id = NULLIF(current_setting('app.staff_id', true), '')::uuid
     AND staff_row.is_active AND role_row.is_active AND role_row.role = 'admin'
   LIMIT 1
   FOR SHARE OF staff_row, role_row;
  IF NOT FOUND THEN
    RAISE insufficient_privilege USING MESSAGE = 'approval administrator unavailable';
  END IF;
END
$$;

CREATE FUNCTION public.ai_approval_request_decide(
  requested_ref uuid,
  expected_version integer,
  requested_decision text,
  requested_reason text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  authority record;
  current_row public.ai_approval_requests%ROWTYPE;
  db_now bigint := floor(extract(epoch FROM statement_timestamp()))::bigint;
BEGIN
  SELECT * INTO authority FROM public.assert_ai_approval_admin();
  IF expected_version IS NULL OR expected_version < 1 THEN
    RAISE check_violation USING MESSAGE = 'approval request version invalid';
  END IF;
  SELECT * INTO current_row FROM public.ai_approval_requests
   WHERE org_id = authority.org_id AND store_id = authority.store_id
     AND approval_ref = requested_ref
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE no_data_found USING MESSAGE = 'approval request unavailable';
  END IF;
  IF current_row.requester_staff_id = authority.staff_id THEN
    RAISE insufficient_privilege USING MESSAGE = 'self approval forbidden';
  END IF;
  IF current_row.row_version <> expected_version THEN
    RAISE serialization_failure USING MESSAGE = 'approval request version conflict';
  END IF;
  IF current_row.status <> 'pending' THEN
    RAISE serialization_failure USING MESSAGE = 'approval request already decided';
  END IF;
  IF current_row.expires_at_epoch <= db_now THEN
    UPDATE public.ai_approval_requests
       SET status = 'expired', row_version = row_version + 1
     WHERE approval_ref = requested_ref AND status = 'pending';
    RAISE check_violation USING MESSAGE = 'approval request expired';
  END IF;
  IF requested_decision IS NULL OR requested_decision NOT IN ('approved', 'denied')
     OR (requested_decision = 'approved' AND requested_reason IS NOT NULL)
     OR (requested_decision = 'denied'
       AND length(btrim(COALESCE(requested_reason, ''))) NOT BETWEEN 1 AND 500) THEN
    RAISE check_violation USING MESSAGE = 'approval decision invalid';
  END IF;
  UPDATE public.ai_approval_requests
     SET status = requested_decision, row_version = row_version + 1,
         decided_by_staff_id = authority.staff_id,
         decided_by_permission_version = authority.permission_version,
         decided_at_epoch = db_now, decision_reason = requested_reason
   WHERE approval_ref = requested_ref AND status = 'pending';
  RETURN expected_version + 1;
END
$$;

CREATE FUNCTION public.ai_approval_request_consume(
  requested_ref uuid,
  requested_pending_ref uuid,
  expected_args_hash text,
  expected_entity_versions jsonb,
  expected_idempotency_key uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  tenant_org uuid := NULLIF(current_setting('app.org_id', true), '')::uuid;
  tenant_store uuid := NULLIF(current_setting('app.store_id', true), '')::uuid;
  actor_staff uuid := NULLIF(current_setting('app.staff_id', true), '')::uuid;
  db_now bigint := floor(extract(epoch FROM statement_timestamp()))::bigint;
  request_row public.ai_approval_requests%ROWTYPE;
  requester_version integer;
  approver_version integer;
BEGIN
  IF requested_ref IS NULL OR requested_pending_ref IS NULL
     OR expected_args_hash IS NULL OR expected_entity_versions IS NULL
     OR expected_idempotency_key IS NULL THEN
    RAISE insufficient_privilege USING MESSAGE = 'approved R4 authority unavailable';
  END IF;
  PERFORM 1 FROM public.ai_pending_actions
   WHERE org_id = tenant_org AND store_id = tenant_store AND nonce = requested_pending_ref
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE insufficient_privilege USING MESSAGE = 'approved R4 authority unavailable';
  END IF;
  SELECT * INTO request_row FROM public.ai_approval_requests
   WHERE org_id = tenant_org AND store_id = tenant_store AND approval_ref = requested_ref
   FOR UPDATE;
  IF NOT FOUND OR request_row.status <> 'approved'
     OR request_row.requester_staff_id <> actor_staff
     OR request_row.pending_action_ref <> requested_pending_ref
     OR request_row.args_hash <> expected_args_hash
     OR request_row.entity_versions_json <> expected_entity_versions
     OR request_row.idempotency_key <> expected_idempotency_key
     OR request_row.expires_at_epoch <= db_now
     OR NOT EXISTS (
       SELECT 1 FROM public.ai_pending_actions pending
        WHERE pending.org_id = tenant_org AND pending.store_id = tenant_store
          AND pending.nonce = request_row.pending_action_ref
          AND pending.creator_staff_id = request_row.requester_staff_id
          AND pending.command = request_row.command
          AND pending.command_version = request_row.command_version
          AND pending.args_json = request_row.args_json
          AND pending.args_hash = request_row.args_hash
          AND pending.entity_versions_json = request_row.entity_versions_json
          AND pending.idempotency_key = request_row.idempotency_key
          AND pending.status = 'pending' AND pending.effective_risk = 'R4'
          AND pending.policy_outcome = 'step_up' AND pending.requires_other_approver
          AND pending.expires_at_epoch > db_now
     ) THEN
    RAISE insufficient_privilege USING MESSAGE = 'approved R4 authority unavailable';
  END IF;
  SELECT permission_version INTO requester_version FROM public.staffs
   WHERE org_id = tenant_org AND id = request_row.requester_staff_id AND is_active FOR SHARE;
  SELECT staff_row.permission_version INTO approver_version
    FROM public.staffs staff_row
    JOIN public.staff_store_roles role_row
      ON role_row.org_id = staff_row.org_id AND role_row.staff_id = staff_row.id
   WHERE staff_row.org_id = tenant_org AND staff_row.id = request_row.decided_by_staff_id
     AND staff_row.is_active AND role_row.store_id = tenant_store
     AND role_row.is_active AND role_row.role = 'admin'
   FOR SHARE OF staff_row, role_row;
  IF requester_version IS DISTINCT FROM request_row.requester_permission_version
     OR approver_version IS DISTINCT FROM request_row.decided_by_permission_version THEN
    RAISE insufficient_privilege USING MESSAGE = 'approval permission authority changed';
  END IF;
  UPDATE public.ai_approval_requests
     SET status = 'consumed', row_version = row_version + 1, consumed_at_epoch = db_now
   WHERE approval_ref = requested_ref AND status = 'approved';
  IF NOT FOUND THEN
    RAISE serialization_failure USING MESSAGE = 'approval request already consumed';
  END IF;
  RETURN request_row.decided_by_staff_id;
END
$$;

REVOKE ALL ON TABLE public.ai_approval_requests FROM PUBLIC, laundry_app;
GRANT SELECT ON TABLE public.ai_approval_requests TO laundry_app;
REVOKE ALL ON FUNCTION public.ai_approval_request_create(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_ai_approval_admin() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ai_approval_request_decide(uuid, integer, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ai_approval_request_consume(uuid, uuid, text, jsonb, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ai_approval_request_create(uuid, uuid) TO laundry_app;
GRANT EXECUTE ON FUNCTION public.assert_ai_approval_admin() TO laundry_app;
GRANT EXECUTE ON FUNCTION public.ai_approval_request_decide(uuid, integer, text, text) TO laundry_app;
GRANT EXECUTE ON FUNCTION public.ai_approval_request_consume(uuid, uuid, text, jsonb, uuid) TO laundry_app;
