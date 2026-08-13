-- ADR-52 / Stage 4.4 Item 7. Numbers 0054-0058 are reserved for Items 1-6.
-- Store-scoped campaign definitions, digest-only audience freezes and an
-- append-only integer-cent budget authority. This migration issues no coupon.

CREATE OR REPLACE FUNCTION public.marketing_json_exact_keys(value jsonb, expected text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT jsonb_typeof(value) = 'object'
     AND (SELECT COALESCE(array_agg(key ORDER BY key), ARRAY[]::text[])
            FROM jsonb_object_keys(value) AS key) = expected;
$$;

CREATE OR REPLACE FUNCTION public.marketing_audience_rule_is_valid(value jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  age_rule jsonb;
  activity_rule jsonb;
  membership_rule jsonb;
  tier_count integer;
BEGIN
  IF NOT marketing_json_exact_keys(
    value, ARRAY['customer_age', 'membership', 'order_activity']
  ) THEN RETURN false; END IF;
  age_rule := value->'customer_age';
  activity_rule := value->'order_activity';
  membership_rule := value->'membership';

  IF age_rule->>'kind' = 'any' THEN
    IF NOT marketing_json_exact_keys(age_rule, ARRAY['kind']) THEN RETURN false; END IF;
  ELSIF age_rule->>'kind' = 'within_days' THEN
    IF NOT marketing_json_exact_keys(age_rule, ARRAY['days', 'kind'])
       OR jsonb_typeof(age_rule->'days') <> 'number'
       OR age_rule->>'days' !~ '^[0-9]+$'
       OR (age_rule->>'days')::integer NOT BETWEEN 1 AND 3650 THEN RETURN false; END IF;
  ELSE RETURN false; END IF;

  IF activity_rule->>'kind' IN ('any', 'none') THEN
    IF NOT marketing_json_exact_keys(activity_rule, ARRAY['kind']) THEN RETURN false; END IF;
  ELSIF activity_rule->>'kind' = 'within_days' THEN
    IF NOT marketing_json_exact_keys(activity_rule, ARRAY['days', 'kind'])
       OR jsonb_typeof(activity_rule->'days') <> 'number'
       OR activity_rule->>'days' !~ '^[0-9]+$'
       OR (activity_rule->>'days')::integer NOT BETWEEN 1 AND 3650 THEN RETURN false; END IF;
  ELSE RETURN false; END IF;

  IF membership_rule->>'kind' IN ('any', 'member', 'non_member') THEN
    RETURN marketing_json_exact_keys(membership_rule, ARRAY['kind']);
  END IF;
  IF membership_rule->>'kind' <> 'tiers'
     OR NOT marketing_json_exact_keys(membership_rule, ARRAY['kind', 'tier_ids'])
     OR jsonb_typeof(membership_rule->'tier_ids') <> 'array' THEN RETURN false; END IF;
  tier_count := jsonb_array_length(membership_rule->'tier_ids');
  IF tier_count NOT BETWEEN 1 AND 20 THEN RETURN false; END IF;
  RETURN (
    SELECT count(*) = tier_count AND count(DISTINCT tier_id) = tier_count
      FROM jsonb_array_elements_text(membership_rule->'tier_ids') AS tier(tier_id)
     WHERE tier_id ~* '^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$'
  );
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$$;

CREATE TABLE IF NOT EXISTS public.campaigns (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  status text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  audience_rule jsonb NOT NULL,
  audience_rule_sha256 text NOT NULL,
  recipient_limit integer NOT NULL,
  budget_limit_cents integer NOT NULL,
  version integer NOT NULL,
  created_by_staff_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  updated_by_staff_id uuid NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT campaigns_tenant_id_uidx UNIQUE (org_id, store_id, id),
  CONSTRAINT campaigns_code_uidx UNIQUE (org_id, store_id, code),
  CONSTRAINT campaigns_store_fk FOREIGN KEY (org_id, store_id) REFERENCES stores (org_id, id),
  CONSTRAINT campaigns_created_staff_fk
    FOREIGN KEY (org_id, created_by_staff_id) REFERENCES staffs (org_id, id),
  CONSTRAINT campaigns_updated_staff_fk
    FOREIGN KEY (org_id, updated_by_staff_id) REFERENCES staffs (org_id, id),
  CONSTRAINT campaigns_code_chk CHECK (code ~ '^[a-z][a-z0-9_-]{0,31}$'),
  CONSTRAINT campaigns_name_chk CHECK (char_length(btrim(name)) BETWEEN 1 AND 64),
  CONSTRAINT campaigns_status_chk CHECK (status IN ('draft', 'scheduled', 'paused', 'cancelled')),
  CONSTRAINT campaigns_window_chk CHECK (
    ends_at > starts_at AND ends_at <= starts_at + interval '730 days'
  ),
  CONSTRAINT campaigns_rule_chk CHECK (marketing_audience_rule_is_valid(audience_rule)),
  CONSTRAINT campaigns_rule_hash_chk CHECK (audience_rule_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT campaigns_recipient_limit_chk CHECK (recipient_limit BETWEEN 1 AND 500),
  CONSTRAINT campaigns_budget_limit_chk CHECK (budget_limit_cents BETWEEN 1 AND 5000000),
  CONSTRAINT campaigns_version_chk CHECK (version BETWEEN 1 AND 1000000),
  CONSTRAINT campaigns_time_chk CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS campaigns_store_updated_idx
  ON public.campaigns (org_id, store_id, updated_at DESC, id);

CREATE TABLE IF NOT EXISTS public.campaign_audience_snapshots (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  campaign_id uuid NOT NULL,
  campaign_version integer NOT NULL,
  audience_rule_sha256 text NOT NULL,
  audience_digest text NOT NULL,
  recipient_count integer NOT NULL,
  created_by_staff_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT campaign_audience_snapshots_tenant_id_uidx UNIQUE (org_id, store_id, id),
  CONSTRAINT campaign_audience_snapshots_semantic_uidx
    UNIQUE (org_id, store_id, campaign_id, campaign_version, audience_digest),
  CONSTRAINT campaign_audience_snapshots_campaign_fk
    FOREIGN KEY (org_id, store_id, campaign_id) REFERENCES campaigns (org_id, store_id, id),
  CONSTRAINT campaign_audience_snapshots_staff_fk
    FOREIGN KEY (org_id, created_by_staff_id) REFERENCES staffs (org_id, id),
  CONSTRAINT campaign_audience_snapshots_version_chk
    CHECK (campaign_version BETWEEN 1 AND 1000000),
  CONSTRAINT campaign_audience_snapshots_rule_hash_chk
    CHECK (audience_rule_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT campaign_audience_snapshots_digest_chk CHECK (audience_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT campaign_audience_snapshots_count_chk CHECK (recipient_count BETWEEN 0 AND 500)
);

CREATE INDEX IF NOT EXISTS campaign_audience_snapshots_campaign_created_idx
  ON public.campaign_audience_snapshots
  (org_id, store_id, campaign_id, created_at DESC, id);

CREATE TABLE IF NOT EXISTS public.campaign_budget_ledger (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  campaign_id uuid NOT NULL,
  kind text NOT NULL,
  source_id uuid NOT NULL,
  amount_cents integer NOT NULL,
  staff_id uuid NOT NULL,
  at timestamptz NOT NULL,
  CONSTRAINT campaign_budget_ledger_tenant_id_uidx UNIQUE (org_id, store_id, id),
  CONSTRAINT campaign_budget_ledger_source_uidx
    UNIQUE (org_id, store_id, campaign_id, kind, source_id),
  CONSTRAINT campaign_budget_ledger_campaign_fk
    FOREIGN KEY (org_id, store_id, campaign_id) REFERENCES campaigns (org_id, store_id, id),
  CONSTRAINT campaign_budget_ledger_staff_fk
    FOREIGN KEY (org_id, staff_id) REFERENCES staffs (org_id, id),
  CONSTRAINT campaign_budget_ledger_kind_chk CHECK (kind = 'coupon_issue'),
  CONSTRAINT campaign_budget_ledger_amount_chk CHECK (amount_cents BETWEEN 1 AND 5000000)
);

CREATE INDEX IF NOT EXISTS campaign_budget_ledger_campaign_idx
  ON public.campaign_budget_ledger (org_id, store_id, campaign_id, at, id);

-- A stable first-hop key owns exactly one marketing confirmation authority.
-- The transaction-level pending lock serializes normal creation; this index is
-- the database backstop against concurrent or alternate-writer duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS ai_pending_marketing_idempotency_uidx
  ON public.ai_pending_actions (org_id, store_id, command, idempotency_key)
  WHERE command IN ('marketing.campaign.set', 'marketing.campaign.audience.freeze');

CREATE OR REPLACE FUNCTION public.assert_marketing_actor(
  requested_org_id uuid,
  requested_store_id uuid,
  provided_staff_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id uuid := NULLIF(current_setting('app.staff_id', true), '')::uuid;
  tenant_org_id uuid := NULLIF(current_setting('app.org_id', true), '')::uuid;
  tenant_store_id uuid := NULLIF(current_setting('app.store_id', true), '')::uuid;
BEGIN
  IF session_user <> 'laundry_app' THEN RETURN; END IF;
  IF actor_id IS NULL OR actor_id IS DISTINCT FROM provided_staff_id
     OR tenant_org_id IS DISTINCT FROM requested_org_id
     OR tenant_store_id IS DISTINCT FROM requested_store_id
     OR NOT EXISTS (
       SELECT 1
         FROM staffs staff
         JOIN staff_store_roles role
           ON role.org_id = staff.org_id AND role.staff_id = staff.id
          AND role.store_id = requested_store_id
        WHERE staff.org_id = requested_org_id AND staff.id = actor_id
          AND staff.is_active = true AND role.is_active = true AND role.role = 'admin'
     ) THEN
    RAISE insufficient_privilege USING MESSAGE = 'MARKETING_ACTOR_UNAVAILABLE';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_marketing_campaign()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  used_cents bigint;
  db_now timestamptz := statement_timestamp();
BEGIN
  PERFORM public.assert_marketing_actor(NEW.org_id, NEW.store_id, NEW.updated_by_staff_id);
  IF TG_OP = 'INSERT' THEN
    IF NEW.version <> 1 THEN RAISE check_violation USING MESSAGE = 'MARKETING_VERSION_INVALID'; END IF;
    IF NEW.created_by_staff_id IS DISTINCT FROM NEW.updated_by_staff_id THEN
      RAISE insufficient_privilege USING MESSAGE = 'MARKETING_ACTOR_UNAVAILABLE';
    END IF;
    NEW.created_at := db_now;
  ELSE
    IF OLD.status = 'cancelled' THEN RAISE check_violation USING MESSAGE = 'MARKETING_CAMPAIGN_TERMINAL'; END IF;
    IF statement_timestamp() >= OLD.ends_at THEN
      RAISE check_violation USING MESSAGE = 'MARKETING_CAMPAIGN_TERMINAL';
    END IF;
    IF NEW.org_id <> OLD.org_id OR NEW.store_id <> OLD.store_id OR NEW.id <> OLD.id
       OR NEW.code <> OLD.code OR NEW.created_at <> OLD.created_at
       OR NEW.created_by_staff_id <> OLD.created_by_staff_id THEN
      RAISE check_violation USING MESSAGE = 'MARKETING_CAMPAIGN_IDENTITY_IMMUTABLE';
    END IF;
    IF NEW.version <> OLD.version + 1 THEN
      RAISE check_violation USING MESSAGE = 'MARKETING_VERSION_INVALID';
    END IF;
    IF db_now < OLD.updated_at THEN
      RAISE check_violation USING MESSAGE = 'MARKETING_TIME_INVALID';
    END IF;
    SELECT COALESCE(sum(amount_cents), 0) INTO used_cents
      FROM campaign_budget_ledger
     WHERE org_id = OLD.org_id AND store_id = OLD.store_id AND campaign_id = OLD.id;
    IF NEW.budget_limit_cents < used_cents THEN
      RAISE check_violation USING MESSAGE = 'MARKETING_BUDGET_BELOW_USAGE';
    END IF;
  END IF;
  NEW.audience_rule_sha256 := encode(digest(NEW.audience_rule::text, 'sha256'), 'hex');
  NEW.updated_at := db_now;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_marketing_audience_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE campaign_row campaigns%ROWTYPE;
BEGIN
  PERFORM public.assert_marketing_actor(NEW.org_id, NEW.store_id, NEW.created_by_staff_id);
  SELECT * INTO campaign_row FROM campaigns
   WHERE org_id = NEW.org_id AND store_id = NEW.store_id AND id = NEW.campaign_id
   FOR SHARE;
  IF NOT FOUND OR NEW.campaign_version <> campaign_row.version
     OR NEW.audience_rule_sha256 <> campaign_row.audience_rule_sha256
     OR NEW.recipient_count > campaign_row.recipient_limit THEN
    RAISE check_violation USING MESSAGE = 'MARKETING_AUDIENCE_STALE';
  END IF;
  NEW.created_at := statement_timestamp();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_marketing_budget_ledger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE campaign_budget integer; used_cents bigint;
BEGIN
  PERFORM public.assert_marketing_actor(NEW.org_id, NEW.store_id, NEW.staff_id);
  SELECT budget_limit_cents INTO campaign_budget FROM campaigns
   WHERE org_id = NEW.org_id AND store_id = NEW.store_id AND id = NEW.campaign_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE foreign_key_violation USING MESSAGE = 'MARKETING_CAMPAIGN_NOT_FOUND'; END IF;
  SELECT COALESCE(sum(amount_cents), 0) INTO used_cents FROM campaign_budget_ledger
   WHERE org_id = NEW.org_id AND store_id = NEW.store_id AND campaign_id = NEW.campaign_id;
  IF used_cents + NEW.amount_cents > campaign_budget THEN
    RAISE check_violation USING MESSAGE = 'MARKETING_BUDGET_EXCEEDED';
  END IF;
  NEW.at := statement_timestamp();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.reject_marketing_evidence_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE insufficient_privilege USING MESSAGE = 'marketing evidence is append-only'; END;
$$;

CREATE TRIGGER campaigns_guard_trg BEFORE INSERT OR UPDATE ON public.campaigns
  FOR EACH ROW EXECUTE FUNCTION public.guard_marketing_campaign();
CREATE TRIGGER campaign_audience_snapshots_guard_trg
  BEFORE INSERT ON public.campaign_audience_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.guard_marketing_audience_snapshot();
CREATE TRIGGER campaign_audience_snapshots_append_only_trg
  BEFORE UPDATE OR DELETE ON public.campaign_audience_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.reject_marketing_evidence_mutation();
CREATE TRIGGER campaign_budget_ledger_guard_trg
  BEFORE INSERT ON public.campaign_budget_ledger
  FOR EACH ROW EXECUTE FUNCTION public.guard_marketing_budget_ledger();
CREATE TRIGGER campaign_budget_ledger_append_only_trg
  BEFORE UPDATE OR DELETE ON public.campaign_budget_ledger
  FOR EACH ROW EXECUTE FUNCTION public.reject_marketing_evidence_mutation();

ALTER TABLE public.campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaigns FORCE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_audience_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_audience_snapshots FORCE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_budget_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_budget_ledger FORCE ROW LEVEL SECURITY;

CREATE POLICY campaigns_store_scope ON public.campaigns AS PERMISSIVE FOR ALL TO laundry_app
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid);
CREATE POLICY campaigns_maintenance ON public.campaigns
  AS PERMISSIVE FOR ALL TO laundry_owner USING (true) WITH CHECK (true);
CREATE POLICY campaign_audience_snapshots_store_scope ON public.campaign_audience_snapshots
  AS PERMISSIVE FOR ALL TO laundry_app
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid);
CREATE POLICY campaign_audience_snapshots_maintenance ON public.campaign_audience_snapshots
  AS PERMISSIVE FOR ALL TO laundry_owner USING (true) WITH CHECK (true);
CREATE POLICY campaign_budget_ledger_store_scope ON public.campaign_budget_ledger
  AS PERMISSIVE FOR SELECT TO laundry_app
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid);
CREATE POLICY campaign_budget_ledger_maintenance ON public.campaign_budget_ledger
  AS PERMISSIVE FOR ALL TO laundry_owner USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE ON TABLE public.campaigns TO laundry_app;
REVOKE DELETE, TRUNCATE ON TABLE public.campaigns FROM laundry_app;
GRANT SELECT, INSERT ON TABLE public.campaign_audience_snapshots TO laundry_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.campaign_audience_snapshots FROM laundry_app;
GRANT SELECT ON TABLE public.campaign_budget_ledger TO laundry_app;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.campaign_budget_ledger FROM laundry_app;

REVOKE ALL ON FUNCTION public.marketing_json_exact_keys(jsonb, text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.marketing_audience_rule_is_valid(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.marketing_audience_rule_is_valid(jsonb) TO laundry_app;
REVOKE ALL ON FUNCTION public.assert_marketing_actor(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_marketing_campaign() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_marketing_audience_snapshot() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_marketing_budget_ledger() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reject_marketing_evidence_mutation() FROM PUBLIC;
