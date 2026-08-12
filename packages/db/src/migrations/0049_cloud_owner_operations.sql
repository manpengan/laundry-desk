-- ADR-40 Cloud Owner operations: optimistic store profile versions.
-- Expand-only: 0048 code ignores the new column and existing INSERT statements
-- keep working through the default. Existing UPDATE statements are versioned by
-- the trigger without changing their accepted inputs.

ALTER TABLE public.stores
  ADD COLUMN IF NOT EXISTS profile_version integer NOT NULL DEFAULT 1;

ALTER TABLE public.stores
  ADD CONSTRAINT stores_profile_version_chk CHECK (profile_version >= 1);

CREATE OR REPLACE FUNCTION public.stores_bump_profile_version()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  NEW.profile_version := OLD.profile_version;
  IF ROW(NEW.code, NEW.name, NEW.timezone)
     IS DISTINCT FROM ROW(OLD.code, OLD.name, OLD.timezone) THEN
    NEW.profile_version := OLD.profile_version + 1;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.stores_bump_profile_version() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.stores_bump_profile_version() TO laundry_app;

DROP TRIGGER IF EXISTS stores_bump_profile_version_trg ON public.stores;
CREATE TRIGGER stores_bump_profile_version_trg
BEFORE UPDATE ON public.stores
FOR EACH ROW EXECUTE FUNCTION public.stores_bump_profile_version();
