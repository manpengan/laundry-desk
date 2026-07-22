-- Expand-only: persist A5 step-up WYSIWYS binding on pin_challenges.
-- args_hash / entity_versions / idempotency_key are null/empty for quick_switch.

ALTER TABLE pin_challenges
  ADD COLUMN IF NOT EXISTS args_hash text,
  ADD COLUMN IF NOT EXISTS entity_versions jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS idempotency_key uuid;

-- Only non-null hashes must be lowercase SHA-256 hex (64 chars).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'pin_challenges_args_hash_chk'
      AND conrelid = 'public.pin_challenges'::regclass
  ) THEN
    ALTER TABLE pin_challenges
      ADD CONSTRAINT pin_challenges_args_hash_chk
      CHECK (
        args_hash IS NULL
        OR args_hash ~ '^[a-f0-9]{64}$'
      );
  END IF;
END
$$;

-- Recreate SECURITY DEFINER lookup so laundry_app can read binding without GUC.
-- (CREATE OR REPLACE cannot change RETURNS TABLE shape.)
DROP FUNCTION IF EXISTS laundry_auth_lookup_pin(uuid);

CREATE FUNCTION laundry_auth_lookup_pin(p_challenge_id uuid)
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
SET search_path = public
STABLE
AS $$
  SELECT p.id, p.org_id, p.store_id, p.device_id, p.session_id, p.session_version,
         p.purpose, p.target_staff_id, p.approver_staff_id, p.pending_action_ref,
         p.args_hash, p.entity_versions, p.idempotency_key,
         p.nonce, p.attempts, p.max_attempts, p.status, p.issued_at, p.expires_at,
         s.staff_id AS requester_staff_id
  FROM pin_challenges p
  INNER JOIN sessions s ON s.id = p.session_id
  WHERE p.id = p_challenge_id
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION laundry_auth_lookup_pin(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION laundry_auth_lookup_pin(uuid) TO laundry_app;
