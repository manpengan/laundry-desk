-- Expand-only: SECURITY DEFINER auth lookups for laundry_app under FORCE RLS.
-- Opaque token / session / family / pin reads cannot set tenant GUC first.
-- Functions run as owner (laundry_owner maintenance policies / CREATE owner).
-- Writes still go through laundry_app + SET LOCAL app.org_id / app.store_id.

CREATE OR REPLACE FUNCTION laundry_auth_find_org_store(p_org_code text, p_store_code text)
RETURNS TABLE (
  org_id uuid,
  org_code text,
  store_id uuid,
  store_code text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT o.id, o.code, s.id, s.code
  FROM orgs o
  INNER JOIN stores s ON s.org_id = o.id
  WHERE o.code = p_org_code AND s.code = p_store_code
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION laundry_auth_lookup_session(p_session_id uuid)
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
SET search_path = public
STABLE
AS $$
  SELECT s.id, s.org_id, s.store_id, s.staff_id, s.device_id,
         s.session_version, s.permission_version, s.authentication_method,
         s.status, s.created_at, s.revoked_at,
         (
           SELECT f.id
           FROM refresh_families f
           WHERE f.session_id = s.id
           ORDER BY CASE WHEN f.status = 'active' THEN 0 ELSE 1 END, f.created_at DESC
           LIMIT 1
         ) AS family_id
  FROM sessions s
  WHERE s.id = p_session_id
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION laundry_auth_lookup_family(p_family_id uuid)
RETURNS TABLE (
  id uuid,
  session_id uuid,
  org_id uuid,
  store_id uuid,
  status text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT id, session_id, org_id, store_id, status
  FROM refresh_families
  WHERE id = p_family_id
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION laundry_auth_lookup_refresh_by_hash(p_token_hash text)
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
SET search_path = public
STABLE
AS $$
  SELECT id, family_id, session_id, org_id, store_id, token_hash, status,
         replacement_token_id, expires_at
  FROM refresh_tokens
  WHERE token_hash = p_token_hash
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION laundry_auth_lookup_refresh_by_id(p_token_id uuid)
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
SET search_path = public
STABLE
AS $$
  SELECT id, family_id, session_id, org_id, store_id, token_hash, status,
         replacement_token_id, expires_at
  FROM refresh_tokens
  WHERE id = p_token_id
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION laundry_auth_lookup_pin(p_challenge_id uuid)
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
SET search_path = public
STABLE
AS $$
  SELECT p.id, p.org_id, p.store_id, p.device_id, p.session_id, p.session_version,
         p.purpose, p.target_staff_id, p.approver_staff_id, p.pending_action_ref,
         p.nonce, p.attempts, p.max_attempts, p.status, p.issued_at, p.expires_at,
         s.staff_id AS requester_staff_id
  FROM pin_challenges p
  INNER JOIN sessions s ON s.id = p.session_id
  WHERE p.id = p_challenge_id
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION laundry_auth_find_org_store(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION laundry_auth_lookup_session(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION laundry_auth_lookup_family(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION laundry_auth_lookup_refresh_by_hash(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION laundry_auth_lookup_refresh_by_id(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION laundry_auth_lookup_pin(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION laundry_auth_find_org_store(text, text) TO laundry_app;
GRANT EXECUTE ON FUNCTION laundry_auth_lookup_session(uuid) TO laundry_app;
GRANT EXECUTE ON FUNCTION laundry_auth_lookup_family(uuid) TO laundry_app;
GRANT EXECUTE ON FUNCTION laundry_auth_lookup_refresh_by_hash(text) TO laundry_app;
GRANT EXECUTE ON FUNCTION laundry_auth_lookup_refresh_by_id(uuid) TO laundry_app;
GRANT EXECUTE ON FUNCTION laundry_auth_lookup_pin(uuid) TO laundry_app;
