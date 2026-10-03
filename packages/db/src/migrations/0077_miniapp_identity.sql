-- ADR-86/87: WeChat identity is verified by the server; DB rows never mint a bearer.
CREATE TABLE public.miniapp_settings (
  org_id uuid NOT NULL REFERENCES orgs(id),
  store_id uuid NOT NULL,
  version integer NOT NULL CHECK(version > 0),
  enabled boolean NOT NULL DEFAULT false,
  transactions_enabled boolean NOT NULL DEFAULT false,
  delegated_staff_id uuid,
  app_id text NOT NULL CHECK(app_id ~ '^wx[A-Za-z0-9]{16}$'),
  credential_id uuid NOT NULL,
  envelope_json jsonb NOT NULL CHECK(jsonb_typeof(envelope_json)='object'),
  subscription_template_ids jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(subscription_template_ids)='array' AND jsonb_array_length(subscription_template_ids)<=3),
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY(org_id,store_id),
  FOREIGN KEY(org_id,store_id) REFERENCES stores(org_id,id),
  FOREIGN KEY(org_id,delegated_staff_id) REFERENCES staffs(org_id,id),
  FOREIGN KEY(org_id,updated_by) REFERENCES staffs(org_id,id),
  CHECK(NOT transactions_enabled OR (enabled AND delegated_staff_id IS NOT NULL))
);
CREATE TABLE public.miniapp_bindings (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  app_id text NOT NULL,
  openid_sha256 text NOT NULL CHECK(openid_sha256 ~ '^[a-f0-9]{64}$'),
  encrypted_openid_json jsonb NOT NULL CHECK(jsonb_typeof(encrypted_openid_json)='object'),
  customer_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  revoked_at timestamptz,
  UNIQUE(org_id,store_id,app_id,openid_sha256),
  UNIQUE(org_id,store_id,id),
  FOREIGN KEY(org_id,store_id) REFERENCES stores(org_id,id),
  FOREIGN KEY(org_id,customer_id) REFERENCES customers(org_id,id),
  CHECK((status='active')=(revoked_at IS NULL))
);
CREATE TABLE public.miniapp_sessions (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  binding_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  config_version integer NOT NULL CHECK(config_version>0),
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  UNIQUE(org_id,store_id,id),
  FOREIGN KEY(org_id,store_id,binding_id) REFERENCES miniapp_bindings(org_id,store_id,id),
  FOREIGN KEY(org_id,customer_id) REFERENCES customers(org_id,id),
  CHECK(expires_at>created_at AND expires_at<=created_at+interval '15 minutes'),
  CHECK((status='active')=(revoked_at IS NULL))
);
CREATE TABLE public.miniapp_subscriptions (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  session_id uuid NOT NULL,
  template_id text NOT NULL CHECK(template_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  accepted_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  FOREIGN KEY(org_id,store_id,session_id) REFERENCES miniapp_sessions(org_id,store_id,id),
  FOREIGN KEY(org_id,customer_id) REFERENCES customers(org_id,id)
);
DO $$ DECLARE name text; BEGIN
  FOREACH name IN ARRAY ARRAY['miniapp_settings','miniapp_bindings','miniapp_sessions','miniapp_subscriptions'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',name);
    EXECUTE format('CREATE POLICY tenant_scope ON public.%I USING (org_id=NULLIF(current_setting(''app.org_id'',true),'''')::uuid AND store_id=NULLIF(current_setting(''app.store_id'',true),'''')::uuid) WITH CHECK (org_id=NULLIF(current_setting(''app.org_id'',true),'''')::uuid AND store_id=NULLIF(current_setting(''app.store_id'',true),'''')::uuid)',name);
    EXECUTE format('GRANT SELECT,INSERT ON public.%I TO laundry_app',name);
  END LOOP;
END $$;
GRANT UPDATE ON public.miniapp_settings TO laundry_app;
GRANT UPDATE(status,revoked_at) ON public.miniapp_bindings,public.miniapp_sessions TO laundry_app;
CREATE INDEX miniapp_bindings_customer_idx ON public.miniapp_bindings(org_id,customer_id);
CREATE INDEX miniapp_sessions_customer_idx ON public.miniapp_sessions(org_id,store_id,customer_id);
CREATE INDEX miniapp_sessions_expiry_idx ON public.miniapp_sessions(expires_at) WHERE status='active';
CREATE INDEX miniapp_subscriptions_customer_idx ON public.miniapp_subscriptions(org_id,store_id,customer_id);
CREATE FUNCTION public.miniapp_terminal_revocation() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,public AS $$ BEGIN
  IF OLD.status='revoked' AND (NEW.status IS DISTINCT FROM OLD.status OR NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
    RAISE insufficient_privilege USING MESSAGE='MINIAPP_REVOKED_TERMINAL';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.miniapp_terminal_revocation() FROM PUBLIC;
CREATE TRIGGER miniapp_bindings_terminal BEFORE UPDATE ON public.miniapp_bindings FOR EACH ROW EXECUTE FUNCTION public.miniapp_terminal_revocation();
CREATE TRIGGER miniapp_sessions_terminal BEFORE UPDATE ON public.miniapp_sessions FOR EACH ROW EXECUTE FUNCTION public.miniapp_terminal_revocation();
