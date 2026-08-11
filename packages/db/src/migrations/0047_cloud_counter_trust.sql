-- ADR-38 Cloud counter trust closure.
--
-- Expand-only compatibility: 0046 code ignores the new table and columns; all
-- added columns have defaults compatible with its existing INSERT statements.

CREATE TABLE IF NOT EXISTS public.store_pricing_policies (
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  urgent_cents integer NOT NULL DEFAULT 0,
  freight_cents integer NOT NULL DEFAULT 0,
  addons_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL,
  updated_by_staff_id uuid NOT NULL,
  CONSTRAINT store_pricing_policies_pkey PRIMARY KEY (org_id, store_id),
  CONSTRAINT store_pricing_policies_store_fk
    FOREIGN KEY (org_id, store_id) REFERENCES public.stores (org_id, id),
  CONSTRAINT store_pricing_policies_staff_fk
    FOREIGN KEY (org_id, updated_by_staff_id) REFERENCES public.staffs (org_id, id),
  CONSTRAINT store_pricing_policies_urgent_cents_chk CHECK (urgent_cents >= 0),
  CONSTRAINT store_pricing_policies_freight_cents_chk CHECK (freight_cents >= 0),
  CONSTRAINT store_pricing_policies_addons_json_chk CHECK (jsonb_typeof(addons_json) = 'array'),
  CONSTRAINT store_pricing_policies_version_chk CHECK (version >= 1)
);

ALTER TABLE public.store_pricing_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_pricing_policies FORCE ROW LEVEL SECURITY;

CREATE POLICY store_pricing_policies_store_scope ON public.store_pricing_policies
  AS PERMISSIVE FOR ALL TO laundry_app
  USING (
    org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid
  );

CREATE POLICY store_pricing_policies_maintenance ON public.store_pricing_policies
  AS PERMISSIVE FOR ALL TO laundry_owner USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE ON TABLE public.store_pricing_policies TO laundry_app;

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS pricing_policy_version integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS urgent_selected boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS freight_selected boolean NOT NULL DEFAULT false;

ALTER TABLE public.orders
  ADD CONSTRAINT orders_pricing_policy_version_chk CHECK (pricing_policy_version >= 0);

ALTER TABLE public.order_lines
  ADD COLUMN IF NOT EXISTS garment_details_json jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Existing rows become resumable without inventing new attributes. This also
-- preserves one detail object per piece for old drafts already in the database.
UPDATE public.order_lines AS line
SET garment_details_json = (
  SELECT jsonb_agg(
    jsonb_build_object(
      'color', line.color,
      'brand', line.brand,
      'defects', '[]'::jsonb,
      'accessories', '[]'::jsonb,
      'note', NULL,
      'addons', '[]'::jsonb
    ) ORDER BY piece.seq
  ) AS value
  FROM generate_series(1, line.qty) AS piece(seq)
)
WHERE line.garment_details_json = '[]'::jsonb;

ALTER TABLE public.order_lines
  ADD CONSTRAINT order_lines_garment_details_json_chk
  CHECK (jsonb_typeof(garment_details_json) = 'array');

ALTER TABLE public.garments
  ADD COLUMN IF NOT EXISTS defects jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS accessories jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS note text;

ALTER TABLE public.garments
  ADD CONSTRAINT garments_defects_json_chk CHECK (jsonb_typeof(defects) = 'array'),
  ADD CONSTRAINT garments_accessories_json_chk CHECK (jsonb_typeof(accessories) = 'array'),
  ADD CONSTRAINT garments_note_chk CHECK (note IS NULL OR char_length(note) <= 256);
