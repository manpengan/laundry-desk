-- ADR-85. External providers confirm money; the existing ledgers own balances.
CREATE TABLE public.payment_channel_settings (
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN ('wechat','alipay')),
  version integer NOT NULL CHECK (version > 0),
  enabled boolean NOT NULL DEFAULT false,
  app_id text NOT NULL CHECK (length(app_id) BETWEEN 16 AND 32),
  merchant_id text NOT NULL CHECK (merchant_id ~ '^[0-9]{6,32}$'),
  account_fingerprint char(64) NOT NULL CHECK (account_fingerprint ~ '^[0-9a-f]{64}$'),
  credential_id uuid NOT NULL,
  envelope_json jsonb NOT NULL CHECK (jsonb_typeof(envelope_json) = 'object'),
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (org_id,store_id,channel),
  FOREIGN KEY (org_id,store_id) REFERENCES public.stores(org_id,id),
  FOREIGN KEY (org_id,updated_by) REFERENCES public.staffs(org_id,id)
);
CREATE INDEX payment_channel_settings_actor_idx ON public.payment_channel_settings(org_id,updated_by);

CREATE TABLE public.payment_channel_intents (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN ('wechat','alipay')),
  purpose text NOT NULL CHECK (purpose IN ('order','topup')),
  order_id uuid,
  account_id uuid,
  customer_id uuid,
  actor_id uuid NOT NULL,
  customer_session_id uuid,
  idempotency_key uuid NOT NULL,
  input_sha256 char(64) NOT NULL CHECK (input_sha256 ~ '^[0-9a-f]{64}$'),
  account_fingerprint char(64) NOT NULL CHECK (account_fingerprint ~ '^[0-9a-f]{64}$'),
  merchant_order text NOT NULL CHECK (merchant_order ~ '^[A-Za-z0-9_]{1,32}$'),
  amount_cents integer NOT NULL CHECK (amount_cents BETWEEN 1 AND 5000000),
  bonus_cents integer NOT NULL DEFAULT 0 CHECK (bonus_cents BETWEEN 0 AND 5000000),
  bonus_rule_id uuid,
  state text NOT NULL DEFAULT 'created' CHECK (state IN ('created','pending','unknown','paid','closed','needs_review')),
  checkout_json jsonb CHECK (checkout_json IS NULL OR jsonb_typeof(checkout_json) = 'object'),
  provider_order text CHECK (provider_order ~ '^[A-Za-z0-9_-]{1,128}$'),
  payment_id uuid,
  member_ledger_id uuid,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at timestamptz NOT NULL,
  dispatched_at timestamptz,
  checked_at timestamptz,
  paid_at timestamptz,
  error_code text CHECK (error_code ~ '^[A-Z_]{1,64}$'),
  UNIQUE (org_id,store_id,id),
  UNIQUE (org_id,store_id,idempotency_key),
  UNIQUE (org_id,store_id,channel,merchant_order),
  UNIQUE (org_id,store_id,payment_id),
  UNIQUE (org_id,store_id,member_ledger_id),
  FOREIGN KEY (org_id,store_id) REFERENCES public.stores(org_id,id),
  FOREIGN KEY (org_id,actor_id) REFERENCES public.staffs(org_id,id),
  FOREIGN KEY (org_id,customer_id) REFERENCES public.customers(org_id,id),
  FOREIGN KEY (org_id,store_id,order_id) REFERENCES public.orders(org_id,store_id,id),
  FOREIGN KEY (org_id,account_id) REFERENCES public.member_accounts(org_id,id),
  FOREIGN KEY (org_id,store_id,payment_id) REFERENCES public.payments(org_id,store_id,id),
  FOREIGN KEY (org_id,member_ledger_id) REFERENCES public.member_ledger(org_id,id),
  CHECK ((purpose='order' AND order_id IS NOT NULL AND account_id IS NULL AND bonus_cents=0 AND bonus_rule_id IS NULL AND member_ledger_id IS NULL)
    OR (purpose='topup' AND order_id IS NULL AND account_id IS NOT NULL AND customer_id IS NOT NULL AND payment_id IS NULL)),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '16 minutes'),
  CHECK (state <> 'paid' OR (provider_order IS NOT NULL AND paid_at IS NOT NULL AND
    ((purpose='order' AND payment_id IS NOT NULL) OR (purpose='topup' AND member_ledger_id IS NOT NULL))))
);
CREATE UNIQUE INDEX payment_channel_intents_open_order_idx
  ON public.payment_channel_intents(org_id,store_id,order_id)
  WHERE purpose='order' AND state IN ('created','pending','unknown','needs_review');
CREATE UNIQUE INDEX payment_channel_intents_open_topup_idx
  ON public.payment_channel_intents(org_id,account_id)
  WHERE purpose='topup' AND state IN ('created','pending','unknown','needs_review');
CREATE UNIQUE INDEX payment_channel_intents_provider_idx
  ON public.payment_channel_intents(org_id,store_id,channel,provider_order) WHERE provider_order IS NOT NULL;
CREATE INDEX payment_channel_intents_actor_idx ON public.payment_channel_intents(org_id,actor_id);
CREATE INDEX payment_channel_intents_customer_idx ON public.payment_channel_intents(org_id,customer_id);
CREATE INDEX payment_channel_intents_account_idx ON public.payment_channel_intents(org_id,account_id);
CREATE INDEX payment_channel_intents_pending_idx ON public.payment_channel_intents(org_id,store_id,checked_at,id)
  WHERE state IN ('created','pending','unknown','needs_review');

CREATE TABLE public.payment_channel_refunds (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  intent_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  idempotency_key uuid NOT NULL,
  merchant_refund text NOT NULL CHECK (merchant_refund ~ '^[A-Za-z0-9_]{1,32}$'),
  amount_cents integer NOT NULL CHECK (amount_cents BETWEEN 1 AND 5000000),
  reason text NOT NULL CHECK (reason IN ('customer_request','duplicate_payment','service_cancelled','other')),
  state text NOT NULL DEFAULT 'created' CHECK (state IN ('created','pending','unknown','refunded','failed','needs_review')),
  provider_refund text CHECK (provider_refund ~ '^[A-Za-z0-9_-]{1,193}$'),
  payment_id uuid,
  member_ledger_id uuid,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  dispatched_at timestamptz,
  checked_at timestamptz,
  error_code text CHECK (error_code ~ '^[A-Z_]{1,64}$'),
  UNIQUE (org_id,store_id,id),
  UNIQUE (org_id,store_id,idempotency_key),
  UNIQUE (org_id,store_id,merchant_refund),
  UNIQUE (org_id,store_id,payment_id),
  FOREIGN KEY (org_id,store_id) REFERENCES public.stores(org_id,id),
  FOREIGN KEY (org_id,store_id,intent_id) REFERENCES public.payment_channel_intents(org_id,store_id,id),
  FOREIGN KEY (org_id,actor_id) REFERENCES public.staffs(org_id,id),
  FOREIGN KEY (org_id,store_id,payment_id) REFERENCES public.payments(org_id,store_id,id),
  FOREIGN KEY (org_id,member_ledger_id) REFERENCES public.member_ledger(org_id,id),
  UNIQUE (org_id,member_ledger_id),
  CHECK (state <> 'refunded' OR (provider_refund IS NOT NULL AND ((payment_id IS NOT NULL)::int + (member_ledger_id IS NOT NULL)::int)=1))
);
CREATE INDEX payment_channel_refunds_intent_idx ON public.payment_channel_refunds(org_id,store_id,intent_id);
CREATE INDEX payment_channel_refunds_actor_idx ON public.payment_channel_refunds(org_id,actor_id);
CREATE INDEX payment_channel_refunds_pending_idx ON public.payment_channel_refunds(org_id,store_id,checked_at,id)
  WHERE state IN ('created','pending','unknown','needs_review');

CREATE TABLE public.payment_channel_reconciliations (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN ('wechat','alipay')),
  business_date date NOT NULL,
  actor_id uuid NOT NULL,
  source_sha256 char(64) NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  matched_count integer NOT NULL CHECK (matched_count >= 0),
  mismatches_json jsonb NOT NULL CHECK (jsonb_typeof(mismatches_json)='array' AND jsonb_array_length(mismatches_json) <= 10000),
  at timestamptz NOT NULL DEFAULT statement_timestamp(),
  FOREIGN KEY (org_id,store_id) REFERENCES public.stores(org_id,id),
  FOREIGN KEY (org_id,actor_id) REFERENCES public.staffs(org_id,id)
);
CREATE INDEX payment_channel_reconciliations_store_date_idx ON public.payment_channel_reconciliations(org_id,store_id,business_date DESC,id);
CREATE INDEX payment_channel_reconciliations_actor_idx ON public.payment_channel_reconciliations(org_id,actor_id);

CREATE FUNCTION public.guard_channel_intent_identity() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog,public AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['state','checkout_json','provider_order','payment_id','member_ledger_id','dispatched_at','checked_at','paid_at','error_code'])
    IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['state','checkout_json','provider_order','payment_id','member_ledger_id','dispatched_at','checked_at','paid_at','error_code']) THEN
    RAISE check_violation USING MESSAGE='CHANNEL_INTENT_IDENTITY_IMMUTABLE';
  END IF;
  IF OLD.state IN ('paid','closed') AND NEW IS DISTINCT FROM OLD THEN
    RAISE check_violation USING MESSAGE='CHANNEL_INTENT_TERMINAL';
  END IF;
  IF OLD.dispatched_at IS NOT NULL AND NEW.dispatched_at IS DISTINCT FROM OLD.dispatched_at THEN
    RAISE check_violation USING MESSAGE='CHANNEL_DISPATCH_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payment_channel_intents_identity_trg BEFORE UPDATE ON public.payment_channel_intents
  FOR EACH ROW EXECUTE FUNCTION public.guard_channel_intent_identity();
CREATE FUNCTION public.guard_channel_refund_identity() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog,public AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['state','provider_refund','payment_id','member_ledger_id','dispatched_at','checked_at','error_code'])
    IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['state','provider_refund','payment_id','member_ledger_id','dispatched_at','checked_at','error_code']) THEN
    RAISE check_violation USING MESSAGE='CHANNEL_REFUND_IDENTITY_IMMUTABLE';
  END IF;
  IF OLD.state IN ('refunded','failed') AND NEW IS DISTINCT FROM OLD THEN RAISE check_violation USING MESSAGE='CHANNEL_REFUND_TERMINAL'; END IF;
  IF OLD.dispatched_at IS NOT NULL AND NEW.dispatched_at IS DISTINCT FROM OLD.dispatched_at THEN
    RAISE check_violation USING MESSAGE='CHANNEL_DISPATCH_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payment_channel_refunds_identity_trg BEFORE UPDATE ON public.payment_channel_refunds
  FOR EACH ROW EXECUTE FUNCTION public.guard_channel_refund_identity();

-- Manual payments, cancellation and repricing cannot race an outstanding QR code.
CREATE FUNCTION public.guard_order_channel_reservation() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog,public AS $$
BEGIN
  IF (NEW.payable_cents,NEW.paid_cents,NEW.customer_id,NEW.status)
    IS DISTINCT FROM (OLD.payable_cents,OLD.paid_cents,OLD.customer_id,OLD.status)
    AND EXISTS(SELECT 1 FROM public.payment_channel_intents i WHERE i.org_id=OLD.org_id
      AND i.store_id=OLD.store_id AND i.order_id=OLD.id AND i.state IN ('created','pending','unknown','needs_review')
      AND NOT(i.state='needs_review' AND i.provider_order IS NOT NULL AND i.paid_at IS NOT NULL
        AND i.id::text=COALESCE(current_setting('app.channel_settlement_id',true),''))) THEN
    RAISE check_violation USING MESSAGE='CHANNEL_PAYMENT_PENDING';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER orders_channel_reservation_trg BEFORE UPDATE ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.guard_order_channel_reservation();

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['payment_channel_settings','payment_channel_intents','payment_channel_refunds','payment_channel_reconciliations'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO laundry_owner USING (true) WITH CHECK (true)',table_name||'_owner',table_name);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO laundry_app USING (org_id=NULLIF(current_setting(''app.org_id'',true),'''')::uuid AND store_id=NULLIF(current_setting(''app.store_id'',true),'''')::uuid) WITH CHECK (org_id=NULLIF(current_setting(''app.org_id'',true),'''')::uuid AND store_id=NULLIF(current_setting(''app.store_id'',true),'''')::uuid)',table_name||'_tenant',table_name);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,laundry_app',table_name);
    EXECUTE format('GRANT SELECT,INSERT ON public.%I TO laundry_app',table_name);
  END LOOP;
END $$;
GRANT UPDATE ON public.payment_channel_settings,public.payment_channel_intents,public.payment_channel_refunds TO laundry_app;
REVOKE ALL ON FUNCTION public.guard_channel_intent_identity(),public.guard_channel_refund_identity(),public.guard_order_channel_reservation() FROM PUBLIC;

-- The ordinary/manual refund command cannot impersonate a provider refund.
CREATE FUNCTION public.guard_channel_refund_ledger() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.kind='refund' AND EXISTS(SELECT 1 FROM public.payment_channel_intents i
  WHERE i.org_id=NEW.org_id AND i.store_id=NEW.store_id AND i.payment_id=NEW.ref_payment_id)
  AND NOT EXISTS(SELECT 1 FROM public.payment_channel_refunds r JOIN public.payment_channel_intents i
   ON i.org_id=r.org_id AND i.store_id=r.store_id AND i.id=r.intent_id
   WHERE r.org_id=NEW.org_id AND r.store_id=NEW.store_id AND i.payment_id=NEW.ref_payment_id
    AND r.id::text=COALESCE(current_setting('app.channel_refund_id',true),'')
    AND r.state='needs_review' AND r.provider_refund IS NOT NULL AND r.amount_cents=NEW.amount_cents) THEN
  RAISE check_violation USING MESSAGE='CHANNEL_REFUND_REQUIRED';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER payments_channel_refund_trg BEFORE INSERT ON public.payments
 FOR EACH ROW EXECUTE FUNCTION public.guard_channel_refund_ledger();
REVOKE ALL ON FUNCTION public.guard_channel_refund_ledger() FROM PUBLIC;

GRANT SELECT ("id","org_id","store_id","channel","purpose","order_id","account_id","customer_id","actor_id","account_fingerprint","merchant_order","amount_cents","bonus_cents","bonus_rule_id","state","provider_order","payment_id","member_ledger_id","created_at","expires_at","dispatched_at","checked_at","paid_at","error_code") ON public.payment_channel_intents TO laundry_store_exporter;
CREATE POLICY payment_channel_intents_export_reader ON public.payment_channel_intents FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid);

GRANT SELECT ("id","org_id","store_id","channel","business_date","actor_id","source_sha256","matched_count","mismatches_json","at") ON public.payment_channel_reconciliations TO laundry_store_exporter;
CREATE POLICY payment_channel_reconciliations_export_reader ON public.payment_channel_reconciliations FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid);

GRANT SELECT ("id","org_id","store_id","intent_id","actor_id","merchant_refund","amount_cents","reason","state","provider_refund","payment_id","member_ledger_id","created_at","dispatched_at","checked_at","error_code") ON public.payment_channel_refunds TO laundry_store_exporter;
CREATE POLICY payment_channel_refunds_export_reader ON public.payment_channel_refunds FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid);

GRANT SELECT ("org_id","store_id","channel","version","enabled","app_id","merchant_id","account_fingerprint","updated_by","updated_at") ON public.payment_channel_settings TO laundry_store_exporter;
CREATE POLICY payment_channel_settings_export_reader ON public.payment_channel_settings FOR SELECT TO laundry_store_exporter USING (org_id=NULLIF(current_setting('app.org_id',true),'')::uuid AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid);

-- Reserve unspent principal while provider refunds are in flight. Manual refunds
-- cannot turn online top-ups into an unaudited cash withdrawal.
CREATE FUNCTION public.guard_channel_member_ledger() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
DECLARE reserved bigint; balance bigint;
BEGIN
 IF NEW.org_id IS DISTINCT FROM NULLIF(current_setting('app.org_id',true),'')::uuid
  AND NOT pg_has_role(session_user,'laundry_owner','MEMBER') THEN
  RAISE insufficient_privilege USING MESSAGE='CHANNEL_TENANT_REQUIRED';
 END IF;
 IF NEW.principal_delta_cents>=0 THEN RETURN NEW; END IF;
 PERFORM 1 FROM public.member_accounts WHERE org_id=NEW.org_id AND id=NEW.account_id FOR UPDATE;
 IF NEW.kind='refund' AND EXISTS(SELECT 1 FROM public.payment_channel_intents i WHERE i.org_id=NEW.org_id
  AND i.account_id=NEW.account_id AND i.state='paid' AND i.amount_cents>COALESCE((SELECT sum(r.amount_cents)
   FROM public.payment_channel_refunds r WHERE r.org_id=i.org_id AND r.store_id=i.store_id AND r.intent_id=i.id AND r.state='refunded'),0))
  AND NOT EXISTS(SELECT 1 FROM public.payment_channel_refunds r JOIN public.payment_channel_intents i
   ON i.org_id=r.org_id AND i.store_id=r.store_id AND i.id=r.intent_id
   WHERE i.org_id=NEW.org_id AND i.account_id=NEW.account_id AND r.state='needs_review'
    AND r.provider_refund IS NOT NULL AND r.amount_cents=-NEW.principal_delta_cents
    AND r.id::text=COALESCE(current_setting('app.channel_refund_id',true),'')) THEN
  RAISE check_violation USING MESSAGE='CHANNEL_REFUND_REQUIRED';
 END IF;
 SELECT COALESCE(sum(r.amount_cents),0) INTO reserved FROM public.payment_channel_refunds r
 JOIN public.payment_channel_intents i ON i.org_id=r.org_id AND i.store_id=r.store_id AND i.id=r.intent_id
 WHERE i.org_id=NEW.org_id AND i.account_id=NEW.account_id AND r.state NOT IN ('refunded','failed')
  AND NOT(NEW.kind='refund' AND r.state='needs_review' AND r.provider_refund IS NOT NULL
   AND r.amount_cents=-NEW.principal_delta_cents AND r.id::text=COALESCE(current_setting('app.channel_refund_id',true),''));
 SELECT COALESCE(sum(principal_delta_cents),0) INTO balance FROM public.member_ledger
 WHERE org_id=NEW.org_id AND account_id=NEW.account_id;
 IF balance+NEW.principal_delta_cents<reserved THEN RAISE check_violation USING MESSAGE='CHANNEL_REFUND_PENDING'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER member_ledger_channel_refund_trg BEFORE INSERT ON public.member_ledger
 FOR EACH ROW EXECUTE FUNCTION public.guard_channel_member_ledger();
REVOKE ALL ON FUNCTION public.guard_channel_member_ledger() FROM PUBLIC;

CREATE FUNCTION public.guard_channel_topup_refund_reservation() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
DECLARE account uuid; reserved bigint; balance bigint;
BEGIN
 IF NEW.org_id IS DISTINCT FROM NULLIF(current_setting('app.org_id',true),'')::uuid
  AND NOT pg_has_role(session_user,'laundry_owner','MEMBER') THEN
  RAISE insufficient_privilege USING MESSAGE='CHANNEL_TENANT_REQUIRED';
 END IF;
 IF NEW.state IN ('refunded','failed') THEN RETURN NEW; END IF;
 SELECT account_id INTO account FROM public.payment_channel_intents
 WHERE org_id=NEW.org_id AND store_id=NEW.store_id AND id=NEW.intent_id AND purpose='topup';
 IF account IS NULL THEN RETURN NEW; END IF;
 PERFORM 1 FROM public.member_accounts WHERE org_id=NEW.org_id AND id=account FOR UPDATE;
 SELECT COALESCE(sum(principal_delta_cents),0) INTO balance FROM public.member_ledger WHERE org_id=NEW.org_id AND account_id=account;
 SELECT COALESCE(sum(r.amount_cents),0) INTO reserved FROM public.payment_channel_refunds r
 JOIN public.payment_channel_intents i ON i.org_id=r.org_id AND i.store_id=r.store_id AND i.id=r.intent_id
 WHERE i.org_id=NEW.org_id AND i.account_id=account AND r.state NOT IN ('refunded','failed');
 IF NEW.amount_cents>balance-reserved THEN RAISE check_violation USING MESSAGE='CHANNEL_REFUND_PENDING'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER payment_channel_refunds_principal_trg BEFORE INSERT ON public.payment_channel_refunds
 FOR EACH ROW EXECUTE FUNCTION public.guard_channel_topup_refund_reservation();
ALTER FUNCTION public.guard_channel_member_ledger() OWNER TO laundry_owner;
ALTER FUNCTION public.guard_channel_topup_refund_reservation() OWNER TO laundry_owner;
REVOKE ALL ON FUNCTION public.guard_channel_topup_refund_reservation() FROM PUBLIC;
