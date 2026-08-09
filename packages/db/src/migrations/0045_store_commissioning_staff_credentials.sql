-- ADR-31: permanent store commissioning marker plus tenant-scoped, non-secret
-- staff credential setup authority. Plaintext credentials and their hashes are
-- deliberately absent from staff_credential_setups.

ALTER TABLE local_bootstrap_metadata
  ADD COLUMN IF NOT EXISTS approver_staff_id uuid,
  ADD COLUMN IF NOT EXISTS commissioned_at timestamptz,
  ADD COLUMN IF NOT EXISTS feature_profile_version integer NOT NULL DEFAULT 0;

ALTER TABLE local_bootstrap_metadata
  ADD CONSTRAINT local_bootstrap_metadata_approver_staff_fk
    FOREIGN KEY (org_id, approver_staff_id) REFERENCES staffs (org_id, id),
  ADD CONSTRAINT local_bootstrap_metadata_commissioned_chk CHECK (
    (commissioned_at IS NULL AND approver_staff_id IS NULL)
    OR (commissioned_at IS NOT NULL AND approver_staff_id IS NOT NULL)
  ),
  ADD CONSTRAINT local_bootstrap_metadata_feature_profile_version_chk
    CHECK (feature_profile_version >= 0),
  ADD CONSTRAINT local_bootstrap_metadata_distinct_approver_chk
    CHECK (approver_staff_id IS NULL OR approver_staff_id <> admin_staff_id);

CREATE OR REPLACE FUNCTION public.laundry_local_bootstrap_ready(
  expected_org_id uuid,
  expected_store_id uuid,
  expected_admin_staff_id uuid,
  expected_profile_hash text,
  expected_demo_only boolean
)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.local_bootstrap_metadata metadata
      JOIN public.orgs org ON org.id = metadata.org_id
      JOIN public.stores store
        ON store.org_id = metadata.org_id AND store.id = metadata.store_id
      JOIN public.staffs admin
        ON admin.org_id = metadata.org_id AND admin.id = metadata.admin_staff_id
     WHERE metadata.singleton = true
       AND metadata.org_id = expected_org_id
       AND metadata.store_id = expected_store_id
       AND metadata.admin_staff_id = expected_admin_staff_id
       AND expected_profile_hash ~ '^[0-9a-f]{64}$'
       AND metadata.profile_hash = expected_profile_hash
       AND metadata.demo_only = expected_demo_only
       AND org.demo_only = expected_demo_only
  );
$$;

ALTER FUNCTION public.laundry_local_bootstrap_ready(uuid, uuid, uuid, text, boolean)
  OWNER TO laundry_owner;
REVOKE ALL ON FUNCTION public.laundry_local_bootstrap_ready(uuid, uuid, uuid, text, boolean)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.laundry_local_bootstrap_ready(uuid, uuid, uuid, text, boolean)
  TO laundry_app, laundry_owner;

CREATE OR REPLACE FUNCTION public.laundry_local_commissioning_state(
  expected_org_id uuid,
  expected_store_id uuid,
  expected_admin_staff_id uuid,
  expected_profile_hash text,
  expected_demo_only boolean,
  expected_admin_role_id uuid,
  expected_approver_staff_id uuid,
  expected_approver_role_id uuid,
  expected_audit_id uuid,
  expected_feature_profile_version integer
)
RETURNS text
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT COALESCE((
    SELECT CASE
      WHEN metadata.approver_staff_id = expected_approver_staff_id
       AND metadata.commissioned_at IS NOT NULL
       AND metadata.feature_profile_version = expected_feature_profile_version
      THEN 'commissioned'
      WHEN metadata.approver_staff_id IS NULL
       AND metadata.commissioned_at IS NULL
       AND metadata.feature_profile_version = 0
       AND (
         SELECT count(*)
           FROM public.staff_store_roles counted_role
           JOIN public.staffs counted_staff
             ON counted_staff.org_id = counted_role.org_id
            AND counted_staff.id = counted_role.staff_id
          WHERE counted_role.org_id = metadata.org_id
            AND counted_role.store_id = metadata.store_id
            AND counted_role.role = 'admin'
            AND counted_role.is_active
            AND counted_staff.is_active
       ) = 1
       AND NOT EXISTS (
         SELECT 1 FROM public.staffs reserved_staff
          WHERE reserved_staff.id = expected_approver_staff_id
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.staff_store_roles reserved_role
          WHERE reserved_role.id = expected_approver_role_id
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.audit_log reserved_audit
          WHERE reserved_audit.id = expected_audit_id
       )
      THEN 'commission_required'
      ELSE 'invalid'
    END
      FROM public.local_bootstrap_metadata metadata
     WHERE metadata.singleton = true
       AND metadata.org_id = expected_org_id
       AND metadata.store_id = expected_store_id
       AND metadata.admin_staff_id = expected_admin_staff_id
       AND metadata.demo_only = expected_demo_only
       AND public.laundry_local_bootstrap_ready(
         expected_org_id,
         expected_store_id,
         expected_admin_staff_id,
         expected_profile_hash,
         expected_demo_only
       )
       AND EXISTS (
         SELECT 1 FROM public.staff_store_roles admin_role
          WHERE admin_role.id = expected_admin_role_id
            AND admin_role.org_id = metadata.org_id
            AND admin_role.store_id = metadata.store_id
            AND admin_role.staff_id = metadata.admin_staff_id
            AND admin_role.role = 'admin'
            AND admin_role.is_active
            AND admin_role.is_privacy_admin
       )
  ), 'invalid');
$$;

ALTER FUNCTION public.laundry_local_commissioning_state(
  uuid, uuid, uuid, text, boolean, uuid, uuid, uuid, uuid, integer
) OWNER TO laundry_owner;
REVOKE ALL ON FUNCTION public.laundry_local_commissioning_state(
  uuid, uuid, uuid, text, boolean, uuid, uuid, uuid, uuid, integer
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.laundry_local_commissioning_state(
  uuid, uuid, uuid, text, boolean, uuid, uuid, uuid, uuid, integer
) TO laundry_app, laundry_owner;

CREATE TABLE IF NOT EXISTS staff_credential_setups (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  staff_id uuid NOT NULL,
  created_by_staff_id uuid NOT NULL,
  purpose text NOT NULL,
  activate_role text NOT NULL,
  activate_privacy_admin boolean NOT NULL DEFAULT false,
  target_permission_version integer NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT staff_credential_setups_store_fk
    FOREIGN KEY (org_id, store_id) REFERENCES stores (org_id, id),
  CONSTRAINT staff_credential_setups_staff_fk
    FOREIGN KEY (org_id, staff_id) REFERENCES staffs (org_id, id),
  CONSTRAINT staff_credential_setups_creator_fk
    FOREIGN KEY (org_id, created_by_staff_id) REFERENCES staffs (org_id, id),
  CONSTRAINT staff_credential_setups_purpose_chk CHECK (purpose IN ('create', 'reset')),
  CONSTRAINT staff_credential_setups_role_chk CHECK (activate_role IN ('admin', 'staff')),
  CONSTRAINT staff_credential_setups_privacy_admin_chk
    CHECK (NOT activate_privacy_admin OR activate_role = 'admin'),
  CONSTRAINT staff_credential_setups_version_chk CHECK (target_permission_version > 0),
  CONSTRAINT staff_credential_setups_expiry_chk CHECK (expires_at > created_at),
  CONSTRAINT staff_credential_setups_status_chk
    CHECK (status IN ('pending', 'consumed', 'expired')),
  CONSTRAINT staff_credential_setups_consumption_chk CHECK (
    (status = 'consumed' AND consumed_at IS NOT NULL)
    OR (status <> 'consumed' AND consumed_at IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS staff_credential_setups_tenant_id_uidx
  ON staff_credential_setups (org_id, store_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS staff_credential_setups_target_pending_uidx
  ON staff_credential_setups (org_id, store_id, staff_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS staff_credential_setups_expiry_idx
  ON staff_credential_setups (org_id, store_id, status, expires_at);

CREATE INDEX IF NOT EXISTS staff_credential_setups_staff_idx
  ON staff_credential_setups (org_id, staff_id);

CREATE INDEX IF NOT EXISTS staff_credential_setups_creator_idx
  ON staff_credential_setups (org_id, created_by_staff_id);

ALTER TABLE public.staff_credential_setups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff_credential_setups FORCE ROW LEVEL SECURITY;

CREATE POLICY staff_credential_setups_store_scope ON public.staff_credential_setups
  AS PERMISSIVE
  FOR ALL
  TO laundry_app
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid);

CREATE POLICY staff_credential_setups_maintenance ON public.staff_credential_setups
  AS PERMISSIVE
  FOR ALL
  TO laundry_owner
  USING (true)
  WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE ON TABLE staff_credential_setups TO laundry_app;
REVOKE DELETE, TRUNCATE ON TABLE staff_credential_setups FROM laundry_app;

CREATE INDEX IF NOT EXISTS sessions_active_staff_idx
  ON public.sessions (org_id, staff_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS sessions_staff_idx
  ON public.sessions (org_id, staff_id);

CREATE INDEX IF NOT EXISTS refresh_families_active_org_session_idx
  ON public.refresh_families (org_id, session_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS refresh_tokens_active_org_session_idx
  ON public.refresh_tokens (org_id, session_id)
  WHERE status = 'active';

-- A credential reset is authorized in one store but invalidates the staff
-- identity across the whole organization. Keep that RLS bypass inside one
-- narrowly granted function instead of broadening the application's table
-- privileges or store-scoped policies.
CREATE OR REPLACE FUNCTION public.laundry_revoke_staff_sessions(
  expected_org_id uuid,
  expected_store_id uuid,
  expected_actor_staff_id uuid,
  expected_target_staff_id uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
STRICT
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  session_org_id text := NULLIF(current_setting('app.org_id', true), '');
  session_store_id text := NULLIF(current_setting('app.store_id', true), '');
  session_staff_id text := NULLIF(current_setting('app.staff_id', true), '');
  revoked_session_count integer;
BEGIN
  IF session_org_id IS NULL
    OR session_store_id IS NULL
    OR session_staff_id IS NULL
    OR session_org_id <> expected_org_id::text
    OR session_store_id <> expected_store_id::text
    OR session_staff_id <> expected_actor_staff_id::text
  THEN
    RAISE insufficient_privilege USING MESSAGE = 'staff session revocation authority unavailable';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.staff_store_roles actor_role
      JOIN public.staffs actor_staff
        ON actor_staff.org_id = actor_role.org_id
       AND actor_staff.id = actor_role.staff_id
     WHERE actor_role.org_id = expected_org_id
       AND actor_role.store_id = expected_store_id
       AND actor_role.staff_id = expected_actor_staff_id
       AND actor_role.role = 'admin'
       AND actor_role.is_active
       AND actor_staff.is_active
  ) OR NOT EXISTS (
    SELECT 1
      FROM public.staffs target_staff
     WHERE target_staff.org_id = expected_org_id
       AND target_staff.id = expected_target_staff_id
  ) THEN
    RAISE insufficient_privilege USING MESSAGE = 'staff session revocation authority unavailable';
  END IF;

  WITH target_sessions AS MATERIALIZED (
    SELECT session.id
     FROM public.sessions session
     WHERE session.org_id = expected_org_id
       AND session.staff_id = expected_target_staff_id
  ), revoked_sessions AS (
    UPDATE public.sessions session
       SET status = 'revoked',
           session_version = session.session_version + 1,
           revoked_at = clock_timestamp()
     WHERE session.id IN (SELECT target.id FROM target_sessions target)
       AND session.status = 'active'
    RETURNING session.id
  ), revoked_families AS (
    UPDATE public.refresh_families family
       SET status = 'revoked', revoked_at = clock_timestamp()
     WHERE family.org_id = expected_org_id
       AND family.session_id IN (SELECT target.id FROM target_sessions target)
       AND family.status = 'active'
    RETURNING family.id
  ), revoked_tokens AS (
    UPDATE public.refresh_tokens token
       SET status = 'revoked', revoked_at = clock_timestamp()
     WHERE token.org_id = expected_org_id
       AND token.session_id IN (SELECT target.id FROM target_sessions target)
       AND token.status = 'active'
    RETURNING token.id
  )
  SELECT count(*)::integer
    INTO revoked_session_count
    FROM revoked_sessions;

  RETURN revoked_session_count;
END;
$$;

ALTER FUNCTION public.laundry_revoke_staff_sessions(uuid, uuid, uuid, uuid)
  OWNER TO laundry_owner;
REVOKE ALL ON FUNCTION public.laundry_revoke_staff_sessions(uuid, uuid, uuid, uuid)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.laundry_revoke_staff_sessions(uuid, uuid, uuid, uuid)
  TO laundry_app, laundry_owner;
