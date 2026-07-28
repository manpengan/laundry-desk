-- Mock print artifact metadata (product design §7, slice 5 batch 2).
--
-- Expand-only. A finished job records what the spool actually wrote so the
-- artifact can later be served by id and re-verified against its hash. The
-- path is a spool-relative name produced by the server; it is never a caller
-- supplied path and never absolute.

ALTER TABLE print_jobs
  ADD COLUMN IF NOT EXISTS artifact_path text,
  ADD COLUMN IF NOT EXISTS artifact_sha256 text,
  ADD COLUMN IF NOT EXISTS artifact_bytes integer,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz;

-- Artifact metadata is written as one unit; a partial row would let a reader
-- trust a size or path without a hash to verify it against.
ALTER TABLE print_jobs ADD CONSTRAINT print_jobs_artifact_shape_chk
  CHECK (
    (artifact_path IS NULL AND artifact_sha256 IS NULL AND artifact_bytes IS NULL)
    OR (artifact_path IS NOT NULL AND artifact_sha256 IS NOT NULL AND artifact_bytes IS NOT NULL)
  );

ALTER TABLE print_jobs ADD CONSTRAINT print_jobs_artifact_sha256_chk
  CHECK (artifact_sha256 IS NULL OR artifact_sha256 ~ '^[0-9a-f]{64}$');

ALTER TABLE print_jobs ADD CONSTRAINT print_jobs_artifact_bytes_chk
  CHECK (artifact_bytes IS NULL OR artifact_bytes >= 0);

-- Spool-relative name only: no absolute path, no traversal, no separator.
ALTER TABLE print_jobs ADD CONSTRAINT print_jobs_artifact_path_chk
  CHECK (artifact_path IS NULL OR artifact_path ~ '^[0-9a-f-]{36}-[a-z0-9]{1,16}-[0-9]{4}\.txt$');

CREATE UNIQUE INDEX IF NOT EXISTS print_jobs_artifact_path_uidx
  ON print_jobs (org_id, store_id, artifact_path)
  WHERE artifact_path IS NOT NULL;
