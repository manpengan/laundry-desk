-- ADR-95: legacy rows remain null; names are captured from the server catalog on receipt.
ALTER TABLE public.order_lines ADD COLUMN catalog_name text
  CHECK(catalog_name IS NULL OR length(btrim(catalog_name)) BETWEEN 1 AND 128);
ALTER TABLE public.order_lines ADD COLUMN catalog_code text
  CHECK(catalog_code IS NULL OR catalog_code ~ '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$');
GRANT SELECT(catalog_name,catalog_code) ON public.order_lines TO laundry_store_exporter;
