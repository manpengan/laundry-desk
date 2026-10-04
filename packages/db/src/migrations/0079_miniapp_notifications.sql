-- ADR-90: one accepted subscription is consumed irreversibly by one human-confirmed dispatch.
ALTER TABLE public.miniapp_subscriptions ADD COLUMN consumed_at timestamptz,
  ADD COLUMN outbox_id uuid, ADD COLUMN revoked_at timestamptz,
  ADD CONSTRAINT miniapp_subscription_consumption CHECK((consumed_at IS NULL)=(outbox_id IS NULL));
ALTER TABLE public.miniapp_subscriptions ADD CONSTRAINT miniapp_subscription_scope UNIQUE(org_id,store_id,id);
GRANT UPDATE(consumed_at,outbox_id,revoked_at) ON public.miniapp_subscriptions TO laundry_app;
CREATE FUNCTION public.miniapp_subscription_terminal() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN
 IF (OLD.consumed_at IS NOT NULL AND (NEW.consumed_at IS DISTINCT FROM OLD.consumed_at OR NEW.outbox_id IS DISTINCT FROM OLD.outbox_id))
 OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
 RAISE insufficient_privilege USING MESSAGE='SUBSCRIPTION_CONSUMPTION_TERMINAL'; END IF; RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.miniapp_subscription_terminal() FROM PUBLIC;
CREATE TRIGGER miniapp_subscription_terminal BEFORE UPDATE ON public.miniapp_subscriptions FOR EACH ROW EXECUTE FUNCTION public.miniapp_subscription_terminal();
CREATE TABLE public.miniapp_notification_settings (
 org_id uuid NOT NULL, store_id uuid NOT NULL, version integer NOT NULL CHECK(version>0),
 enabled boolean NOT NULL DEFAULT false, template_id text NOT NULL CHECK(template_id ~ '^[A-Za-z0-9_-]{1,128}$'),
 ticket_field text NOT NULL CHECK(ticket_field ~ '^character_string[0-9]{1,3}$'),
 store_field text NOT NULL CHECK(store_field ~ '^thing[0-9]{1,3}$'), status_field text NOT NULL CHECK(status_field ~ '^phrase[0-9]{1,3}$'),
 miniprogram_state text NOT NULL CHECK(miniprogram_state IN ('developer','trial','formal')),
 updated_by uuid NOT NULL, updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 PRIMARY KEY(org_id,store_id), FOREIGN KEY(org_id,store_id) REFERENCES stores(org_id,id),
 FOREIGN KEY(org_id,updated_by) REFERENCES staffs(org_id,id)
);
CREATE TABLE public.miniapp_notification_outbox (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, store_id uuid NOT NULL, order_id uuid NOT NULL, customer_id uuid NOT NULL,
 binding_id uuid NOT NULL, consent_id uuid NOT NULL, created_by uuid NOT NULL,
 settings_version integer NOT NULL, miniapp_version integer NOT NULL, template_id text NOT NULL,
 payload_json jsonb NOT NULL CHECK(jsonb_typeof(payload_json)='object'), preview_sha256 text NOT NULL CHECK(preview_sha256 ~ '^[a-f0-9]{64}$'),
 state text NOT NULL CHECK(state IN ('queued','sending','accepted','failed','unknown','cancelled','needs_review')),
 created_at timestamptz NOT NULL DEFAULT statement_timestamp(), dispatched_at timestamptz, checked_at timestamptz, error_code text,
 UNIQUE(org_id,store_id,id), UNIQUE(org_id,store_id,consent_id),
 FOREIGN KEY(org_id,store_id,order_id) REFERENCES orders(org_id,store_id,id),
 FOREIGN KEY(org_id,customer_id) REFERENCES customers(org_id,id),
 FOREIGN KEY(org_id,store_id,binding_id) REFERENCES miniapp_bindings(org_id,store_id,id),
 FOREIGN KEY(org_id,store_id,consent_id) REFERENCES miniapp_subscriptions(org_id,store_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES staffs(org_id,id),
 CHECK(state NOT IN ('sending','accepted','unknown') OR dispatched_at IS NOT NULL)
);
ALTER TABLE public.miniapp_subscriptions ADD CONSTRAINT miniapp_subscription_outbox_fk FOREIGN KEY(org_id,store_id,outbox_id) REFERENCES miniapp_notification_outbox(org_id,store_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE FUNCTION public.miniapp_notification_terminal() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN
 IF ROW(NEW.id,NEW.org_id,NEW.store_id,NEW.order_id,NEW.customer_id,NEW.binding_id,NEW.consent_id,NEW.created_by,NEW.settings_version,NEW.miniapp_version,NEW.template_id,NEW.payload_json,NEW.preview_sha256,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.id,OLD.org_id,OLD.store_id,OLD.order_id,OLD.customer_id,OLD.binding_id,OLD.consent_id,OLD.created_by,OLD.settings_version,OLD.miniapp_version,OLD.template_id,OLD.payload_json,OLD.preview_sha256,OLD.created_at)
 OR (OLD.dispatched_at IS NOT NULL AND NEW.dispatched_at IS DISTINCT FROM OLD.dispatched_at)
 OR (OLD.state<>'queued' AND NEW.state='queued')
 OR (OLD.state IN ('accepted','failed','cancelled','needs_review') AND NEW.state IS DISTINCT FROM OLD.state)
 OR (OLD.state='unknown' AND NEW.state NOT IN ('unknown','needs_review')) THEN
 RAISE insufficient_privilege USING MESSAGE='NOTIFICATION_DISPATCH_TERMINAL'; END IF; RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.miniapp_notification_terminal() FROM PUBLIC;
CREATE TRIGGER miniapp_notification_terminal BEFORE UPDATE ON public.miniapp_notification_outbox FOR EACH ROW EXECUTE FUNCTION public.miniapp_notification_terminal();
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['miniapp_notification_settings','miniapp_notification_outbox'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',name);
 EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',name);
 EXECUTE format('CREATE POLICY tenant_scope ON public.%I USING (org_id=NULLIF(current_setting(''app.org_id'',true),'''')::uuid AND store_id=NULLIF(current_setting(''app.store_id'',true),'''')::uuid) WITH CHECK (org_id=NULLIF(current_setting(''app.org_id'',true),'''')::uuid AND store_id=NULLIF(current_setting(''app.store_id'',true),'''')::uuid)',name);
 EXECUTE format('GRANT SELECT,INSERT ON public.%I TO laundry_app',name);
 END LOOP;
END $$;
GRANT UPDATE ON public.miniapp_notification_settings TO laundry_app;
GRANT UPDATE(state,dispatched_at,checked_at,error_code) ON public.miniapp_notification_outbox TO laundry_app;
CREATE UNIQUE INDEX miniapp_notification_once_idx ON public.miniapp_notification_outbox(org_id,store_id,order_id) WHERE state IN ('queued','sending','accepted','unknown','needs_review');
CREATE INDEX miniapp_notification_order_idx ON public.miniapp_notification_outbox(org_id,store_id,order_id);
CREATE INDEX miniapp_notification_customer_idx ON public.miniapp_notification_outbox(org_id,customer_id);
CREATE INDEX miniapp_notification_actor_idx ON public.miniapp_notification_outbox(org_id,created_by);
CREATE INDEX miniapp_notification_binding_idx ON public.miniapp_notification_outbox(org_id,store_id,binding_id);
CREATE INDEX miniapp_notification_due_idx ON public.miniapp_notification_outbox(org_id,store_id,checked_at,created_at) WHERE state IN ('queued','sending');
CREATE INDEX miniapp_subscription_available_idx ON public.miniapp_subscriptions(org_id,store_id,customer_id,template_id,accepted_at) WHERE consumed_at IS NULL AND revoked_at IS NULL;
GRANT SELECT ON public.miniapp_notification_settings TO laundry_store_exporter;
GRANT SELECT(id,org_id,store_id,order_id,customer_id,created_by,settings_version,miniapp_version,template_id,payload_json,preview_sha256,state,created_at,dispatched_at,checked_at,error_code) ON public.miniapp_notification_outbox TO laundry_store_exporter;
