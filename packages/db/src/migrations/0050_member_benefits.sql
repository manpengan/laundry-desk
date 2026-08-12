-- Expand-only: ADR-41 virtual member tiers, points, punch cards and coupons.
-- Stored-value money remains exclusively in member_ledger and has no expiry.
-- Definitions are mutable configuration with optimistic versions; issued
-- points/cards/coupons are immutable snapshots with append-only consumption.

CREATE TABLE IF NOT EXISTS member_tiers (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  level integer NOT NULL,
  status text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL,
  updated_by_staff_id uuid NOT NULL,
  note text,
  CONSTRAINT member_tiers_tenant_id_uidx UNIQUE (org_id, id),
  CONSTRAINT member_tiers_code_uidx UNIQUE (org_id, code),
  CONSTRAINT member_tiers_org_fk FOREIGN KEY (org_id) REFERENCES orgs (id),
  CONSTRAINT member_tiers_staff_fk
    FOREIGN KEY (org_id, updated_by_staff_id) REFERENCES staffs (org_id, id),
  CONSTRAINT member_tiers_code_chk CHECK (code ~ '^[a-z][a-z0-9_-]{0,31}$'),
  CONSTRAINT member_tiers_name_chk CHECK (char_length(btrim(name)) BETWEEN 1 AND 64),
  CONSTRAINT member_tiers_level_chk CHECK (level BETWEEN 1 AND 99),
  CONSTRAINT member_tiers_status_chk CHECK (status IN ('active', 'retired')),
  CONSTRAINT member_tiers_version_chk CHECK (version > 0),
  CONSTRAINT member_tiers_note_chk CHECK (note IS NULL OR char_length(note) <= 256)
);

CREATE TABLE IF NOT EXISTS member_points_policies (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  unit_cents integer NOT NULL,
  points_per_unit integer NOT NULL,
  valid_days integer NOT NULL,
  status text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL,
  updated_by_staff_id uuid NOT NULL,
  note text,
  CONSTRAINT member_points_policies_tenant_id_uidx UNIQUE (org_id, id),
  CONSTRAINT member_points_policies_org_uidx UNIQUE (org_id),
  CONSTRAINT member_points_policies_org_fk FOREIGN KEY (org_id) REFERENCES orgs (id),
  CONSTRAINT member_points_policies_staff_fk
    FOREIGN KEY (org_id, updated_by_staff_id) REFERENCES staffs (org_id, id),
  CONSTRAINT member_points_policies_unit_chk CHECK (unit_cents BETWEEN 1 AND 5000000),
  CONSTRAINT member_points_policies_rate_chk CHECK (points_per_unit BETWEEN 1 AND 100000),
  CONSTRAINT member_points_policies_days_chk CHECK (valid_days BETWEEN 1 AND 3650),
  CONSTRAINT member_points_policies_status_chk CHECK (status IN ('active', 'retired')),
  CONSTRAINT member_points_policies_version_chk CHECK (version > 0),
  CONSTRAINT member_points_policies_note_chk CHECK (note IS NULL OR char_length(note) <= 256)
);

CREATE TABLE IF NOT EXISTS member_punch_types (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  total_uses integer NOT NULL,
  valid_days integer NOT NULL,
  status text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL,
  updated_by_staff_id uuid NOT NULL,
  note text,
  CONSTRAINT member_punch_types_tenant_id_uidx UNIQUE (org_id, id),
  CONSTRAINT member_punch_types_code_uidx UNIQUE (org_id, code),
  CONSTRAINT member_punch_types_org_fk FOREIGN KEY (org_id) REFERENCES orgs (id),
  CONSTRAINT member_punch_types_staff_fk
    FOREIGN KEY (org_id, updated_by_staff_id) REFERENCES staffs (org_id, id),
  CONSTRAINT member_punch_types_code_chk CHECK (code ~ '^[a-z][a-z0-9_-]{0,31}$'),
  CONSTRAINT member_punch_types_name_chk CHECK (char_length(btrim(name)) BETWEEN 1 AND 64),
  CONSTRAINT member_punch_types_uses_chk CHECK (total_uses BETWEEN 1 AND 999),
  CONSTRAINT member_punch_types_days_chk CHECK (valid_days BETWEEN 1 AND 3650),
  CONSTRAINT member_punch_types_status_chk CHECK (status IN ('active', 'retired')),
  CONSTRAINT member_punch_types_version_chk CHECK (version > 0),
  CONSTRAINT member_punch_types_note_chk CHECK (note IS NULL OR char_length(note) <= 256)
);

CREATE TABLE IF NOT EXISTS coupons (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  discount_cents integer NOT NULL,
  min_order_cents integer NOT NULL,
  valid_days integer NOT NULL,
  status text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL,
  updated_by_staff_id uuid NOT NULL,
  note text,
  CONSTRAINT coupons_tenant_id_uidx UNIQUE (org_id, id),
  CONSTRAINT coupons_code_uidx UNIQUE (org_id, code),
  CONSTRAINT coupons_org_fk FOREIGN KEY (org_id) REFERENCES orgs (id),
  CONSTRAINT coupons_staff_fk
    FOREIGN KEY (org_id, updated_by_staff_id) REFERENCES staffs (org_id, id),
  CONSTRAINT coupons_code_chk CHECK (code ~ '^[a-z][a-z0-9_-]{0,31}$'),
  CONSTRAINT coupons_name_chk CHECK (char_length(btrim(name)) BETWEEN 1 AND 64),
  CONSTRAINT coupons_discount_chk CHECK (discount_cents BETWEEN 1 AND 5000000),
  CONSTRAINT coupons_minimum_chk CHECK (min_order_cents BETWEEN 0 AND 5000000),
  CONSTRAINT coupons_days_chk CHECK (valid_days BETWEEN 1 AND 3650),
  CONSTRAINT coupons_status_chk CHECK (status IN ('active', 'retired')),
  CONSTRAINT coupons_version_chk CHECK (version > 0),
  CONSTRAINT coupons_note_chk CHECK (note IS NULL OR char_length(note) <= 256)
);

-- The row persists after a tier is cleared so expected_version remains a CAS
-- token. Tier identity and display values are frozen at assignment time.
CREATE TABLE IF NOT EXISTS member_memberships (
  org_id uuid NOT NULL,
  account_id uuid NOT NULL,
  tier_id uuid,
  tier_code text,
  tier_name text,
  tier_level integer,
  valid_until date,
  version integer NOT NULL,
  updated_at timestamptz NOT NULL,
  updated_store_id uuid NOT NULL,
  updated_by_staff_id uuid NOT NULL,
  reason text NOT NULL,
  CONSTRAINT member_memberships_pkey PRIMARY KEY (org_id, account_id),
  CONSTRAINT member_memberships_account_fk
    FOREIGN KEY (org_id, account_id) REFERENCES member_accounts (org_id, id),
  CONSTRAINT member_memberships_tier_fk
    FOREIGN KEY (org_id, tier_id) REFERENCES member_tiers (org_id, id),
  CONSTRAINT member_memberships_store_fk
    FOREIGN KEY (org_id, updated_store_id) REFERENCES stores (org_id, id),
  CONSTRAINT member_memberships_staff_fk
    FOREIGN KEY (org_id, updated_by_staff_id) REFERENCES staffs (org_id, id),
  CONSTRAINT member_memberships_version_chk CHECK (version > 0),
  CONSTRAINT member_memberships_reason_chk
    CHECK (char_length(btrim(reason)) BETWEEN 1 AND 256),
  CONSTRAINT member_memberships_tier_shape_chk CHECK (
    (
      tier_id IS NULL
      AND tier_code IS NULL
      AND tier_name IS NULL
      AND tier_level IS NULL
      AND valid_until IS NULL
    )
    OR
    (
      tier_id IS NOT NULL
      AND tier_code IS NOT NULL
      AND tier_code ~ '^[a-z][a-z0-9_-]{0,31}$'
      AND tier_name IS NOT NULL
      AND char_length(btrim(tier_name)) BETWEEN 1 AND 64
      AND tier_level IS NOT NULL
      AND tier_level BETWEEN 1 AND 99
      AND valid_until IS NOT NULL
    )
  )
);

CREATE TABLE IF NOT EXISTS points_ledger (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  account_id uuid NOT NULL,
  kind text NOT NULL,
  points_delta bigint NOT NULL,
  order_id uuid,
  policy_id uuid,
  source_paid_cents integer,
  policy_unit_cents integer,
  policy_points_per_unit integer,
  expires_on date,
  staff_id uuid NOT NULL,
  at timestamptz NOT NULL,
  note text,
  CONSTRAINT points_ledger_tenant_id_uidx UNIQUE (org_id, id),
  CONSTRAINT points_ledger_account_fk
    FOREIGN KEY (org_id, account_id) REFERENCES member_accounts (org_id, id),
  CONSTRAINT points_ledger_store_fk
    FOREIGN KEY (org_id, store_id) REFERENCES stores (org_id, id),
  CONSTRAINT points_ledger_order_fk
    FOREIGN KEY (org_id, store_id, order_id) REFERENCES orders (org_id, store_id, id),
  CONSTRAINT points_ledger_policy_fk
    FOREIGN KEY (org_id, policy_id) REFERENCES member_points_policies (org_id, id),
  CONSTRAINT points_ledger_staff_fk
    FOREIGN KEY (org_id, staff_id) REFERENCES staffs (org_id, id),
  CONSTRAINT points_ledger_kind_chk CHECK (kind IN ('earn', 'redeem')),
  CONSTRAINT points_ledger_note_chk CHECK (note IS NULL OR char_length(note) <= 256),
  CONSTRAINT points_ledger_shape_chk CHECK (
    (
      kind = 'earn'
      AND points_delta > 0
      AND order_id IS NOT NULL
      AND policy_id IS NOT NULL
      AND source_paid_cents IS NOT NULL
      AND source_paid_cents >= 0
      AND policy_unit_cents IS NOT NULL
      AND policy_unit_cents BETWEEN 1 AND 5000000
      AND policy_points_per_unit IS NOT NULL
      AND policy_points_per_unit BETWEEN 1 AND 100000
      AND expires_on IS NOT NULL
    )
    OR
    (
      kind = 'redeem'
      AND points_delta < 0
      AND order_id IS NULL
      AND policy_id IS NULL
      AND source_paid_cents IS NULL
      AND policy_unit_cents IS NULL
      AND policy_points_per_unit IS NULL
      AND expires_on IS NULL
      AND note IS NOT NULL
      AND char_length(btrim(note)) BETWEEN 1 AND 256
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS points_ledger_order_earn_uidx
  ON points_ledger (org_id, order_id)
  WHERE kind = 'earn';
CREATE INDEX IF NOT EXISTS points_ledger_account_expiry_idx
  ON points_ledger (org_id, account_id, expires_on, at, id)
  WHERE kind = 'earn';
CREATE INDEX IF NOT EXISTS points_ledger_account_recent_idx
  ON points_ledger (org_id, account_id, at DESC, id DESC);

-- A redeem debit allocates against one or more earn credits. Both tables are
-- append-only; available points are credits not yet allocated and not expired.
CREATE TABLE IF NOT EXISTS points_allocations (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  redeem_ledger_id uuid NOT NULL,
  earn_ledger_id uuid NOT NULL,
  points integer NOT NULL,
  CONSTRAINT points_allocations_tenant_id_uidx UNIQUE (org_id, id),
  CONSTRAINT points_allocations_pair_uidx UNIQUE (org_id, redeem_ledger_id, earn_ledger_id),
  CONSTRAINT points_allocations_redeem_fk
    FOREIGN KEY (org_id, redeem_ledger_id) REFERENCES points_ledger (org_id, id),
  CONSTRAINT points_allocations_earn_fk
    FOREIGN KEY (org_id, earn_ledger_id) REFERENCES points_ledger (org_id, id),
  CONSTRAINT points_allocations_points_chk CHECK (points > 0),
  CONSTRAINT points_allocations_distinct_chk CHECK (redeem_ledger_id <> earn_ledger_id)
);

CREATE INDEX IF NOT EXISTS points_allocations_earn_idx
  ON points_allocations (org_id, earn_ledger_id);

CREATE TABLE IF NOT EXISTS punch_cards (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  account_id uuid NOT NULL,
  definition_id uuid NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  total_uses integer NOT NULL,
  issued_on date NOT NULL,
  expires_on date NOT NULL,
  issued_at timestamptz NOT NULL,
  issued_store_id uuid NOT NULL,
  issued_by_staff_id uuid NOT NULL,
  reason text NOT NULL,
  CONSTRAINT punch_cards_tenant_id_uidx UNIQUE (org_id, id),
  CONSTRAINT punch_cards_account_id_uidx UNIQUE (org_id, id, account_id),
  CONSTRAINT punch_cards_account_fk
    FOREIGN KEY (org_id, account_id) REFERENCES member_accounts (org_id, id),
  CONSTRAINT punch_cards_definition_fk
    FOREIGN KEY (org_id, definition_id) REFERENCES member_punch_types (org_id, id),
  CONSTRAINT punch_cards_store_fk
    FOREIGN KEY (org_id, issued_store_id) REFERENCES stores (org_id, id),
  CONSTRAINT punch_cards_staff_fk
    FOREIGN KEY (org_id, issued_by_staff_id) REFERENCES staffs (org_id, id),
  CONSTRAINT punch_cards_code_chk CHECK (code ~ '^[a-z][a-z0-9_-]{0,31}$'),
  CONSTRAINT punch_cards_name_chk CHECK (char_length(btrim(name)) BETWEEN 1 AND 64),
  CONSTRAINT punch_cards_uses_chk CHECK (total_uses BETWEEN 1 AND 999),
  CONSTRAINT punch_cards_expiry_chk CHECK (expires_on >= issued_on),
  CONSTRAINT punch_cards_reason_chk CHECK (char_length(btrim(reason)) BETWEEN 1 AND 256)
);

CREATE INDEX IF NOT EXISTS punch_cards_account_expiry_idx
  ON punch_cards (org_id, account_id, expires_on, issued_at DESC);

CREATE TABLE IF NOT EXISTS punch_card_ledger (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  card_id uuid NOT NULL,
  account_id uuid NOT NULL,
  uses integer NOT NULL,
  staff_id uuid NOT NULL,
  at timestamptz NOT NULL,
  reason text NOT NULL,
  CONSTRAINT punch_card_ledger_tenant_id_uidx UNIQUE (org_id, id),
  CONSTRAINT punch_card_ledger_card_fk
    FOREIGN KEY (org_id, card_id, account_id) REFERENCES punch_cards (org_id, id, account_id),
  CONSTRAINT punch_card_ledger_store_fk
    FOREIGN KEY (org_id, store_id) REFERENCES stores (org_id, id),
  CONSTRAINT punch_card_ledger_staff_fk
    FOREIGN KEY (org_id, staff_id) REFERENCES staffs (org_id, id),
  CONSTRAINT punch_card_ledger_uses_chk CHECK (uses BETWEEN 1 AND 100),
  CONSTRAINT punch_card_ledger_reason_chk CHECK (char_length(btrim(reason)) BETWEEN 1 AND 256)
);

CREATE INDEX IF NOT EXISTS punch_card_ledger_card_idx
  ON punch_card_ledger (org_id, card_id, at, id);

CREATE TABLE IF NOT EXISTS coupon_grants (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  account_id uuid NOT NULL,
  definition_id uuid NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  discount_cents integer NOT NULL,
  min_order_cents integer NOT NULL,
  granted_on date NOT NULL,
  expires_on date NOT NULL,
  granted_at timestamptz NOT NULL,
  granted_store_id uuid NOT NULL,
  granted_by_staff_id uuid NOT NULL,
  reason text NOT NULL,
  CONSTRAINT coupon_grants_tenant_id_uidx UNIQUE (org_id, id),
  CONSTRAINT coupon_grants_account_id_uidx UNIQUE (org_id, id, account_id),
  CONSTRAINT coupon_grants_account_fk
    FOREIGN KEY (org_id, account_id) REFERENCES member_accounts (org_id, id),
  CONSTRAINT coupon_grants_definition_fk
    FOREIGN KEY (org_id, definition_id) REFERENCES coupons (org_id, id),
  CONSTRAINT coupon_grants_store_fk
    FOREIGN KEY (org_id, granted_store_id) REFERENCES stores (org_id, id),
  CONSTRAINT coupon_grants_staff_fk
    FOREIGN KEY (org_id, granted_by_staff_id) REFERENCES staffs (org_id, id),
  CONSTRAINT coupon_grants_code_chk CHECK (code ~ '^[a-z][a-z0-9_-]{0,31}$'),
  CONSTRAINT coupon_grants_name_chk CHECK (char_length(btrim(name)) BETWEEN 1 AND 64),
  CONSTRAINT coupon_grants_discount_chk CHECK (discount_cents BETWEEN 1 AND 5000000),
  CONSTRAINT coupon_grants_minimum_chk CHECK (min_order_cents BETWEEN 0 AND 5000000),
  CONSTRAINT coupon_grants_expiry_chk CHECK (expires_on >= granted_on),
  CONSTRAINT coupon_grants_reason_chk CHECK (char_length(btrim(reason)) BETWEEN 1 AND 256)
);

CREATE INDEX IF NOT EXISTS coupon_grants_account_expiry_idx
  ON coupon_grants (org_id, account_id, expires_on, granted_at DESC);

CREATE TABLE IF NOT EXISTS coupon_redemptions (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  grant_id uuid NOT NULL,
  account_id uuid NOT NULL,
  order_id uuid NOT NULL,
  discount_cents integer NOT NULL,
  staff_id uuid NOT NULL,
  at timestamptz NOT NULL,
  CONSTRAINT coupon_redemptions_tenant_id_uidx UNIQUE (org_id, id),
  CONSTRAINT coupon_redemptions_reversal_target_uidx
    UNIQUE (org_id, id, store_id, grant_id, order_id),
  CONSTRAINT coupon_redemptions_order_uidx UNIQUE (org_id, store_id, order_id),
  CONSTRAINT coupon_redemptions_grant_fk
    FOREIGN KEY (org_id, grant_id, account_id) REFERENCES coupon_grants (org_id, id, account_id),
  CONSTRAINT coupon_redemptions_order_fk
    FOREIGN KEY (org_id, store_id, order_id) REFERENCES orders (org_id, store_id, id),
  CONSTRAINT coupon_redemptions_store_fk
    FOREIGN KEY (org_id, store_id) REFERENCES stores (org_id, id),
  CONSTRAINT coupon_redemptions_staff_fk
    FOREIGN KEY (org_id, staff_id) REFERENCES staffs (org_id, id),
  CONSTRAINT coupon_redemptions_discount_chk CHECK (discount_cents BETWEEN 1 AND 5000000)
);

CREATE INDEX IF NOT EXISTS coupon_redemptions_grant_idx
  ON coupon_redemptions (org_id, grant_id, at DESC);

-- Cancelling an order never mutates or deletes its coupon redemption. A
-- single append-only reversal returns the grant to the active pool while
-- retaining the exact redemption/order evidence.
CREATE TABLE IF NOT EXISTS coupon_redemption_reversals (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  redemption_id uuid NOT NULL,
  grant_id uuid NOT NULL,
  order_id uuid NOT NULL,
  staff_id uuid NOT NULL,
  at timestamptz NOT NULL,
  reason text NOT NULL,
  CONSTRAINT coupon_redemption_reversals_tenant_id_uidx UNIQUE (org_id, id),
  CONSTRAINT coupon_redemption_reversals_redemption_uidx UNIQUE (org_id, redemption_id),
  CONSTRAINT coupon_redemption_reversals_redemption_fk
    FOREIGN KEY (org_id, redemption_id, store_id, grant_id, order_id)
    REFERENCES coupon_redemptions (org_id, id, store_id, grant_id, order_id),
  CONSTRAINT coupon_redemption_reversals_staff_fk
    FOREIGN KEY (org_id, staff_id) REFERENCES staffs (org_id, id),
  CONSTRAINT coupon_redemption_reversals_reason_chk
    CHECK (char_length(btrim(reason)) BETWEEN 1 AND 256)
);

-- All new resources are organisation-scoped even when a store is recorded for
-- attribution. This matches the organisation-wide member account.
ALTER TABLE member_tiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_tiers FORCE ROW LEVEL SECURITY;
ALTER TABLE member_points_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_points_policies FORCE ROW LEVEL SECURITY;
ALTER TABLE member_punch_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_punch_types FORCE ROW LEVEL SECURITY;
ALTER TABLE coupons ENABLE ROW LEVEL SECURITY;
ALTER TABLE coupons FORCE ROW LEVEL SECURITY;
ALTER TABLE member_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE points_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE points_ledger FORCE ROW LEVEL SECURITY;
ALTER TABLE points_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE points_allocations FORCE ROW LEVEL SECURITY;
ALTER TABLE punch_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE punch_cards FORCE ROW LEVEL SECURITY;
ALTER TABLE punch_card_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE punch_card_ledger FORCE ROW LEVEL SECURITY;
ALTER TABLE coupon_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE coupon_grants FORCE ROW LEVEL SECURITY;
ALTER TABLE coupon_redemptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE coupon_redemptions FORCE ROW LEVEL SECURITY;
ALTER TABLE coupon_redemption_reversals ENABLE ROW LEVEL SECURITY;
ALTER TABLE coupon_redemption_reversals FORCE ROW LEVEL SECURITY;

DO $policy$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'member_tiers',
    'member_points_policies',
    'member_punch_types',
    'coupons',
    'member_memberships',
    'points_ledger',
    'points_allocations',
    'punch_cards',
    'punch_card_ledger',
    'coupon_grants',
    'coupon_redemptions',
    'coupon_redemption_reversals'
  ]
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', table_name || '_org_scope', table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', table_name || '_maintenance', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO laundry_app '
      || 'USING (org_id = NULLIF(current_setting(''app.org_id'', true), '''')::uuid) '
      || 'WITH CHECK (org_id = NULLIF(current_setting(''app.org_id'', true), '''')::uuid)',
      table_name || '_org_scope',
      table_name
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO laundry_owner USING (true) WITH CHECK (true)',
      table_name || '_maintenance',
      table_name
    );
  END LOOP;
END
$policy$;

-- Definitions and the one membership projection are versioned configuration.
GRANT SELECT, INSERT, UPDATE ON TABLE
  member_tiers,
  member_points_policies,
  member_punch_types,
  coupons,
  member_memberships
TO laundry_app;

-- Credits, grants, consumes, allocations and redemptions are append-only.
GRANT SELECT, INSERT ON TABLE
  points_ledger,
  points_allocations,
  punch_cards,
  punch_card_ledger,
  coupon_grants,
  coupon_redemptions,
  coupon_redemption_reversals
TO laundry_app;

REVOKE DELETE, TRUNCATE ON TABLE
  member_tiers,
  member_points_policies,
  member_punch_types,
  coupons,
  member_memberships
FROM laundry_app;

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE
  points_ledger,
  points_allocations,
  punch_cards,
  punch_card_ledger,
  coupon_grants,
  coupon_redemptions,
  coupon_redemption_reversals
FROM laundry_app;
