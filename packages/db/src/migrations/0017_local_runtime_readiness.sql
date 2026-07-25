-- Expand-only: expose one boolean proof of explicit local bootstrap to laundry_app.
-- The owner-only metadata row remains unreadable; the runtime learns only whether
-- the expected profile and demo mode exactly match.

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
    JOIN public.orgs org
      ON org.id = metadata.org_id
    JOIN public.stores store
      ON store.org_id = metadata.org_id
     AND store.id = metadata.store_id
    JOIN public.staffs admin
      ON admin.org_id = metadata.org_id
     AND admin.id = metadata.admin_staff_id
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

-- Older auth lookups predate the explicit pg_temp hardening. Recreate their final
-- signatures with every application relation schema-qualified and pg_temp explicitly
-- last, so a temporary relation can never shadow owner-owned data.

CREATE OR REPLACE FUNCTION public.laundry_auth_find_org_store(
  p_org_code text,
  p_store_code text
)
RETURNS TABLE (
  org_id uuid,
  org_code text,
  store_id uuid,
  store_code text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
STABLE
AS $$
  SELECT org.id, org.code, store.id, store.code
  FROM public.orgs org
  INNER JOIN public.stores store ON store.org_id = org.id
  WHERE org.code = p_org_code
    AND store.code = p_store_code
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.laundry_auth_lookup_session(p_session_id uuid)
RETURNS TABLE (
  id uuid,
  org_id uuid,
  store_id uuid,
  staff_id uuid,
  device_id uuid,
  session_version integer,
  permission_version integer,
  authentication_method text,
  status text,
  created_at timestamptz,
  revoked_at timestamptz,
  family_id uuid
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
STABLE
AS $$
  SELECT session.id, session.org_id, session.store_id, session.staff_id, session.device_id,
         session.session_version, session.permission_version, session.authentication_method,
         session.status, session.created_at, session.revoked_at,
         (
           SELECT family.id
           FROM public.refresh_families family
           WHERE family.session_id = session.id
           ORDER BY CASE WHEN family.status = 'active' THEN 0 ELSE 1 END,
                    family.created_at DESC
           LIMIT 1
         ) AS family_id
  FROM public.sessions session
  WHERE session.id = p_session_id
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.laundry_auth_lookup_family(p_family_id uuid)
RETURNS TABLE (
  id uuid,
  session_id uuid,
  org_id uuid,
  store_id uuid,
  status text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
STABLE
AS $$
  SELECT family.id, family.session_id, family.org_id, family.store_id, family.status
  FROM public.refresh_families family
  WHERE family.id = p_family_id
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.laundry_auth_lookup_refresh_by_hash(p_token_hash text)
RETURNS TABLE (
  id uuid,
  family_id uuid,
  session_id uuid,
  org_id uuid,
  store_id uuid,
  token_hash text,
  status text,
  replacement_token_id uuid,
  expires_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
STABLE
AS $$
  SELECT token.id, token.family_id, token.session_id, token.org_id, token.store_id,
         token.token_hash, token.status, token.replacement_token_id, token.expires_at
  FROM public.refresh_tokens token
  WHERE token.token_hash = p_token_hash
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.laundry_auth_lookup_refresh_by_id(p_token_id uuid)
RETURNS TABLE (
  id uuid,
  family_id uuid,
  session_id uuid,
  org_id uuid,
  store_id uuid,
  token_hash text,
  status text,
  replacement_token_id uuid,
  expires_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
STABLE
AS $$
  SELECT token.id, token.family_id, token.session_id, token.org_id, token.store_id,
         token.token_hash, token.status, token.replacement_token_id, token.expires_at
  FROM public.refresh_tokens token
  WHERE token.id = p_token_id
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.laundry_auth_lookup_pin(p_challenge_id uuid)
RETURNS TABLE (
  id uuid,
  org_id uuid,
  store_id uuid,
  device_id uuid,
  session_id uuid,
  session_version integer,
  purpose text,
  target_staff_id uuid,
  approver_staff_id uuid,
  pending_action_ref text,
  args_hash text,
  entity_versions jsonb,
  idempotency_key uuid,
  nonce text,
  attempts integer,
  max_attempts integer,
  status text,
  issued_at timestamptz,
  expires_at timestamptz,
  requester_staff_id uuid
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
STABLE
AS $$
  SELECT challenge.id, challenge.org_id, challenge.store_id, challenge.device_id,
         challenge.session_id, challenge.session_version, challenge.purpose,
         challenge.target_staff_id, challenge.approver_staff_id,
         challenge.pending_action_ref, challenge.args_hash, challenge.entity_versions,
         challenge.idempotency_key, challenge.nonce, challenge.attempts,
         challenge.max_attempts, challenge.status, challenge.issued_at,
         challenge.expires_at, session.staff_id AS requester_staff_id
  FROM public.pin_challenges challenge
  INNER JOIN public.sessions session ON session.id = challenge.session_id
  WHERE challenge.id = p_challenge_id
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.laundry_auth_find_org_store(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.laundry_auth_lookup_session(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.laundry_auth_lookup_family(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.laundry_auth_lookup_refresh_by_hash(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.laundry_auth_lookup_refresh_by_id(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.laundry_auth_lookup_pin(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.laundry_auth_find_org_store(text, text) TO laundry_app;
GRANT EXECUTE ON FUNCTION public.laundry_auth_lookup_session(uuid) TO laundry_app;
GRANT EXECUTE ON FUNCTION public.laundry_auth_lookup_family(uuid) TO laundry_app;
GRANT EXECUTE ON FUNCTION public.laundry_auth_lookup_refresh_by_hash(text) TO laundry_app;
GRANT EXECUTE ON FUNCTION public.laundry_auth_lookup_refresh_by_id(uuid) TO laundry_app;
GRANT EXECUTE ON FUNCTION public.laundry_auth_lookup_pin(uuid) TO laundry_app;

-- Runtime reads organizations for profile and auth lookup only. Explicit owner bootstrap
-- is now the sole production writer for this global, non-RLS table.
REVOKE INSERT, UPDATE ON TABLE public.orgs FROM laundry_app;

-- The runtime role must not create schemas or shadow objects ahead of public in search_path.
REVOKE CREATE ON SCHEMA public FROM PUBLIC, laundry_app;

DO $$
BEGIN
  EXECUTE pg_catalog.format(
    'REVOKE CREATE ON DATABASE %I FROM PUBLIC, laundry_app',
    pg_catalog.current_database()
  );
  EXECUTE pg_catalog.format(
    'REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC, laundry_app',
    pg_catalog.current_database()
  );
END
$$;
