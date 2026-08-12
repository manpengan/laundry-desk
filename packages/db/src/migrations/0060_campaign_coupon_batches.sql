-- ADR-53 / Stage 4.4 Item 8. Numbers 0054-0058 remain reserved for delivery.
-- Campaign coupon issuance is bounded, append-only and linked to the existing
-- member coupon ledger. Recipient identity is not copied into batch metadata.

CREATE TABLE IF NOT EXISTS public.campaign_coupon_batches (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  campaign_id uuid NOT NULL,
  campaign_version integer NOT NULL,
  audience_snapshot_id uuid NOT NULL,
  audience_digest text NOT NULL,
  coupon_definition_id uuid NOT NULL,
  coupon_version integer NOT NULL,
  coupon_code text NOT NULL,
  coupon_name text NOT NULL,
  coupon_discount_cents integer NOT NULL,
  coupon_min_order_cents integer NOT NULL,
  coupon_valid_days integer NOT NULL,
  audience_recipient_count integer NOT NULL,
  eligible_recipient_count integer NOT NULL,
  granted_count integer NOT NULL,
  budget_committed_cents integer NOT NULL,
  reason text NOT NULL,
  created_by_staff_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT campaign_coupon_batches_tenant_id_uidx UNIQUE (org_id, store_id, id),
  CONSTRAINT campaign_coupon_batches_semantic_uidx UNIQUE (
    org_id, store_id, campaign_id, campaign_version,
    audience_snapshot_id, coupon_definition_id
  ),
  CONSTRAINT campaign_coupon_batches_campaign_fk
    FOREIGN KEY (org_id, store_id, campaign_id) REFERENCES campaigns (org_id, store_id, id),
  CONSTRAINT campaign_coupon_batches_snapshot_fk
    FOREIGN KEY (org_id, store_id, audience_snapshot_id)
    REFERENCES campaign_audience_snapshots (org_id, store_id, id),
  CONSTRAINT campaign_coupon_batches_coupon_fk
    FOREIGN KEY (org_id, coupon_definition_id) REFERENCES coupons (org_id, id),
  CONSTRAINT campaign_coupon_batches_staff_fk
    FOREIGN KEY (org_id, created_by_staff_id) REFERENCES staffs (org_id, id),
  CONSTRAINT campaign_coupon_batches_version_chk CHECK (campaign_version BETWEEN 1 AND 1000000),
  CONSTRAINT campaign_coupon_batches_coupon_version_chk CHECK (coupon_version > 0),
  CONSTRAINT campaign_coupon_batches_digest_chk CHECK (audience_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT campaign_coupon_batches_code_chk CHECK (coupon_code ~ '^[a-z][a-z0-9_-]{0,31}$'),
  CONSTRAINT campaign_coupon_batches_name_chk CHECK (char_length(btrim(coupon_name)) BETWEEN 1 AND 64),
  CONSTRAINT campaign_coupon_batches_discount_chk CHECK (coupon_discount_cents BETWEEN 1 AND 5000000),
  CONSTRAINT campaign_coupon_batches_minimum_chk CHECK (coupon_min_order_cents BETWEEN 0 AND 5000000),
  CONSTRAINT campaign_coupon_batches_days_chk CHECK (coupon_valid_days BETWEEN 1 AND 3650),
  CONSTRAINT campaign_coupon_batches_counts_chk CHECK (
    audience_recipient_count BETWEEN 1 AND 500
    AND eligible_recipient_count BETWEEN 1 AND audience_recipient_count
    AND granted_count = eligible_recipient_count
  ),
  CONSTRAINT campaign_coupon_batches_budget_chk CHECK (
    budget_committed_cents = coupon_discount_cents::bigint * granted_count
    AND budget_committed_cents BETWEEN 1 AND 5000000
  ),
  CONSTRAINT campaign_coupon_batches_reason_chk CHECK (char_length(btrim(reason)) BETWEEN 1 AND 256)
);

CREATE INDEX IF NOT EXISTS campaign_coupon_batches_campaign_created_idx
  ON public.campaign_coupon_batches (org_id, store_id, campaign_id, created_at DESC, id);

CREATE TABLE IF NOT EXISTS public.campaign_coupon_grants (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  campaign_id uuid NOT NULL,
  audience_snapshot_id uuid NOT NULL,
  coupon_grant_id uuid NOT NULL,
  account_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT campaign_coupon_grants_tenant_id_uidx UNIQUE (org_id, store_id, id),
  CONSTRAINT campaign_coupon_grants_grant_uidx UNIQUE (org_id, store_id, coupon_grant_id),
  CONSTRAINT campaign_coupon_grants_recipient_uidx UNIQUE (org_id, store_id, batch_id, account_id),
  CONSTRAINT campaign_coupon_grants_batch_fk
    FOREIGN KEY (org_id, store_id, batch_id)
    REFERENCES campaign_coupon_batches (org_id, store_id, id),
  CONSTRAINT campaign_coupon_grants_campaign_fk
    FOREIGN KEY (org_id, store_id, campaign_id) REFERENCES campaigns (org_id, store_id, id),
  CONSTRAINT campaign_coupon_grants_snapshot_fk
    FOREIGN KEY (org_id, store_id, audience_snapshot_id)
    REFERENCES campaign_audience_snapshots (org_id, store_id, id),
  CONSTRAINT campaign_coupon_grants_grant_fk
    FOREIGN KEY (org_id, coupon_grant_id, account_id)
    REFERENCES coupon_grants (org_id, id, account_id),
  CONSTRAINT campaign_coupon_grants_account_fk
    FOREIGN KEY (org_id, account_id) REFERENCES member_accounts (org_id, id)
);

CREATE INDEX IF NOT EXISTS campaign_coupon_grants_batch_idx
  ON public.campaign_coupon_grants (org_id, store_id, batch_id, coupon_grant_id);

CREATE OR REPLACE FUNCTION public.guard_campaign_coupon_batch()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE campaign_row campaigns%ROWTYPE; snapshot_row campaign_audience_snapshots%ROWTYPE;
        coupon_row coupons%ROWTYPE;
BEGIN
  SELECT * INTO campaign_row FROM campaigns
   WHERE org_id = NEW.org_id AND store_id = NEW.store_id AND id = NEW.campaign_id
   FOR UPDATE;
  SELECT * INTO snapshot_row FROM campaign_audience_snapshots
   WHERE org_id = NEW.org_id AND store_id = NEW.store_id AND id = NEW.audience_snapshot_id
   FOR SHARE;
  SELECT * INTO coupon_row FROM coupons
   WHERE org_id = NEW.org_id AND id = NEW.coupon_definition_id FOR SHARE;
  IF campaign_row.id IS NULL
     OR campaign_row.status <> 'scheduled'
     OR statement_timestamp() < campaign_row.starts_at
     OR statement_timestamp() >= campaign_row.ends_at THEN
    RAISE check_violation USING MESSAGE = 'MARKETING_CAMPAIGN_NOT_ACTIVE';
  END IF;
  IF snapshot_row.id IS NULL
     OR snapshot_row.campaign_id <> NEW.campaign_id
     OR snapshot_row.campaign_version <> NEW.campaign_version
     OR snapshot_row.audience_digest <> NEW.audience_digest
     OR snapshot_row.recipient_count <> NEW.audience_recipient_count
     OR campaign_row.version <> NEW.campaign_version THEN
    RAISE check_violation USING MESSAGE = 'MARKETING_AUDIENCE_STALE';
  END IF;
  IF coupon_row.id IS NULL
     OR coupon_row.status <> 'active'
     OR coupon_row.version <> NEW.coupon_version
     OR coupon_row.code <> NEW.coupon_code
     OR coupon_row.name <> NEW.coupon_name
     OR coupon_row.discount_cents <> NEW.coupon_discount_cents
     OR coupon_row.min_order_cents <> NEW.coupon_min_order_cents
     OR coupon_row.valid_days <> NEW.coupon_valid_days THEN
    RAISE check_violation USING MESSAGE = 'MARKETING_COUPON_STALE';
  END IF;
  NEW.created_at := statement_timestamp();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_campaign_coupon_grant()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE batch_row campaign_coupon_batches%ROWTYPE;
        grant_row coupon_grants%ROWTYPE;
        mapped_count integer;
BEGIN
  SELECT * INTO batch_row FROM campaign_coupon_batches
   WHERE org_id = NEW.org_id AND store_id = NEW.store_id AND id = NEW.batch_id FOR UPDATE;
  SELECT * INTO grant_row FROM coupon_grants
   WHERE org_id = NEW.org_id AND id = NEW.coupon_grant_id AND account_id = NEW.account_id FOR SHARE;
  IF batch_row.id IS NULL
     OR grant_row.id IS NULL
     OR batch_row.campaign_id <> NEW.campaign_id
     OR batch_row.audience_snapshot_id <> NEW.audience_snapshot_id
     OR grant_row.definition_id <> batch_row.coupon_definition_id
     OR grant_row.code <> batch_row.coupon_code
     OR grant_row.discount_cents <> batch_row.coupon_discount_cents
     OR grant_row.min_order_cents <> batch_row.coupon_min_order_cents
     OR grant_row.granted_store_id <> NEW.store_id THEN
    RAISE check_violation USING MESSAGE = 'MARKETING_COUPON_GRANT_MISMATCH';
  END IF;
  SELECT count(*) INTO mapped_count FROM campaign_coupon_grants
   WHERE org_id = NEW.org_id AND store_id = NEW.store_id AND batch_id = NEW.batch_id;
  IF mapped_count >= batch_row.granted_count THEN
    RAISE check_violation USING MESSAGE = 'MARKETING_COUPON_BATCH_GRANT_CAP';
  END IF;
  NEW.created_at := statement_timestamp();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_campaign_coupon_batch_complete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE target_batch_id uuid;
        batch_row campaign_coupon_batches%ROWTYPE;
        mapped_count integer;
        ledger_count integer;
        ledger_amount bigint;
BEGIN
  target_batch_id := CASE
    WHEN TG_TABLE_NAME = 'campaign_coupon_grants'
      THEN (to_jsonb(NEW)->>'batch_id')::uuid
    ELSE (to_jsonb(NEW)->>'id')::uuid
  END;
  SELECT * INTO batch_row FROM campaign_coupon_batches
   WHERE org_id = NEW.org_id AND store_id = NEW.store_id AND id = target_batch_id FOR UPDATE;
  IF batch_row.id IS NULL THEN
    RAISE foreign_key_violation USING MESSAGE = 'MARKETING_COUPON_BATCH_NOT_FOUND';
  END IF;
  SELECT count(*) INTO mapped_count FROM campaign_coupon_grants
   WHERE org_id = batch_row.org_id AND store_id = batch_row.store_id
     AND campaign_coupon_grants.batch_id = batch_row.id;
  SELECT count(*), COALESCE(sum(amount_cents), 0) INTO ledger_count, ledger_amount
    FROM campaign_budget_ledger
   WHERE org_id = batch_row.org_id AND store_id = batch_row.store_id
     AND campaign_id = batch_row.campaign_id
     AND kind = 'coupon_issue' AND source_id = batch_row.id;
  IF mapped_count <> batch_row.granted_count
     OR ledger_count <> 1
     OR ledger_amount <> batch_row.budget_committed_cents THEN
    RAISE check_violation USING MESSAGE = 'MARKETING_COUPON_BATCH_INCOMPLETE';
  END IF;
  RETURN NULL;
END;
$$;

-- Item 7's generic budget authority becomes exact for coupon issuance: every
-- debit must cite one immutable batch and equal its worst-case face value.
CREATE OR REPLACE FUNCTION public.guard_marketing_budget_ledger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE campaign_budget integer; used_cents bigint; batch_amount integer;
BEGIN
  SELECT budget_limit_cents INTO campaign_budget FROM campaigns
   WHERE org_id = NEW.org_id AND store_id = NEW.store_id AND id = NEW.campaign_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE foreign_key_violation USING MESSAGE = 'MARKETING_CAMPAIGN_NOT_FOUND'; END IF;
  SELECT budget_committed_cents INTO batch_amount FROM campaign_coupon_batches
   WHERE org_id = NEW.org_id AND store_id = NEW.store_id
     AND campaign_id = NEW.campaign_id AND id = NEW.source_id FOR SHARE;
  IF NOT FOUND OR NEW.kind <> 'coupon_issue' OR NEW.amount_cents <> batch_amount THEN
    RAISE check_violation USING MESSAGE = 'MARKETING_BUDGET_SOURCE_INVALID';
  END IF;
  SELECT COALESCE(sum(amount_cents), 0) INTO used_cents FROM campaign_budget_ledger
   WHERE org_id = NEW.org_id AND store_id = NEW.store_id AND campaign_id = NEW.campaign_id;
  IF used_cents + NEW.amount_cents > campaign_budget THEN
    RAISE check_violation USING MESSAGE = 'MARKETING_BUDGET_EXCEEDED';
  END IF;
  NEW.at := statement_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER campaign_coupon_batches_guard_trg BEFORE INSERT ON public.campaign_coupon_batches
  FOR EACH ROW EXECUTE FUNCTION public.guard_campaign_coupon_batch();
CREATE TRIGGER campaign_coupon_batches_append_only_trg
  BEFORE UPDATE OR DELETE ON public.campaign_coupon_batches
  FOR EACH ROW EXECUTE FUNCTION public.reject_marketing_evidence_mutation();
CREATE CONSTRAINT TRIGGER campaign_coupon_batches_complete_trg
  AFTER INSERT ON public.campaign_coupon_batches
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION public.guard_campaign_coupon_batch_complete();
CREATE TRIGGER campaign_coupon_grants_guard_trg BEFORE INSERT ON public.campaign_coupon_grants
  FOR EACH ROW EXECUTE FUNCTION public.guard_campaign_coupon_grant();
CREATE CONSTRAINT TRIGGER campaign_coupon_grants_complete_trg
  AFTER INSERT ON public.campaign_coupon_grants
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION public.guard_campaign_coupon_batch_complete();
CREATE TRIGGER campaign_coupon_grants_append_only_trg
  BEFORE UPDATE OR DELETE ON public.campaign_coupon_grants
  FOR EACH ROW EXECUTE FUNCTION public.reject_marketing_evidence_mutation();

ALTER TABLE public.campaign_coupon_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_coupon_batches FORCE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_coupon_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_coupon_grants FORCE ROW LEVEL SECURITY;

CREATE POLICY campaign_coupon_batches_store_scope ON public.campaign_coupon_batches
  AS PERMISSIVE FOR ALL TO laundry_app
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid);
CREATE POLICY campaign_coupon_batches_maintenance ON public.campaign_coupon_batches
  AS PERMISSIVE FOR ALL TO laundry_owner USING (true) WITH CHECK (true);
CREATE POLICY campaign_coupon_grants_store_scope ON public.campaign_coupon_grants
  AS PERMISSIVE FOR ALL TO laundry_app
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid);
CREATE POLICY campaign_coupon_grants_maintenance ON public.campaign_coupon_grants
  AS PERMISSIVE FOR ALL TO laundry_owner USING (true) WITH CHECK (true);

GRANT SELECT, INSERT ON TABLE public.campaign_coupon_batches, public.campaign_coupon_grants
  TO laundry_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE
  public.campaign_coupon_batches, public.campaign_coupon_grants FROM laundry_app;

REVOKE ALL ON FUNCTION public.guard_campaign_coupon_batch() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_campaign_coupon_grant() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_campaign_coupon_batch_complete() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_marketing_budget_ledger() FROM PUBLIC;
