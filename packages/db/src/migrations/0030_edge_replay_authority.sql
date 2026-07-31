-- Durable device authority and ordered Edge replay arbitration.
-- All rows are store scoped and FORCE RLS. Replay records are append-only for
-- the application role; mutable high-water state is isolated in its own table.

CREATE TABLE IF NOT EXISTS edge_devices (
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  device_id uuid NOT NULL,
  public_key_spki text NOT NULL,
  public_key_fingerprint char(64) NOT NULL,
  status text NOT NULL DEFAULT 'paired',
  paired_by_staff_id uuid NOT NULL,
  paired_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  revoked_at timestamptz,
  PRIMARY KEY (org_id, store_id, device_id),
  CONSTRAINT edge_devices_store_fk
    FOREIGN KEY (org_id, store_id) REFERENCES stores (org_id, id),
  CONSTRAINT edge_devices_staff_fk
    FOREIGN KEY (org_id, paired_by_staff_id) REFERENCES staffs (org_id, id),
  CONSTRAINT edge_devices_key_chk
    CHECK (
      char_length(public_key_spki) BETWEEN 40 AND 256
      AND public_key_spki ~ '^[A-Za-z0-9_-]+$'
    ),
  CONSTRAINT edge_devices_fingerprint_chk
    CHECK (public_key_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT edge_devices_status_chk CHECK (status IN ('paired', 'revoked')),
  CONSTRAINT edge_devices_revoked_shape_chk
    CHECK ((status = 'paired' AND revoked_at IS NULL) OR (status = 'revoked' AND revoked_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS edge_authority_challenges (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  staff_id uuid NOT NULL,
  session_id uuid NOT NULL,
  session_version integer NOT NULL,
  permission_version integer NOT NULL,
  device_id uuid NOT NULL,
  device_public_key_spki text NOT NULL,
  device_public_key_fingerprint char(64) NOT NULL,
  challenge_sha256 char(64) NOT NULL,
  request_nonce uuid NOT NULL,
  request_primary boolean NOT NULL,
  pairing_code_hash char(64),
  pairing_code_required boolean NOT NULL,
  expected_primary_epoch bigint,
  actor_role text NOT NULL,
  authentication_method text NOT NULL,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CONSTRAINT edge_authority_challenges_store_fk
    FOREIGN KEY (org_id, store_id) REFERENCES stores (org_id, id),
  CONSTRAINT edge_authority_challenges_staff_fk
    FOREIGN KEY (org_id, staff_id) REFERENCES staffs (org_id, id),
  CONSTRAINT edge_authority_challenges_hash_chk
    CHECK (challenge_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT edge_authority_challenges_device_key_chk CHECK (
    char_length(device_public_key_spki) BETWEEN 40 AND 256
    AND device_public_key_spki ~ '^[A-Za-z0-9_-]+$'
    AND device_public_key_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT edge_authority_challenges_pairing_hash_chk CHECK (
    (pairing_code_required AND pairing_code_hash ~ '^[0-9a-f]{64}$')
    OR (NOT pairing_code_required AND pairing_code_hash IS NULL)
  ),
  CONSTRAINT edge_authority_challenges_primary_intent_chk CHECK (
    (request_primary AND expected_primary_epoch IS NOT NULL AND expected_primary_epoch >= 0)
    OR (NOT request_primary AND expected_primary_epoch IS NULL)
  ),
  CONSTRAINT edge_authority_challenges_actor_chk CHECK (
    actor_role IN ('admin', 'staff')
    AND authentication_method IN ('password', 'pin', 'refresh')
  ),
  CONSTRAINT edge_authority_challenges_versions_chk
    CHECK (session_version > 0 AND permission_version > 0),
  CONSTRAINT edge_authority_challenges_time_chk CHECK (
    expires_at > issued_at AND (consumed_at IS NULL OR consumed_at >= issued_at)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS edge_authority_challenges_tenant_id_uidx
  ON edge_authority_challenges (org_id, store_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS edge_authority_challenges_device_uidx
  ON edge_authority_challenges (org_id, store_id, device_id);
CREATE UNIQUE INDEX IF NOT EXISTS edge_authority_challenges_request_nonce_uidx
  ON edge_authority_challenges (org_id, store_id, request_nonce);
CREATE INDEX IF NOT EXISTS edge_authority_challenges_expiry_idx
  ON edge_authority_challenges (org_id, store_id, expires_at);

CREATE TABLE IF NOT EXISTS offline_grants (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  staff_id uuid NOT NULL,
  device_id uuid NOT NULL,
  request_nonce uuid NOT NULL,
  permission_version integer NOT NULL,
  allowed_commands jsonb NOT NULL,
  protocol_version text NOT NULL,
  signature text NOT NULL,
  issued_at timestamptz NOT NULL,
  not_after timestamptz NOT NULL,
  revoked_at timestamptz,
  CONSTRAINT offline_grants_store_fk
    FOREIGN KEY (org_id, store_id) REFERENCES stores (org_id, id),
  CONSTRAINT offline_grants_staff_fk
    FOREIGN KEY (org_id, staff_id) REFERENCES staffs (org_id, id),
  CONSTRAINT offline_grants_device_fk
    FOREIGN KEY (org_id, store_id, device_id)
    REFERENCES edge_devices (org_id, store_id, device_id),
  CONSTRAINT offline_grants_permission_version_chk CHECK (permission_version > 0),
  CONSTRAINT offline_grants_commands_chk
    CHECK (jsonb_typeof(allowed_commands) = 'array' AND jsonb_array_length(allowed_commands) > 0),
  CONSTRAINT offline_grants_protocol_chk CHECK (protocol_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  CONSTRAINT offline_grants_signature_chk CHECK (signature ~ '^[A-Za-z0-9_-]{86}$'),
  CONSTRAINT offline_grants_time_chk CHECK (not_after > issued_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS offline_grants_tenant_id_uidx
  ON offline_grants (org_id, store_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS offline_grants_request_nonce_uidx
  ON offline_grants (org_id, store_id, request_nonce);
CREATE INDEX IF NOT EXISTS offline_grants_device_time_idx
  ON offline_grants (org_id, store_id, device_id, not_after DESC);

CREATE TABLE IF NOT EXISTS primary_lease_heads (
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  current_epoch bigint NOT NULL DEFAULT 0,
  current_lease_id uuid,
  current_device_id uuid,
  current_not_after timestamptz,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (org_id, store_id),
  CONSTRAINT primary_lease_heads_store_fk
    FOREIGN KEY (org_id, store_id) REFERENCES stores (org_id, id),
  CONSTRAINT primary_lease_heads_epoch_chk CHECK (current_epoch >= 0),
  CONSTRAINT primary_lease_heads_shape_chk CHECK (
    (current_lease_id IS NULL AND current_device_id IS NULL AND current_not_after IS NULL)
    OR
    (current_lease_id IS NOT NULL AND current_device_id IS NOT NULL AND current_not_after IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS primary_leases (
  id uuid PRIMARY KEY,
  grant_id uuid NOT NULL,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  device_id uuid NOT NULL,
  primary_epoch bigint NOT NULL,
  protocol_version text NOT NULL,
  signature text NOT NULL,
  issued_at timestamptz NOT NULL,
  ttl_ms integer NOT NULL,
  max_clock_skew_ms integer NOT NULL,
  not_after timestamptz NOT NULL,
  released_at timestamptz,
  CONSTRAINT primary_leases_store_fk
    FOREIGN KEY (org_id, store_id) REFERENCES stores (org_id, id),
  CONSTRAINT primary_leases_device_fk
    FOREIGN KEY (org_id, store_id, device_id)
    REFERENCES edge_devices (org_id, store_id, device_id),
  CONSTRAINT primary_leases_grant_fk
    FOREIGN KEY (org_id, store_id, grant_id)
    REFERENCES offline_grants (org_id, store_id, id),
  CONSTRAINT primary_leases_epoch_chk CHECK (primary_epoch > 0),
  CONSTRAINT primary_leases_protocol_chk CHECK (protocol_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  CONSTRAINT primary_leases_signature_chk CHECK (signature ~ '^[A-Za-z0-9_-]{86}$'),
  CONSTRAINT primary_leases_timing_chk
    CHECK (ttl_ms > 0 AND max_clock_skew_ms >= 0 AND not_after > issued_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS primary_leases_tenant_id_uidx
  ON primary_leases (org_id, store_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS primary_leases_store_epoch_uidx
  ON primary_leases (org_id, store_id, primary_epoch);
CREATE UNIQUE INDEX IF NOT EXISTS primary_leases_grant_uidx
  ON primary_leases (org_id, store_id, grant_id);

CREATE TABLE IF NOT EXISTS primary_lease_replay_state (
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  lease_id uuid NOT NULL,
  last_seq bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (org_id, store_id, lease_id),
  CONSTRAINT primary_lease_replay_state_lease_fk
    FOREIGN KEY (org_id, store_id, lease_id)
    REFERENCES primary_leases (org_id, store_id, id),
  CONSTRAINT primary_lease_replay_state_seq_chk CHECK (last_seq >= 0)
);

CREATE TABLE IF NOT EXISTS edge_replay_records (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  reported_queue_id uuid NOT NULL,
  accepted_queue_id uuid,
  grant_id uuid NOT NULL,
  lease_id uuid NOT NULL,
  original_staff_id uuid NOT NULL,
  replayed_by_staff_id uuid NOT NULL,
  device_id uuid NOT NULL,
  primary_epoch bigint NOT NULL,
  reported_per_lease_seq bigint NOT NULL,
  accepted_per_lease_seq bigint,
  envelope_sha256 char(64) NOT NULL,
  command text NOT NULL,
  idempotency_key uuid NOT NULL,
  decision text NOT NULL,
  reason text NOT NULL,
  result_json jsonb,
  recorded_at timestamptz NOT NULL,
  CONSTRAINT edge_replay_records_store_fk
    FOREIGN KEY (org_id, store_id) REFERENCES stores (org_id, id),
  CONSTRAINT edge_replay_records_grant_fk
    FOREIGN KEY (org_id, store_id, grant_id)
    REFERENCES offline_grants (org_id, store_id, id),
  CONSTRAINT edge_replay_records_lease_fk
    FOREIGN KEY (org_id, store_id, lease_id)
    REFERENCES primary_leases (org_id, store_id, id),
  CONSTRAINT edge_replay_records_staff_fk
    FOREIGN KEY (org_id, original_staff_id) REFERENCES staffs (org_id, id),
  CONSTRAINT edge_replay_records_replayer_fk
    FOREIGN KEY (org_id, replayed_by_staff_id) REFERENCES staffs (org_id, id),
  CONSTRAINT edge_replay_records_device_fk
    FOREIGN KEY (org_id, store_id, device_id)
    REFERENCES edge_devices (org_id, store_id, device_id),
  CONSTRAINT edge_replay_records_epoch_seq_chk
    CHECK (primary_epoch > 0 AND reported_per_lease_seq > 0
      AND (accepted_per_lease_seq IS NULL OR accepted_per_lease_seq > 0)),
  CONSTRAINT edge_replay_records_hash_chk CHECK (envelope_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT edge_replay_records_decision_chk
    CHECK (decision IN ('applied', 'duplicate', 'arbitration', 'collision', 'rejected')),
  CONSTRAINT edge_replay_records_acceptance_chk CHECK (
    (decision IN ('applied', 'arbitration')
      AND accepted_queue_id IS NOT NULL AND accepted_per_lease_seq IS NOT NULL)
    OR
    (decision IN ('duplicate', 'collision', 'rejected')
      AND accepted_queue_id IS NULL AND accepted_per_lease_seq IS NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS edge_replay_records_accepted_queue_uidx
  ON edge_replay_records (org_id, store_id, accepted_queue_id)
  WHERE accepted_queue_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS edge_replay_records_accepted_seq_uidx
  ON edge_replay_records (org_id, store_id, lease_id, accepted_per_lease_seq)
  WHERE accepted_per_lease_seq IS NOT NULL;
CREATE INDEX IF NOT EXISTS edge_replay_records_reported_queue_idx
  ON edge_replay_records (org_id, store_id, reported_queue_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS edge_replay_records_store_recorded_idx
  ON edge_replay_records (org_id, store_id, recorded_at DESC);

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'edge_devices',
    'edge_authority_challenges',
    'offline_grants',
    'primary_lease_heads',
    'primary_leases',
    'primary_lease_replay_state',
    'edge_replay_records'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', table_name || '_store_scope', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS PERMISSIVE FOR ALL TO laundry_app '
      || 'USING (org_id = NULLIF(current_setting(''app.org_id'', true), '''')::uuid '
      || 'AND store_id = NULLIF(current_setting(''app.store_id'', true), '''')::uuid) '
      || 'WITH CHECK (org_id = NULLIF(current_setting(''app.org_id'', true), '''')::uuid '
      || 'AND store_id = NULLIF(current_setting(''app.store_id'', true), '''')::uuid)',
      table_name || '_store_scope',
      table_name
    );
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', table_name || '_maintenance', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS PERMISSIVE FOR ALL TO laundry_owner '
      || 'USING (true) WITH CHECK (true)',
      table_name || '_maintenance',
      table_name
    );
  END LOOP;
END;
$$;

GRANT SELECT, INSERT, UPDATE ON TABLE edge_devices TO laundry_app;
GRANT SELECT, INSERT, DELETE ON TABLE edge_authority_challenges TO laundry_app;
GRANT UPDATE (consumed_at) ON TABLE edge_authority_challenges TO laundry_app;
GRANT SELECT, INSERT ON TABLE offline_grants TO laundry_app;
GRANT SELECT, INSERT, UPDATE ON TABLE primary_lease_heads TO laundry_app;
GRANT SELECT, INSERT ON TABLE primary_leases TO laundry_app;
GRANT SELECT, INSERT, UPDATE ON TABLE primary_lease_replay_state TO laundry_app;
GRANT SELECT, INSERT ON TABLE edge_replay_records TO laundry_app;

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE offline_grants FROM laundry_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE primary_leases FROM laundry_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE edge_replay_records FROM laundry_app;
REVOKE TRUNCATE ON TABLE edge_authority_challenges FROM laundry_app;
