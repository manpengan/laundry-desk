-- Ordinary offline-grant replay. Grant sequencing is independent from the
-- Primary lease epoch and is serialized in the command's business transaction.

CREATE TABLE IF NOT EXISTS offline_grant_replay_state (
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  grant_id uuid NOT NULL,
  last_seq bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (org_id, store_id, grant_id),
  CONSTRAINT offline_grant_replay_state_grant_fk
    FOREIGN KEY (org_id, store_id, grant_id)
    REFERENCES offline_grants (org_id, store_id, id),
  CONSTRAINT offline_grant_replay_state_seq_chk CHECK (last_seq >= 0)
);

ALTER TABLE edge_replay_records
  ADD COLUMN IF NOT EXISTS authorization_kind text;
ALTER TABLE edge_replay_records
  ADD COLUMN IF NOT EXISTS reported_per_grant_seq bigint;
ALTER TABLE edge_replay_records
  ADD COLUMN IF NOT EXISTS accepted_per_grant_seq bigint;

-- Every pre-0033 record was authorized by a Primary lease.
UPDATE edge_replay_records
   SET authorization_kind = 'primary_lease'
 WHERE authorization_kind IS NULL;

ALTER TABLE edge_replay_records
  ALTER COLUMN authorization_kind SET NOT NULL;
ALTER TABLE edge_replay_records
  ALTER COLUMN lease_id DROP NOT NULL;
ALTER TABLE edge_replay_records
  ALTER COLUMN primary_epoch DROP NOT NULL;
ALTER TABLE edge_replay_records
  ALTER COLUMN reported_per_lease_seq DROP NOT NULL;

-- PostgreSQL cannot widen a CHECK in place. Both constraints are immediately
-- replaced with strict tagged-union shapes; no accepted historical row is lost.
ALTER TABLE edge_replay_records DROP CONSTRAINT IF EXISTS edge_replay_records_epoch_seq_chk;
ALTER TABLE edge_replay_records DROP CONSTRAINT IF EXISTS edge_replay_records_acceptance_chk;

ALTER TABLE edge_replay_records
  ADD CONSTRAINT edge_replay_records_authorization_shape_chk CHECK (
    (
      authorization_kind = 'grant'
      AND lease_id IS NULL
      AND primary_epoch IS NULL
      AND reported_per_lease_seq IS NULL
      AND accepted_per_lease_seq IS NULL
      AND reported_per_grant_seq IS NOT NULL
      AND reported_per_grant_seq > 0
      AND (accepted_per_grant_seq IS NULL OR accepted_per_grant_seq > 0)
    )
    OR
    (
      authorization_kind = 'primary_lease'
      AND lease_id IS NOT NULL
      AND primary_epoch IS NOT NULL
      AND primary_epoch > 0
      AND reported_per_lease_seq IS NOT NULL
      AND reported_per_lease_seq > 0
      AND (accepted_per_lease_seq IS NULL OR accepted_per_lease_seq > 0)
      AND reported_per_grant_seq IS NULL
      AND accepted_per_grant_seq IS NULL
    )
  );

ALTER TABLE edge_replay_records
  ADD CONSTRAINT edge_replay_records_acceptance_chk CHECK (
    (
      decision IN ('applied', 'arbitration')
      AND accepted_queue_id IS NOT NULL
      AND (
        (authorization_kind = 'grant' AND accepted_per_grant_seq IS NOT NULL)
        OR
        (authorization_kind = 'primary_lease' AND accepted_per_lease_seq IS NOT NULL)
      )
    )
    OR
    (
      decision IN ('duplicate', 'collision', 'rejected')
      AND accepted_queue_id IS NULL
      AND accepted_per_grant_seq IS NULL
      AND accepted_per_lease_seq IS NULL
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS edge_replay_records_accepted_grant_seq_uidx
  ON edge_replay_records (org_id, store_id, grant_id, accepted_per_grant_seq)
  WHERE authorization_kind = 'grant' AND accepted_per_grant_seq IS NOT NULL;

CREATE OR REPLACE FUNCTION guard_offline_grant_replay_monotonicity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.last_seq <> 0 THEN
      RAISE EXCEPTION 'offline grant replay head must start at zero' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.store_id IS DISTINCT FROM OLD.store_id
     OR NEW.grant_id IS DISTINCT FROM OLD.grant_id
     OR NEW.last_seq <> OLD.last_seq + 1 THEN
    RAISE EXCEPTION 'offline grant replay head must advance monotonically'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS offline_grant_replay_state_monotonicity
  ON offline_grant_replay_state;
CREATE TRIGGER offline_grant_replay_state_monotonicity
BEFORE INSERT OR UPDATE ON offline_grant_replay_state
FOR EACH ROW EXECUTE FUNCTION guard_offline_grant_replay_monotonicity();

ALTER TABLE offline_grant_replay_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE offline_grant_replay_state FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS offline_grant_replay_state_store_scope
  ON offline_grant_replay_state;
CREATE POLICY offline_grant_replay_state_store_scope
  ON offline_grant_replay_state
  AS PERMISSIVE
  FOR ALL
  TO laundry_app
  USING (
    org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid
  );

DROP POLICY IF EXISTS offline_grant_replay_state_maintenance
  ON offline_grant_replay_state;
CREATE POLICY offline_grant_replay_state_maintenance
  ON offline_grant_replay_state
  AS PERMISSIVE
  FOR ALL
  TO laundry_owner
  USING (true)
  WITH CHECK (true);

REVOKE ALL ON TABLE offline_grant_replay_state FROM PUBLIC, laundry_app;
GRANT SELECT, INSERT ON TABLE offline_grant_replay_state TO laundry_app;
GRANT UPDATE (last_seq, updated_at) ON TABLE offline_grant_replay_state TO laundry_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE edge_replay_records FROM laundry_app;
REVOKE ALL ON FUNCTION guard_offline_grant_replay_monotonicity() FROM PUBLIC;
