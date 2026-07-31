-- Expand-only: ADR-17 member stored value.
-- member_accounts is org-scoped like customers (0011): a member tops up at one
-- store and spends at another within the same org, so store-scoped RLS would
-- make the balance read short and the projection wrong.
-- member_ledger is append-only with the same posture as payments (0009):
-- SELECT + INSERT only for laundry_app, corrections are reversal rows.
-- There is deliberately NO balance column: the balance is SUM(delta) so it is
-- always self-provable from the ledger and cannot drift.

CREATE TABLE IF NOT EXISTS member_accounts (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active',
  opened_at timestamptz NOT NULL,
  opened_store_id uuid NOT NULL,
  CONSTRAINT member_accounts_tenant_id_uidx UNIQUE (org_id, id),
  -- One account per customer. This is what makes account.open idempotent.
  CONSTRAINT member_accounts_customer_uidx UNIQUE (org_id, customer_id),
  CONSTRAINT member_accounts_customer_fk
    FOREIGN KEY (org_id, customer_id) REFERENCES customers (org_id, id),
  CONSTRAINT member_accounts_store_fk
    FOREIGN KEY (org_id, opened_store_id) REFERENCES stores (org_id, id),
  CONSTRAINT member_accounts_status_chk CHECK (status IN ('active', 'frozen'))
);

CREATE INDEX IF NOT EXISTS member_accounts_org_customer_idx
  ON member_accounts (org_id, customer_id);

CREATE SEQUENCE IF NOT EXISTS public.member_ledger_seq_seq
  AS bigint
  START WITH 1
  INCREMENT BY 1
  MINVALUE 1
  NO MAXVALUE
  CACHE 1
  NO CYCLE;

CREATE TABLE IF NOT EXISTS member_ledger (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  -- Which store the money moved at. The row is readable org-wide (see the
  -- policy below); this column is attribution, not a tenancy boundary.
  store_id uuid NOT NULL,
  account_id uuid NOT NULL,
  kind text NOT NULL,
  -- Signed deltas so the balance is a plain SUM. Positive on topup, negative on
  -- spend, either sign on reversal. A "positive amount + kind" shape would push
  -- a CASE expression into every balance query, and one missed branch there is
  -- a wrong balance.
  principal_delta_cents integer NOT NULL,
  -- Always 0 in the first slice. Split from day one because refund rules
  -- commonly treat principal and bonus differently, and an append-only ledger
  -- cannot be retro-split once it holds history.
  bonus_delta_cents integer NOT NULL DEFAULT 0,
  -- Set when the movement settles an order (kind = 'pay').
  order_id uuid,
  -- Set when this row reverses an earlier row (kind = 'reversal').
  ref_ledger_id uuid,
  staff_id uuid NOT NULL,
  at timestamptz NOT NULL,
  business_date text NOT NULL,
  note text,
  ledger_seq bigint NOT NULL DEFAULT nextval('public.member_ledger_seq_seq'::regclass),
  CONSTRAINT member_ledger_tenant_id_uidx UNIQUE (org_id, id),
  CONSTRAINT member_ledger_account_fk
    FOREIGN KEY (org_id, account_id) REFERENCES member_accounts (org_id, id),
  CONSTRAINT member_ledger_store_fk
    FOREIGN KEY (org_id, store_id) REFERENCES stores (org_id, id),
  CONSTRAINT member_ledger_order_fk
    FOREIGN KEY (org_id, store_id, order_id)
    REFERENCES orders (org_id, store_id, id),
  CONSTRAINT member_ledger_ref_fk
    FOREIGN KEY (org_id, ref_ledger_id) REFERENCES member_ledger (org_id, id),
  CONSTRAINT member_ledger_staff_fk
    FOREIGN KEY (org_id, staff_id) REFERENCES staffs (org_id, id),
  CONSTRAINT member_ledger_kind_chk CHECK (kind IN ('topup', 'pay', 'reversal')),
  -- Sign must match the kind, so a wrong-signed insert cannot quietly move the
  -- balance the wrong way.
  CONSTRAINT member_ledger_topup_sign_chk CHECK (
    kind <> 'topup'
      OR (principal_delta_cents >= 0 AND bonus_delta_cents >= 0
        AND principal_delta_cents + bonus_delta_cents > 0)
  ),
  CONSTRAINT member_ledger_pay_sign_chk CHECK (
    kind <> 'pay'
      OR (principal_delta_cents <= 0 AND bonus_delta_cents <= 0
        AND principal_delta_cents + bonus_delta_cents < 0)
  ),
  -- A spend must name the order it settled; a reversal must name its origin.
  CONSTRAINT member_ledger_pay_order_chk CHECK (kind <> 'pay' OR order_id IS NOT NULL),
  CONSTRAINT member_ledger_reversal_ref_chk CHECK (
    kind <> 'reversal' OR ref_ledger_id IS NOT NULL
  ),
  CONSTRAINT member_ledger_business_date_chk CHECK (business_date ~ '^\d{4}-\d{2}-\d{2}$')
);

CREATE INDEX IF NOT EXISTS member_ledger_account_seq_idx
  ON member_ledger (org_id, account_id, ledger_seq);
CREATE INDEX IF NOT EXISTS member_ledger_store_at_idx
  ON member_ledger (org_id, store_id, at);
CREATE UNIQUE INDEX IF NOT EXISTS member_ledger_seq_uidx
  ON member_ledger (ledger_seq);

ALTER SEQUENCE public.member_ledger_seq_seq
  OWNED BY public.member_ledger.ledger_seq;

ALTER TABLE "public"."member_accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."member_accounts" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "member_accounts_org_scope" ON "public"."member_accounts";
CREATE POLICY "member_accounts_org_scope" ON "public"."member_accounts"
  AS PERMISSIVE
  FOR ALL
  TO "laundry_app"
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

DROP POLICY IF EXISTS "member_accounts_maintenance" ON "public"."member_accounts";
CREATE POLICY "member_accounts_maintenance" ON "public"."member_accounts"
  AS PERMISSIVE
  FOR ALL
  TO "laundry_owner"
  USING (true)
  WITH CHECK (true);

ALTER TABLE "public"."member_ledger" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."member_ledger" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "member_ledger_org_scope" ON "public"."member_ledger";
CREATE POLICY "member_ledger_org_scope" ON "public"."member_ledger"
  AS PERMISSIVE
  FOR ALL
  TO "laundry_app"
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

DROP POLICY IF EXISTS "member_ledger_maintenance" ON "public"."member_ledger";
CREATE POLICY "member_ledger_maintenance" ON "public"."member_ledger"
  AS PERMISSIVE
  FOR ALL
  TO "laundry_owner"
  USING (true)
  WITH CHECK (true);

-- Accounts need UPDATE for status changes and for customer.merge to retarget a
-- surviving customer_id. No DELETE: closing an account must keep its ledger.
GRANT SELECT, INSERT, UPDATE ON TABLE member_accounts TO laundry_app;

-- Append-only for the app role: no UPDATE/DELETE (anti-tamper via privileges).
GRANT SELECT, INSERT ON TABLE member_ledger TO laundry_app;

-- nextval/currval only: the runtime cannot setval or alter the sequence.
REVOKE ALL ON SEQUENCE public.member_ledger_seq_seq FROM PUBLIC, laundry_app;
GRANT USAGE ON SEQUENCE public.member_ledger_seq_seq TO laundry_app;

-- ADR-17 §6: a balance settlement is a payment against the order, so it lands in
-- payments and keeps a single source of truth for "what the order collected".
-- One line on purpose: the expand-only guard matches whole statements per line,
-- and only this exact (table, constraint) pair is exempted. Broadening a CHECK
-- accepts more values and removes no row.
ALTER TABLE public.payments DROP CONSTRAINT IF EXISTS payments_method_chk;
ALTER TABLE public.payments
  ADD CONSTRAINT payments_method_chk
  CHECK (method IN ('cash', 'wechat', 'alipay', 'other', 'balance'));
