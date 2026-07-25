-- Expand-only: distinguish demo organizations and record one explicit local bootstrap.
-- local_bootstrap_metadata is deliberately owner-only and is never exposed to laundry_app.

ALTER TABLE orgs
  ADD COLUMN IF NOT EXISTS demo_only boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS local_bootstrap_metadata (
  singleton boolean PRIMARY KEY DEFAULT true,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  admin_staff_id uuid NOT NULL,
  profile_hash char(64) NOT NULL,
  demo_only boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT local_bootstrap_metadata_singleton_chk CHECK (singleton),
  CONSTRAINT local_bootstrap_metadata_profile_hash_chk
    CHECK (profile_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT local_bootstrap_metadata_org_fk
    FOREIGN KEY (org_id) REFERENCES orgs (id),
  CONSTRAINT local_bootstrap_metadata_store_fk
    FOREIGN KEY (org_id, store_id) REFERENCES stores (org_id, id),
  CONSTRAINT local_bootstrap_metadata_admin_staff_fk
    FOREIGN KEY (org_id, admin_staff_id) REFERENCES staffs (org_id, id)
);

REVOKE ALL ON TABLE local_bootstrap_metadata FROM PUBLIC, laundry_app;
