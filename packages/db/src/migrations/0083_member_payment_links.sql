-- Balance payment/cancellation must preserve the original principal/bonus split.
-- Existing ledgers remain append-only; links carry verifiable cross-ledger identity.
CREATE TABLE public.member_payment_links (
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  payment_id uuid NOT NULL,
  ledger_id uuid NOT NULL,
  PRIMARY KEY (org_id, store_id, payment_id),
  UNIQUE (org_id, ledger_id),
  FOREIGN KEY (org_id, store_id, payment_id) REFERENCES payments (org_id, store_id, id),
  FOREIGN KEY (org_id, ledger_id) REFERENCES member_ledger (org_id, id)
);
ALTER TABLE public.member_payment_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_payment_links FORCE ROW LEVEL SECURITY;
CREATE POLICY member_payment_links_store ON public.member_payment_links TO laundry_app
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid);
CREATE POLICY member_payment_links_maintenance ON public.member_payment_links TO laundry_owner
  USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON public.member_payment_links TO laundry_app;
-- Whole-store export retains the opaque ledger linkage, scoped to the selected store.
GRANT SELECT (org_id, store_id, payment_id, ledger_id)
  ON public.member_payment_links TO laundry_store_exporter;
CREATE POLICY member_payment_links_export_reader ON public.member_payment_links
  FOR SELECT TO laundry_store_exporter
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid);

CREATE FUNCTION public.validate_member_payment_link() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.payments payment
    JOIN public.member_ledger ledger ON ledger.org_id = payment.org_id
      AND ledger.store_id = payment.store_id AND ledger.order_id = payment.order_id
    WHERE payment.org_id = NEW.org_id AND payment.store_id = NEW.store_id
      AND payment.id = NEW.payment_id AND ledger.id = NEW.ledger_id
      AND payment.method = 'balance' AND payment.kind = 'pay' AND ledger.kind = 'pay'
      AND payment.amount_cents = -(ledger.principal_delta_cents + ledger.bonus_delta_cents)
  ) THEN
    RAISE check_violation USING MESSAGE = 'MEMBER_PAYMENT_LINK_MISMATCH';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.validate_member_payment_link() FROM PUBLIC;
CREATE TRIGGER validate_member_payment_link BEFORE INSERT ON public.member_payment_links
  FOR EACH ROW EXECUTE FUNCTION public.validate_member_payment_link();

-- Recover only explicit immutable audit identity, never amount/date matching.
-- Multiple conflicting audited links remain unlinked and cancellation fails closed.
WITH candidates AS (
  SELECT DISTINCT ledger.org_id, ledger.store_id, payment.id AS payment_id, ledger.id AS ledger_id
  FROM audit_log audit
  JOIN member_ledger ledger ON ledger.org_id = audit.org_id AND ledger.store_id = audit.store_id
    AND ledger.id::text = audit.entity_id AND ledger.kind = 'pay'
  JOIN payments payment ON payment.org_id = ledger.org_id AND payment.store_id = ledger.store_id
    AND payment.order_id = ledger.order_id AND payment.method = 'balance' AND payment.kind = 'pay'
    AND payment.id::text = (audit.after_json::jsonb ->> 'payment_id')
    AND payment.amount_cents = -(ledger.principal_delta_cents + ledger.bonus_delta_cents)
  WHERE audit.command = 'member.balance.pay' AND audit.entity = 'member_ledger' AND NOT audit.dry_run
), unique_links AS (
  SELECT *, count(*) OVER (PARTITION BY org_id, store_id, payment_id) AS payment_count,
    count(*) OVER (PARTITION BY org_id, ledger_id) AS ledger_count
  FROM candidates
)
INSERT INTO member_payment_links (org_id, store_id, payment_id, ledger_id)
SELECT org_id, store_id, payment_id, ledger_id FROM unique_links
WHERE payment_count = 1 AND ledger_count = 1;

-- A payment debit can be returned only once, irrespective of command retry key.
CREATE UNIQUE INDEX member_order_reversal_once_idx ON member_ledger (org_id, ref_ledger_id)
  WHERE kind = 'reversal' AND order_id IS NOT NULL;
-- Legacy reversals may omit order_id; cancellation must find these without a tenant ledger scan.
CREATE INDEX member_reversal_reference_idx ON member_ledger (org_id, ref_ledger_id)
  WHERE kind = 'reversal';
CREATE INDEX member_order_payment_idx ON member_ledger (org_id, store_id, order_id, account_id)
  WHERE order_id IS NOT NULL;
