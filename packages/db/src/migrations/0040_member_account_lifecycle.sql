-- ADR-25: member-account freeze, unfreeze and terminal close.
--
-- Existing accounts predate lifecycle evidence, so the four status-change
-- evidence columns are nullable as one group. Every lifecycle write fills all
-- four columns; audit_log remains the immutable event history.

ALTER TABLE member_accounts
  ADD COLUMN IF NOT EXISTS status_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS status_changed_at timestamptz,
  ADD COLUMN IF NOT EXISTS status_reason text,
  ADD COLUMN IF NOT EXISTS status_changed_by_staff_id uuid,
  ADD COLUMN IF NOT EXISTS status_changed_store_id uuid;

ALTER TABLE member_accounts
  ADD CONSTRAINT member_accounts_status_version_chk CHECK (status_version > 0),
  ADD CONSTRAINT member_accounts_status_reason_chk CHECK (
    status_reason IS NULL
      OR (char_length(btrim(status_reason)) BETWEEN 1 AND 256)
  ),
  ADD CONSTRAINT member_accounts_status_evidence_chk CHECK (
    (
      status_changed_at IS NULL
      AND status_reason IS NULL
      AND status_changed_by_staff_id IS NULL
      AND status_changed_store_id IS NULL
    )
    OR
    (
      status_changed_at IS NOT NULL
      AND status_reason IS NOT NULL
      AND status_changed_by_staff_id IS NOT NULL
      AND status_changed_store_id IS NOT NULL
    )
  ),
  ADD CONSTRAINT member_accounts_status_staff_fk
    FOREIGN KEY (org_id, status_changed_by_staff_id) REFERENCES staffs (org_id, id),
  ADD CONSTRAINT member_accounts_status_store_fk
    FOREIGN KEY (org_id, status_changed_store_id) REFERENCES stores (org_id, id);

-- A close writes exactly one row per balance component. The projected balance
-- may be any JavaScript safe integer accumulated across many rows, so the old
-- int4 columns would reject a valid single settlement above 2^31-1.
ALTER TABLE member_ledger
  ALTER COLUMN principal_delta_cents TYPE bigint
    USING principal_delta_cents::bigint,
  ALTER COLUMN bonus_delta_cents TYPE bigint
    USING bonus_delta_cents::bigint;

-- `closed` is terminal in the domain state machine. PostgreSQL CHECKs the
-- persisted vocabulary; the account row lock + expected status/version enforce
-- the transition graph without placing business reads in a trigger.
ALTER TABLE member_accounts DROP CONSTRAINT IF EXISTS member_accounts_status_chk;
ALTER TABLE member_accounts
  ADD CONSTRAINT member_accounts_status_chk
    CHECK (status IN ('active', 'frozen', 'closed'));

-- Closing never edits old money rows. Remaining principal is returned with the
-- existing `refund` kind and remaining bonus is removed with one append-only
-- `bonus_forfeit` row.
ALTER TABLE member_ledger DROP CONSTRAINT IF EXISTS member_ledger_kind_chk;
ALTER TABLE member_ledger
  ADD CONSTRAINT member_ledger_kind_chk
    CHECK (kind IN ('topup', 'pay', 'reversal', 'refund', 'bonus_forfeit'));

-- Mechanical shape guarantee for closure forfeiture. The amount must only
-- remove bonus and may not masquerade as cash, an order settlement, a reversal,
-- or a top-up tier grant.
ALTER TABLE member_ledger
  ADD CONSTRAINT member_ledger_bonus_forfeit_shape_chk CHECK (
    kind <> 'bonus_forfeit'
      OR (
        principal_delta_cents = 0
        AND bonus_delta_cents < 0
        AND order_id IS NULL
        AND ref_ledger_id IS NULL
        AND tender IS NULL
        AND bonus_rule_id IS NULL
      )
  );
