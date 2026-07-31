-- Durable global ordering for the append-only payment ledger.
-- The migration runner wraps this file in one transaction, so ADD COLUMN keeps
-- its ACCESS EXCLUSIVE table lock through backfill, constraints, and grants.

CREATE SEQUENCE IF NOT EXISTS public.payments_ledger_seq_seq
  AS bigint
  START WITH 1
  INCREMENT BY 1
  MINVALUE 1
  NO MAXVALUE
  CACHE 1
  NO CYCLE;

ALTER SEQUENCE public.payments_ledger_seq_seq
  AS bigint
  INCREMENT BY 1
  MINVALUE 1
  NO MAXVALUE
  START WITH 1
  CACHE 1
  NO CYCLE;

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS ledger_seq bigint;

-- A fresh migration assigns 1..N in stable historical order. The max offset
-- also makes a retry safe if an operator previously stopped after a partial
-- manual application.
WITH ledger_floor AS (
  SELECT COALESCE(max(ledger_seq), 0::bigint) AS current_max
  FROM public.payments
),
ledger_backfill AS (
  SELECT
    payment.id,
    ledger_floor.current_max
      + row_number() OVER (ORDER BY payment.at, payment.id) AS ledger_seq
  FROM public.payments AS payment
  CROSS JOIN ledger_floor
  WHERE payment.ledger_seq IS NULL
)
UPDATE public.payments AS payment
SET ledger_seq = ledger_backfill.ledger_seq
FROM ledger_backfill
WHERE payment.id = ledger_backfill.id;

ALTER TABLE public.payments
  ALTER COLUMN ledger_seq
  SET DEFAULT nextval('public.payments_ledger_seq_seq'::regclass);

-- Empty tables must return 1 on the first nextval; populated tables must return
-- max(ledger_seq) + 1. Gaps from rollback or concurrent sequence allocation are
-- acceptable, but an allocated value is never reused by normal operation.
SELECT pg_catalog.setval(
  'public.payments_ledger_seq_seq'::regclass,
  COALESCE((SELECT max(ledger_seq) FROM public.payments), 1::bigint),
  EXISTS (SELECT 1 FROM public.payments)
);

ALTER TABLE public.payments
  ALTER COLUMN ledger_seq SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS payments_ledger_seq_uidx
  ON public.payments (ledger_seq);
CREATE INDEX IF NOT EXISTS payments_order_ledger_seq_idx
  ON public.payments (org_id, store_id, order_id, ledger_seq);

ALTER SEQUENCE public.payments_ledger_seq_seq
  OWNED BY public.payments.ledger_seq;

-- nextval/currval only: the runtime cannot setval or alter the sequence.
REVOKE ALL ON SEQUENCE public.payments_ledger_seq_seq FROM PUBLIC, laundry_app;
GRANT USAGE ON SEQUENCE public.payments_ledger_seq_seq TO laundry_app;
