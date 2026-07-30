-- Customer profile governance: auditable merge redirects without deleting a
-- customer row or weakening the existing org-scope RLS policy.

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS merged_into_id uuid,
  ADD COLUMN IF NOT EXISTS merged_at timestamptz;

ALTER TABLE customers
  ADD CONSTRAINT customers_merged_into_fk
  FOREIGN KEY (org_id, merged_into_id)
  REFERENCES customers (org_id, id)
  NOT VALID;

ALTER TABLE customers
  ADD CONSTRAINT customers_merge_pair_chk CHECK (
    (merged_into_id IS NULL AND merged_at IS NULL)
    OR (merged_into_id IS NOT NULL AND merged_at IS NOT NULL)
  );

ALTER TABLE customers
  ADD CONSTRAINT customers_no_self_merge_chk CHECK (
    merged_into_id IS NULL OR merged_into_id <> id
  );

CREATE INDEX IF NOT EXISTS customers_org_merged_idx
  ON customers (org_id, merged_into_id)
  WHERE merged_into_id IS NOT NULL;
