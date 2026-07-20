\set ON_ERROR_STOP on

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'laundry_lease_app') THEN
    CREATE ROLE laundry_lease_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOINHERIT NOBYPASSRLS;
  END IF;
END
$roles$;
ALTER ROLE laundry_lease_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOINHERIT NOBYPASSRLS PASSWORD :'app_password';

DROP TABLE IF EXISTS replay_domain_effects;
DROP TABLE IF EXISTS primary_lease_replay_state;
DROP TABLE IF EXISTS offline_command_audit;
DROP TABLE IF EXISTS primary_leases;
DROP TABLE IF EXISTS primary_lease_heads;

CREATE TABLE primary_lease_heads (
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  current_epoch bigint NOT NULL DEFAULT 0 CHECK (current_epoch >= 0),
  current_lease_id uuid,
  current_not_after timestamptz,
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  PRIMARY KEY (org_id, store_id)
);

CREATE TABLE primary_leases (
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  device_id uuid NOT NULL,
  lease_id uuid NOT NULL UNIQUE,
  primary_epoch bigint NOT NULL CHECK (primary_epoch > 0),
  issued_at timestamptz NOT NULL,
  ttl_ms integer NOT NULL CHECK (ttl_ms > 0),
  max_clock_skew_ms integer NOT NULL CHECK (max_clock_skew_ms >= 0),
  not_after timestamptz NOT NULL,
  released_at timestamptz,
  sig text NOT NULL,
  UNIQUE (org_id, store_id, primary_epoch),
  CHECK (not_after = issued_at + ttl_ms * interval '1 millisecond'),
  CHECK (released_at IS NULL OR released_at >= issued_at)
);

CREATE TABLE offline_command_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  lease_id uuid NOT NULL,
  primary_epoch bigint NOT NULL,
  per_lease_seq bigint NOT NULL CHECK (per_lease_seq > 0),
  command_name text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('apply', 'arbitrate')),
  reason text NOT NULL,
  arbitration_required boolean NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (
    org_id, store_id, lease_id, primary_epoch, per_lease_seq, command_name
  )
);

CREATE TABLE primary_lease_replay_state (
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  lease_id uuid NOT NULL,
  last_seq bigint NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
  PRIMARY KEY (org_id, store_id, lease_id)
);

CREATE TABLE replay_domain_effects (
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  lease_id uuid NOT NULL,
  per_lease_seq bigint NOT NULL,
  command_name text NOT NULL,
  PRIMARY KEY (org_id, store_id, lease_id, per_lease_seq)
);

REVOKE ALL ON primary_lease_heads, primary_leases,
  primary_lease_replay_state, offline_command_audit,
  replay_domain_effects FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON primary_lease_heads, primary_leases,
  primary_lease_replay_state TO laundry_lease_app;
GRANT SELECT, INSERT ON offline_command_audit, replay_domain_effects
  TO laundry_lease_app;
GRANT USAGE, SELECT ON SEQUENCE offline_command_audit_id_seq
  TO laundry_lease_app;
