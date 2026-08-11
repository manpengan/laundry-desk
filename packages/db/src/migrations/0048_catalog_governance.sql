-- ADR-39 catalog governance: optimistic row versions for safe update/reorder.
-- Expand-only: 0047 code ignores version and keeps working because the column
-- has a default; its existing updates are versioned by the trigger.

ALTER TABLE public.catalog_items
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;

ALTER TABLE public.catalog_items
  ADD CONSTRAINT catalog_items_version_chk CHECK (version >= 1);

-- Catalog codes are historical business identifiers. ADR-39 permits only
-- soft retirement, so close the physical-delete privilege inherited from
-- 0008 before the governance API becomes active.
REVOKE DELETE, TRUNCATE ON TABLE public.catalog_items FROM laundry_app;

CREATE OR REPLACE FUNCTION public.catalog_items_bump_version()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  NEW.version := OLD.version;
  IF ROW(
    NEW.name,
    NEW.service_code,
    NEW.category_code,
    NEW.unit_price_cents,
    NEW.mnemonic,
    NEW.is_active,
    NEW.sort_order
  ) IS DISTINCT FROM ROW(
    OLD.name,
    OLD.service_code,
    OLD.category_code,
    OLD.unit_price_cents,
    OLD.mnemonic,
    OLD.is_active,
    OLD.sort_order
  ) THEN
    NEW.version := OLD.version + 1;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.catalog_items_bump_version() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.catalog_items_bump_version() TO laundry_app;

DROP TRIGGER IF EXISTS catalog_items_bump_version_trg ON public.catalog_items;
CREATE TRIGGER catalog_items_bump_version_trg
BEFORE UPDATE ON public.catalog_items
FOR EACH ROW EXECUTE FUNCTION public.catalog_items_bump_version();
