-- Expand-only indexes for the identity lifecycle transaction hot paths.

CREATE INDEX IF NOT EXISTS sessions_active_device_idx
  ON sessions (org_id, store_id, device_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS refresh_families_active_session_idx
  ON refresh_families (org_id, store_id, session_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS refresh_tokens_active_family_idx
  ON refresh_tokens (org_id, store_id, family_id)
  WHERE status = 'active';
