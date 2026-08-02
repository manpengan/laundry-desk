-- ADR-22 §2, §3: top-up bonus tiers, and the tier snapshot on the ledger row.
--
-- Tiers rather than percentages (ADR-22 §2): a tier is integer fen by
-- construction, so no rounding rule has to be invented and later argued about
-- at reconciliation.

CREATE TABLE IF NOT EXISTS member_bonus_rules (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  -- Organisation-wide, matching member_accounts: the balance itself is usable
  -- at every store (ADR-17 §2), so a per-store tier would mean topping up 1000
  -- grants different money at two shops that share one wallet.
  min_topup_cents integer NOT NULL,
  bonus_cents integer NOT NULL,
  status text NOT NULL,
  effective_from timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  updated_by_staff_id uuid NOT NULL,
  note text,
  CONSTRAINT member_bonus_rules_tenant_id_uidx UNIQUE (org_id, id),
  CONSTRAINT member_bonus_rules_org_fk FOREIGN KEY (org_id) REFERENCES orgs (id),
  CONSTRAINT member_bonus_rules_staff_fk
    FOREIGN KEY (org_id, updated_by_staff_id) REFERENCES staffs (org_id, id),
  CONSTRAINT member_bonus_rules_status_chk CHECK (status IN ('active', 'retired')),
  -- A threshold of 0 would fire on every top-up including the smallest, which is
  -- a giveaway nobody configures on purpose.
  CONSTRAINT member_bonus_rules_threshold_chk CHECK (min_topup_cents > 0),
  -- 0 is legal: it switches a tier off without retiring it, and the ledger still
  -- records which rule applied.
  CONSTRAINT member_bonus_rules_bonus_chk CHECK (bonus_cents >= 0)
);

-- The match reads active tiers at or below the amount, highest first.
CREATE INDEX IF NOT EXISTS member_bonus_rules_active_idx
  ON member_bonus_rules (org_id, min_topup_cents DESC)
  WHERE status = 'active';

ALTER TABLE member_bonus_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_bonus_rules FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS member_bonus_rules_org_scope ON member_bonus_rules;
CREATE POLICY member_bonus_rules_org_scope ON member_bonus_rules
  FOR ALL
  TO laundry_app
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

-- Rules are maintained in place, unlike the ledger: retiring a tier is an
-- UPDATE of status, not a new row, because a tier is configuration and not a
-- money movement. The ledger keeps the history that matters (see below).
GRANT SELECT, INSERT, UPDATE ON TABLE member_bonus_rules TO laundry_app;

-- Which tier granted the bonus on this top-up. Snapshotted like an order's price
-- so repricing or retiring a tier never re-values a top-up that already happened
-- (ADR-22 §3.3). Nullable: no tier matched, or the row predates 0036.
ALTER TABLE member_ledger
  ADD COLUMN IF NOT EXISTS bonus_rule_id uuid;

ALTER TABLE member_ledger
  ADD CONSTRAINT member_ledger_bonus_rule_fk
    FOREIGN KEY (org_id, bonus_rule_id) REFERENCES member_bonus_rules (org_id, id);

-- Only a top-up can cite a tier. A settlement or a reversal carrying one would
-- imply a bonus was granted at spend time, which no path does.
ALTER TABLE member_ledger
  ADD CONSTRAINT member_ledger_bonus_rule_kind_chk CHECK (
    bonus_rule_id IS NULL OR kind = 'topup'
  );
