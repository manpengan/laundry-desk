-- ADR-54 / Stage 4.4 Item 9. Slots 0061-0062 are reserved for Items 10-11.
-- Referral rewards reuse the existing coupon ledger and campaign budget.
-- Group-buy bearer codes are retained only as SHA-256 domain-separated digests.

CREATE TABLE IF NOT EXISTS public.referral_rewards (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  campaign_id uuid NOT NULL,
  campaign_version integer NOT NULL,
  referrer_customer_id uuid NOT NULL,
  referrer_account_id uuid NOT NULL,
  referred_customer_id uuid NOT NULL,
  referred_account_id uuid NOT NULL,
  qualifying_order_id uuid NOT NULL,
  coupon_definition_id uuid NOT NULL,
  coupon_version integer NOT NULL,
  coupon_code text NOT NULL,
  coupon_name text NOT NULL,
  coupon_discount_cents integer NOT NULL,
  coupon_min_order_cents integer NOT NULL,
  coupon_valid_days integer NOT NULL,
  coupon_grant_id uuid NOT NULL,
  reward_cents integer NOT NULL,
  budget_remaining_before_cents integer NOT NULL,
  reason text NOT NULL,
  created_by_staff_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT referral_rewards_tenant_id_uidx UNIQUE (org_id, store_id, id),
  CONSTRAINT referral_rewards_referred_campaign_uidx
    UNIQUE (org_id, store_id, campaign_id, referred_customer_id),
  CONSTRAINT referral_rewards_order_uidx UNIQUE (org_id, store_id, qualifying_order_id),
  CONSTRAINT referral_rewards_grant_uidx UNIQUE (org_id, coupon_grant_id),
  CONSTRAINT referral_rewards_campaign_fk
    FOREIGN KEY (org_id, store_id, campaign_id) REFERENCES campaigns (org_id, store_id, id),
  CONSTRAINT referral_rewards_referrer_customer_fk
    FOREIGN KEY (org_id, referrer_customer_id) REFERENCES customers (org_id, id),
  CONSTRAINT referral_rewards_referred_customer_fk
    FOREIGN KEY (org_id, referred_customer_id) REFERENCES customers (org_id, id),
  CONSTRAINT referral_rewards_referrer_account_fk
    FOREIGN KEY (org_id, referrer_account_id) REFERENCES member_accounts (org_id, id),
  CONSTRAINT referral_rewards_referred_account_fk
    FOREIGN KEY (org_id, referred_account_id) REFERENCES member_accounts (org_id, id),
  CONSTRAINT referral_rewards_order_fk
    FOREIGN KEY (org_id, store_id, qualifying_order_id) REFERENCES orders (org_id, store_id, id),
  CONSTRAINT referral_rewards_coupon_fk
    FOREIGN KEY (org_id, coupon_definition_id) REFERENCES coupons (org_id, id),
  CONSTRAINT referral_rewards_grant_fk
    FOREIGN KEY (org_id, coupon_grant_id) REFERENCES coupon_grants (org_id, id),
  CONSTRAINT referral_rewards_staff_fk
    FOREIGN KEY (org_id, created_by_staff_id) REFERENCES staffs (org_id, id),
  CONSTRAINT referral_rewards_distinct_customer_chk
    CHECK (referrer_customer_id <> referred_customer_id),
  CONSTRAINT referral_rewards_distinct_account_chk
    CHECK (referrer_account_id <> referred_account_id),
  CONSTRAINT referral_rewards_campaign_version_chk CHECK (campaign_version > 0),
  CONSTRAINT referral_rewards_coupon_version_chk CHECK (coupon_version > 0),
  CONSTRAINT referral_rewards_code_chk CHECK (coupon_code ~ '^[a-z][a-z0-9_-]{0,31}$'),
  CONSTRAINT referral_rewards_name_chk CHECK (char_length(btrim(coupon_name)) BETWEEN 1 AND 64),
  CONSTRAINT referral_rewards_discount_chk CHECK (coupon_discount_cents BETWEEN 1 AND 5000000),
  CONSTRAINT referral_rewards_minimum_chk CHECK (coupon_min_order_cents BETWEEN 0 AND 5000000),
  CONSTRAINT referral_rewards_days_chk CHECK (coupon_valid_days BETWEEN 1 AND 3650),
  CONSTRAINT referral_rewards_value_chk CHECK (reward_cents = coupon_discount_cents),
  CONSTRAINT referral_rewards_budget_before_chk CHECK (
    budget_remaining_before_cents BETWEEN reward_cents AND 5000000
  ),
  CONSTRAINT referral_rewards_reason_chk CHECK (char_length(btrim(reason)) BETWEEN 1 AND 256)
);

CREATE INDEX IF NOT EXISTS referral_rewards_referrer_created_idx
  ON public.referral_rewards (org_id, store_id, referrer_customer_id, created_at DESC, id);

CREATE TABLE IF NOT EXISTS public.group_buy_vouchers (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  provider text NOT NULL,
  external_order_ref text NOT NULL,
  code_digest text NOT NULL,
  code_last4 text NOT NULL,
  label text NOT NULL,
  face_value_cents integer NOT NULL,
  expires_at timestamptz NOT NULL,
  reason text NOT NULL,
  registered_by_staff_id uuid NOT NULL,
  registered_at timestamptz NOT NULL,
  CONSTRAINT group_buy_vouchers_tenant_id_uidx UNIQUE (org_id, store_id, id),
  CONSTRAINT group_buy_vouchers_external_uidx
    UNIQUE (org_id, store_id, provider, external_order_ref),
  CONSTRAINT group_buy_vouchers_digest_uidx UNIQUE (org_id, store_id, code_digest),
  CONSTRAINT group_buy_vouchers_store_fk
    FOREIGN KEY (org_id, store_id) REFERENCES stores (org_id, id),
  CONSTRAINT group_buy_vouchers_staff_fk
    FOREIGN KEY (org_id, registered_by_staff_id) REFERENCES staffs (org_id, id),
  CONSTRAINT group_buy_vouchers_provider_chk
    CHECK (provider IN ('meituan', 'douyin', 'wechat', 'other')),
  CONSTRAINT group_buy_vouchers_external_chk
    CHECK (char_length(btrim(external_order_ref)) BETWEEN 1 AND 64),
  CONSTRAINT group_buy_vouchers_digest_chk CHECK (code_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT group_buy_vouchers_last4_chk CHECK (code_last4 ~ '^[A-Za-z0-9]{4}$'),
  CONSTRAINT group_buy_vouchers_label_chk CHECK (char_length(btrim(label)) BETWEEN 1 AND 64),
  CONSTRAINT group_buy_vouchers_value_chk CHECK (face_value_cents BETWEEN 1 AND 5000000),
  CONSTRAINT group_buy_vouchers_expiry_chk CHECK (
    expires_at > registered_at AND expires_at <= registered_at + interval '5 years'
  ),
  CONSTRAINT group_buy_vouchers_reason_chk CHECK (char_length(btrim(reason)) BETWEEN 1 AND 256)
);

CREATE INDEX IF NOT EXISTS group_buy_vouchers_expiry_idx
  ON public.group_buy_vouchers (org_id, store_id, expires_at, id);

CREATE TABLE IF NOT EXISTS public.group_buy_redemptions (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  voucher_id uuid NOT NULL,
  order_id uuid NOT NULL,
  order_original_cents integer NOT NULL,
  order_payable_before_cents integer NOT NULL,
  applied_discount_cents integer NOT NULL,
  reason text NOT NULL,
  redeemed_by_staff_id uuid NOT NULL,
  redeemed_at timestamptz NOT NULL,
  CONSTRAINT group_buy_redemptions_tenant_id_uidx UNIQUE (org_id, store_id, id),
  CONSTRAINT group_buy_redemptions_voucher_uidx UNIQUE (org_id, store_id, voucher_id),
  CONSTRAINT group_buy_redemptions_order_uidx UNIQUE (org_id, store_id, order_id),
  CONSTRAINT group_buy_redemptions_voucher_fk
    FOREIGN KEY (org_id, store_id, voucher_id)
    REFERENCES group_buy_vouchers (org_id, store_id, id),
  CONSTRAINT group_buy_redemptions_order_fk
    FOREIGN KEY (org_id, store_id, order_id) REFERENCES orders (org_id, store_id, id),
  CONSTRAINT group_buy_redemptions_staff_fk
    FOREIGN KEY (org_id, redeemed_by_staff_id) REFERENCES staffs (org_id, id),
  CONSTRAINT group_buy_redemptions_original_chk CHECK (order_original_cents > 0),
  CONSTRAINT group_buy_redemptions_payable_chk CHECK (order_payable_before_cents > 0),
  CONSTRAINT group_buy_redemptions_discount_chk CHECK (
    applied_discount_cents BETWEEN 1 AND 5000000
    AND applied_discount_cents <= order_original_cents
    AND applied_discount_cents <= order_payable_before_cents
  ),
  CONSTRAINT group_buy_redemptions_reason_chk CHECK (char_length(btrim(reason)) BETWEEN 1 AND 256)
);

CREATE INDEX IF NOT EXISTS group_buy_redemptions_redeemed_idx
  ON public.group_buy_redemptions (org_id, store_id, redeemed_at DESC, id);

CREATE OR REPLACE FUNCTION public.guard_referral_reward()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE campaign_row campaigns%ROWTYPE; referrer_row member_accounts%ROWTYPE;
        referred_row member_accounts%ROWTYPE; order_row orders%ROWTYPE;
        coupon_row coupons%ROWTYPE; grant_row coupon_grants%ROWTYPE;
        used_cents bigint;
BEGIN
  SELECT * INTO campaign_row FROM campaigns
   WHERE org_id=NEW.org_id AND store_id=NEW.store_id AND id=NEW.campaign_id FOR UPDATE;
  PERFORM id FROM customers
   WHERE org_id=NEW.org_id AND id IN (NEW.referrer_customer_id, NEW.referred_customer_id)
   ORDER BY id FOR KEY SHARE;
  PERFORM id FROM member_accounts
   WHERE org_id=NEW.org_id AND id IN (NEW.referrer_account_id, NEW.referred_account_id)
   ORDER BY id FOR UPDATE;
  SELECT * INTO referrer_row FROM member_accounts
   WHERE org_id=NEW.org_id AND id=NEW.referrer_account_id;
  SELECT * INTO referred_row FROM member_accounts
   WHERE org_id=NEW.org_id AND id=NEW.referred_account_id;
  SELECT * INTO order_row FROM orders
   WHERE org_id=NEW.org_id AND store_id=NEW.store_id AND id=NEW.qualifying_order_id FOR SHARE;
  SELECT * INTO coupon_row FROM coupons
   WHERE org_id=NEW.org_id AND id=NEW.coupon_definition_id FOR SHARE;
  SELECT * INTO grant_row FROM coupon_grants
   WHERE org_id=NEW.org_id AND id=NEW.coupon_grant_id FOR SHARE;
  IF campaign_row.id IS NULL OR campaign_row.version <> NEW.campaign_version
     OR campaign_row.status <> 'scheduled' OR statement_timestamp() < campaign_row.starts_at
     OR statement_timestamp() >= campaign_row.ends_at THEN
    RAISE check_violation USING MESSAGE = 'MARKETING_REFERRAL_CAMPAIGN_INVALID';
  END IF;
  SELECT COALESCE(sum(amount_cents), 0) INTO used_cents FROM campaign_budget_ledger
   WHERE org_id=NEW.org_id AND store_id=NEW.store_id AND campaign_id=NEW.campaign_id;
  IF NEW.budget_remaining_before_cents <> campaign_row.budget_limit_cents - used_cents
     OR NEW.reward_cents > NEW.budget_remaining_before_cents THEN
    RAISE check_violation USING MESSAGE = 'MARKETING_REFERRAL_BUDGET_SNAPSHOT_INVALID';
  END IF;
  IF referrer_row.id IS NULL OR referred_row.id IS NULL
     OR referrer_row.status <> 'active' OR referred_row.status <> 'active'
     OR referrer_row.customer_id <> NEW.referrer_customer_id
     OR referred_row.customer_id <> NEW.referred_customer_id
     OR EXISTS (
       SELECT 1 FROM customers
        WHERE org_id=NEW.org_id AND id IN (NEW.referrer_customer_id, NEW.referred_customer_id)
          AND (merged_into_id IS NOT NULL OR anonymized_at IS NOT NULL)
     ) THEN
    RAISE check_violation USING MESSAGE = 'MARKETING_REFERRAL_ACCOUNT_INVALID';
  END IF;
  IF order_row.id IS NULL OR order_row.customer_id <> NEW.referred_customer_id
     OR order_row.status <> 'closed' OR order_row.balance_cents <> 0 OR order_row.paid_cents <= 0 THEN
    RAISE check_violation USING MESSAGE = 'MARKETING_REFERRAL_ORDER_INVALID';
  END IF;
  IF coupon_row.id IS NULL OR coupon_row.status <> 'active'
     OR coupon_row.version <> NEW.coupon_version OR coupon_row.code <> NEW.coupon_code
     OR coupon_row.name <> NEW.coupon_name OR coupon_row.discount_cents <> NEW.coupon_discount_cents
     OR coupon_row.min_order_cents <> NEW.coupon_min_order_cents
     OR coupon_row.valid_days <> NEW.coupon_valid_days THEN
    RAISE check_violation USING MESSAGE = 'MARKETING_REFERRAL_COUPON_INVALID';
  END IF;
  IF grant_row.id IS NULL OR grant_row.account_id <> NEW.referrer_account_id
     OR grant_row.definition_id <> NEW.coupon_definition_id
     OR grant_row.code <> NEW.coupon_code OR grant_row.name <> NEW.coupon_name
     OR grant_row.discount_cents <> NEW.coupon_discount_cents
     OR grant_row.min_order_cents <> NEW.coupon_min_order_cents
     OR grant_row.granted_store_id <> NEW.store_id THEN
    RAISE check_violation USING MESSAGE = 'MARKETING_REFERRAL_GRANT_INVALID';
  END IF;
  NEW.created_at := statement_timestamp();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_referral_reward_complete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE ledger_count integer; ledger_amount bigint;
BEGIN
  SELECT count(*), COALESCE(sum(amount_cents), 0) INTO ledger_count, ledger_amount
    FROM campaign_budget_ledger
   WHERE org_id=NEW.org_id AND store_id=NEW.store_id AND campaign_id=NEW.campaign_id
     AND kind='coupon_issue' AND source_id=NEW.id;
  IF ledger_count <> 1 OR ledger_amount <> NEW.reward_cents THEN
    RAISE check_violation USING MESSAGE = 'MARKETING_REFERRAL_REWARD_INCOMPLETE';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_group_buy_voucher()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  NEW.registered_at := statement_timestamp();
  IF NEW.expires_at <= NEW.registered_at OR NEW.expires_at > NEW.registered_at + interval '5 years' THEN
    RAISE check_violation USING MESSAGE = 'MARKETING_GROUP_BUY_EXPIRY_INVALID';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_group_buy_redemption()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE voucher_row group_buy_vouchers%ROWTYPE; order_row orders%ROWTYPE;
BEGIN
  SELECT * INTO voucher_row FROM group_buy_vouchers
   WHERE org_id=NEW.org_id AND store_id=NEW.store_id AND id=NEW.voucher_id FOR UPDATE;
  SELECT * INTO order_row FROM orders
   WHERE org_id=NEW.org_id AND store_id=NEW.store_id AND id=NEW.order_id FOR UPDATE;
  IF voucher_row.id IS NULL OR statement_timestamp() >= voucher_row.expires_at THEN
    RAISE check_violation USING MESSAGE = 'MARKETING_GROUP_BUY_VOUCHER_INVALID';
  END IF;
  IF order_row.id IS NULL OR order_row.status <> 'open' OR order_row.paid_cents <> 0
     OR order_row.original_cents <> NEW.order_original_cents
     OR order_row.discount_cents <> NEW.applied_discount_cents
     OR order_row.discount_source <> 'manual'
     OR order_row.payable_cents <> NEW.order_payable_before_cents - NEW.applied_discount_cents
     OR order_row.balance_cents <> order_row.payable_cents
     OR NEW.applied_discount_cents <> LEAST(voucher_row.face_value_cents, order_row.original_cents) THEN
    RAISE check_violation USING MESSAGE = 'MARKETING_GROUP_BUY_ORDER_INVALID';
  END IF;
  NEW.redeemed_at := statement_timestamp();
  RETURN NEW;
END;
$$;

-- Item 8 calls every marketing promise a coupon_issue. Item 9 keeps that stable
-- kind and adds a second exact source table rather than weakening the amount cap.
CREATE OR REPLACE FUNCTION public.guard_marketing_budget_ledger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE campaign_budget integer; used_cents bigint; batch_amount integer;
        referral_amount integer; source_count integer;
BEGIN
  SELECT budget_limit_cents INTO campaign_budget FROM campaigns
   WHERE org_id=NEW.org_id AND store_id=NEW.store_id AND id=NEW.campaign_id FOR UPDATE;
  IF NOT FOUND THEN RAISE foreign_key_violation USING MESSAGE = 'MARKETING_CAMPAIGN_NOT_FOUND'; END IF;
  SELECT budget_committed_cents INTO batch_amount FROM campaign_coupon_batches
   WHERE org_id=NEW.org_id AND store_id=NEW.store_id
     AND campaign_id=NEW.campaign_id AND id=NEW.source_id FOR SHARE;
  SELECT reward_cents INTO referral_amount FROM referral_rewards
   WHERE org_id=NEW.org_id AND store_id=NEW.store_id
     AND campaign_id=NEW.campaign_id AND id=NEW.source_id FOR SHARE;
  source_count := (CASE WHEN batch_amount IS NULL THEN 0 ELSE 1 END)
                + (CASE WHEN referral_amount IS NULL THEN 0 ELSE 1 END);
  IF NEW.kind <> 'coupon_issue' OR source_count <> 1
     OR NEW.amount_cents <> COALESCE(batch_amount, referral_amount) THEN
    RAISE check_violation USING MESSAGE = 'MARKETING_BUDGET_SOURCE_INVALID';
  END IF;
  SELECT COALESCE(sum(amount_cents), 0) INTO used_cents FROM campaign_budget_ledger
   WHERE org_id=NEW.org_id AND store_id=NEW.store_id AND campaign_id=NEW.campaign_id;
  IF used_cents + NEW.amount_cents > campaign_budget THEN
    RAISE check_violation USING MESSAGE = 'MARKETING_BUDGET_EXCEEDED';
  END IF;
  NEW.at := statement_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER referral_rewards_guard_trg BEFORE INSERT ON public.referral_rewards
  FOR EACH ROW EXECUTE FUNCTION public.guard_referral_reward();
CREATE CONSTRAINT TRIGGER referral_rewards_complete_trg AFTER INSERT ON public.referral_rewards
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.guard_referral_reward_complete();
CREATE TRIGGER referral_rewards_append_only_trg BEFORE UPDATE OR DELETE ON public.referral_rewards
  FOR EACH ROW EXECUTE FUNCTION public.reject_marketing_evidence_mutation();
CREATE TRIGGER group_buy_vouchers_guard_trg BEFORE INSERT ON public.group_buy_vouchers
  FOR EACH ROW EXECUTE FUNCTION public.guard_group_buy_voucher();
CREATE TRIGGER group_buy_vouchers_append_only_trg BEFORE UPDATE OR DELETE ON public.group_buy_vouchers
  FOR EACH ROW EXECUTE FUNCTION public.reject_marketing_evidence_mutation();
CREATE TRIGGER group_buy_redemptions_guard_trg BEFORE INSERT ON public.group_buy_redemptions
  FOR EACH ROW EXECUTE FUNCTION public.guard_group_buy_redemption();
CREATE TRIGGER group_buy_redemptions_append_only_trg
  BEFORE UPDATE OR DELETE ON public.group_buy_redemptions
  FOR EACH ROW EXECUTE FUNCTION public.reject_marketing_evidence_mutation();

ALTER TABLE public.referral_rewards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.referral_rewards FORCE ROW LEVEL SECURITY;
ALTER TABLE public.group_buy_vouchers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_buy_vouchers FORCE ROW LEVEL SECURITY;
ALTER TABLE public.group_buy_redemptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_buy_redemptions FORCE ROW LEVEL SECURITY;

CREATE POLICY referral_rewards_store_scope ON public.referral_rewards FOR ALL TO laundry_app
  USING (org_id=NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id=NULLIF(current_setting('app.store_id', true), '')::uuid)
  WITH CHECK (org_id=NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id=NULLIF(current_setting('app.store_id', true), '')::uuid);
CREATE POLICY referral_rewards_maintenance ON public.referral_rewards
  FOR ALL TO laundry_owner USING (true) WITH CHECK (true);
CREATE POLICY group_buy_vouchers_store_scope ON public.group_buy_vouchers FOR ALL TO laundry_app
  USING (org_id=NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id=NULLIF(current_setting('app.store_id', true), '')::uuid)
  WITH CHECK (org_id=NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id=NULLIF(current_setting('app.store_id', true), '')::uuid);
CREATE POLICY group_buy_vouchers_maintenance ON public.group_buy_vouchers
  FOR ALL TO laundry_owner USING (true) WITH CHECK (true);
CREATE POLICY group_buy_redemptions_store_scope ON public.group_buy_redemptions FOR ALL TO laundry_app
  USING (org_id=NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id=NULLIF(current_setting('app.store_id', true), '')::uuid)
  WITH CHECK (org_id=NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id=NULLIF(current_setting('app.store_id', true), '')::uuid);
CREATE POLICY group_buy_redemptions_maintenance ON public.group_buy_redemptions
  FOR ALL TO laundry_owner USING (true) WITH CHECK (true);

GRANT SELECT, INSERT ON TABLE public.referral_rewards, public.group_buy_vouchers,
  public.group_buy_redemptions TO laundry_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.referral_rewards, public.group_buy_vouchers,
  public.group_buy_redemptions FROM laundry_app;

REVOKE ALL ON FUNCTION public.guard_referral_reward() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_referral_reward_complete() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_group_buy_voucher() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_group_buy_redemption() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_marketing_budget_ledger() FROM PUBLIC;
