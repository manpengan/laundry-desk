-- Mock print worker lease state (product design §7, slice 5 batch 1).
--
-- Expand-only. A worker claims a job atomically with SKIP LOCKED and holds a
-- time-boxed lease; if it dies mid-print the lease expires and another worker
-- re-claims the same row. Jobs never return to 'queued' (the status machine
-- forbids it), so an expired lease is re-claimed in place as 'printing' with a
-- fresh lease and an incremented attempt_count.

ALTER TABLE print_jobs
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS lease_until timestamptz,
  ADD COLUMN IF NOT EXISTS worker_id text;

ALTER TABLE print_jobs ADD CONSTRAINT print_jobs_attempt_count_chk
  CHECK (attempt_count >= 0);

-- A worker id is only meaningful while a lease is held, and a lease is only
-- meaningful once claimed. Keep the three consistent so a partially written
-- claim can never look like a valid one.
ALTER TABLE print_jobs ADD CONSTRAINT print_jobs_lease_shape_chk
  CHECK (
    (claimed_at IS NULL AND lease_until IS NULL AND worker_id IS NULL)
    OR (claimed_at IS NOT NULL AND lease_until IS NOT NULL AND worker_id IS NOT NULL)
  );

ALTER TABLE print_jobs ADD CONSTRAINT print_jobs_worker_id_chk
  CHECK (worker_id IS NULL OR (length(worker_id) BETWEEN 1 AND 64));

-- Claim scan: pending work ordered oldest first within a store.
CREATE INDEX IF NOT EXISTS print_jobs_store_claimable_idx
  ON print_jobs (org_id, store_id, status, lease_until, created_at);
