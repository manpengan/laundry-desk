-- ADR-77: local external SMS configuration. Only sealed credentials are persisted.
CREATE TABLE public.notification_provider_settings (
  org_id uuid NOT NULL REFERENCES public.orgs(id),
  store_id uuid NOT NULL,
  version integer NOT NULL CHECK (version BETWEEN 1 AND 1000000),
  enabled boolean NOT NULL DEFAULT false,
  provider text NOT NULL CHECK (provider = 'aliyun_sms'),
  sign_name text NOT NULL CHECK (length(sign_name) BETWEEN 2 AND 12),
  template_code text NOT NULL CHECK (template_code ~ '^SMS_[0-9]{1,32}$'),
  unit_cost_cents integer NOT NULL CHECK (unit_cost_cents BETWEEN 1 AND 1000),
  max_batch_cost_cents integer NOT NULL CHECK (max_batch_cost_cents BETWEEN 1 AND 50000),
  credential_id uuid NOT NULL,
  envelope_json jsonb NOT NULL CHECK (jsonb_typeof(envelope_json) = 'object'
    AND octet_length(envelope_json::text) BETWEEN 64 AND 48000),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_by uuid NOT NULL,
  PRIMARY KEY (org_id, store_id),
  FOREIGN KEY (org_id, store_id) REFERENCES public.stores(org_id, id),
  FOREIGN KEY (org_id, updated_by) REFERENCES public.staffs(org_id, id)
);
ALTER TABLE public.notification_provider_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_provider_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY notification_provider_settings_tenant ON public.notification_provider_settings
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid);
REVOKE ALL ON public.notification_provider_settings FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON public.notification_provider_settings TO laundry_app;
CREATE INDEX notification_provider_settings_staff_idx
  ON public.notification_provider_settings(org_id, updated_by);

-- Poll progress prevents a pending oldest recipient from starving later receipts.
ALTER TABLE public.notification_deliveries ADD COLUMN receipt_checked_at timestamptz;
