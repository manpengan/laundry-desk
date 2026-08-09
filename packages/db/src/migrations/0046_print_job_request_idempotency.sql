-- Database-authoritative idempotency for signed print job creation.
--
-- Historical databases may already contain more than one formal root for an
-- order/kind or more than one child for a source job. The migration must not
-- choose one of those physical-print records as authoritative: singleton
-- groups are backfilled, while ambiguous groups remain NULL and are rejected
-- by the insert guard until an operator resolves them explicitly.

ALTER TABLE public.print_jobs
  ADD COLUMN IF NOT EXISTS idempotency_key text;

WITH root_candidates AS (
  SELECT id,
         count(*) OVER (
           PARTITION BY org_id, store_id, order_id, kind
         ) AS logical_count
    FROM public.print_jobs
   WHERE snapshot_sha256 IS NOT NULL
     AND source_job_id IS NULL
)
UPDATE public.print_jobs AS job
   SET idempotency_key = 'root:' || job.order_id::text || ':' || job.kind
  FROM root_candidates AS candidate
 WHERE candidate.id = job.id
   AND candidate.logical_count = 1
   AND job.idempotency_key IS NULL;

WITH child_candidates AS (
  SELECT id,
         count(*) OVER (
           PARTITION BY org_id, store_id, source_job_id
         ) AS logical_count
    FROM public.print_jobs
   WHERE snapshot_sha256 IS NOT NULL
     AND source_job_id IS NOT NULL
)
UPDATE public.print_jobs AS job
   SET idempotency_key = 'child:' || job.source_job_id::text
  FROM child_candidates AS candidate
 WHERE candidate.id = job.id
   AND candidate.logical_count = 1
   AND job.idempotency_key IS NULL;

ALTER TABLE public.print_jobs
  ADD CONSTRAINT print_jobs_idempotency_key_shape_chk CHECK (
    (
      snapshot_sha256 IS NULL
      AND idempotency_key IS NULL
    )
    OR (
      snapshot_sha256 IS NOT NULL
      AND (
        idempotency_key IS NULL
        OR idempotency_key = CASE
          WHEN source_job_id IS NULL
            THEN 'root:' || order_id::text || ':' || kind
          ELSE 'child:' || source_job_id::text
        END
      )
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS print_jobs_idempotency_key_uidx
  ON public.print_jobs (org_id, store_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE OR REPLACE FUNCTION guard_print_job_idempotency()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  expected_key text;
  legacy_conflict boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key THEN
      RAISE EXCEPTION 'print job idempotency key is immutable'
        USING ERRCODE = '23514';
    END IF;
    IF OLD.idempotency_key IS NOT NULL AND (
      NEW.order_id IS DISTINCT FROM OLD.order_id
      OR NEW.kind IS DISTINCT FROM OLD.kind
      OR NEW.source_job_id IS DISTINCT FROM OLD.source_job_id
      OR NEW.snapshot_sha256 IS DISTINCT FROM OLD.snapshot_sha256
    ) THEN
      RAISE EXCEPTION 'print job idempotency binding is immutable'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.snapshot_sha256 IS NULL THEN
    IF NEW.idempotency_key IS NOT NULL THEN
      RAISE EXCEPTION 'diagnostic print job cannot carry an idempotency key'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  expected_key := CASE
    WHEN NEW.source_job_id IS NULL
      THEN 'root:' || NEW.order_id::text || ':' || NEW.kind
    ELSE 'child:' || NEW.source_job_id::text
  END;
  IF NEW.idempotency_key IS NOT NULL AND NEW.idempotency_key <> expected_key THEN
    RAISE EXCEPTION 'print job idempotency key does not match its binding'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.source_job_id IS NULL THEN
    SELECT EXISTS (
      SELECT 1
        FROM public.print_jobs AS existing
       WHERE existing.org_id = NEW.org_id
         AND existing.store_id = NEW.store_id
         AND existing.order_id = NEW.order_id
         AND existing.kind = NEW.kind
         AND existing.source_job_id IS NULL
         AND existing.snapshot_sha256 IS NOT NULL
         AND existing.idempotency_key IS NULL
    ) INTO legacy_conflict;
  ELSE
    SELECT EXISTS (
      SELECT 1
        FROM public.print_jobs AS existing
       WHERE existing.org_id = NEW.org_id
         AND existing.store_id = NEW.store_id
         AND existing.source_job_id = NEW.source_job_id
         AND existing.snapshot_sha256 IS NOT NULL
         AND existing.idempotency_key IS NULL
    ) INTO legacy_conflict;
  END IF;

  IF legacy_conflict THEN
    RAISE EXCEPTION 'print job idempotency authority is ambiguous'
      USING ERRCODE = '23514';
  END IF;
  NEW.idempotency_key := expected_key;
  RETURN NEW;
END;
$$;

CREATE TRIGGER print_jobs_idempotency_guard
BEFORE INSERT OR UPDATE ON public.print_jobs
FOR EACH ROW EXECUTE FUNCTION guard_print_job_idempotency();

REVOKE ALL ON FUNCTION guard_print_job_idempotency() FROM PUBLIC;
