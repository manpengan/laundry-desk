-- ADR-24: bounded dual-basis accounting reports read immutable ledgers by the
-- server-injected tenant/store, business-date range, and optional staff.

CREATE INDEX IF NOT EXISTS payments_accounting_report_idx
  ON public.payments (org_id, store_id, business_date, staff_id, method, kind);

CREATE INDEX IF NOT EXISTS member_ledger_accounting_report_idx
  ON public.member_ledger (org_id, store_id, business_date, staff_id, tender)
  WHERE tender IS NOT NULL;
