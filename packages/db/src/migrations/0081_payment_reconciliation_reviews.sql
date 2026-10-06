-- ADR-93: review annotations do not change the original bill or any money ledger.
ALTER TABLE public.payment_channel_reconciliations
  ADD CONSTRAINT payment_channel_reconciliations_tenant_id_key UNIQUE(org_id,store_id,id);

CREATE TABLE public.payment_channel_reconciliation_reviews (
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  reconciliation_id uuid NOT NULL,
  mismatch_index integer NOT NULL CHECK(mismatch_index BETWEEN 0 AND 9999),
  state text NOT NULL CHECK(state IN ('open','investigating','resolved')),
  note text NOT NULL CHECK(length(btrim(note)) BETWEEN 1 AND 1000),
  version integer NOT NULL CHECK(version > 0),
  actor_id uuid NOT NULL,
  at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY(org_id,store_id,reconciliation_id,mismatch_index),
  FOREIGN KEY(org_id,store_id,reconciliation_id)
    REFERENCES public.payment_channel_reconciliations(org_id,store_id,id),
  FOREIGN KEY(org_id,actor_id) REFERENCES public.staffs(org_id,id)
);
CREATE INDEX payment_channel_reconciliation_reviews_actor_idx
  ON public.payment_channel_reconciliation_reviews(org_id,actor_id);
ALTER TABLE public.payment_channel_reconciliation_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_channel_reconciliation_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY reconciliation_reviews_owner ON public.payment_channel_reconciliation_reviews
  FOR ALL TO laundry_owner USING(true) WITH CHECK(true);
CREATE POLICY reconciliation_reviews_tenant ON public.payment_channel_reconciliation_reviews
  FOR ALL TO laundry_app
  USING(org_id=NULLIF(current_setting('app.org_id',true),'')::uuid
    AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid)
  WITH CHECK(org_id=NULLIF(current_setting('app.org_id',true),'')::uuid
    AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid);
REVOKE ALL ON public.payment_channel_reconciliation_reviews FROM PUBLIC,laundry_app;
GRANT SELECT,INSERT ON public.payment_channel_reconciliation_reviews TO laundry_app;
GRANT UPDATE(state,note,version,actor_id,at) ON public.payment_channel_reconciliation_reviews TO laundry_app;
GRANT SELECT(org_id,store_id,reconciliation_id,mismatch_index,state,note,version,actor_id,at)
  ON public.payment_channel_reconciliation_reviews TO laundry_store_exporter;
CREATE POLICY reconciliation_reviews_export ON public.payment_channel_reconciliation_reviews
  FOR SELECT TO laundry_store_exporter
  USING(org_id=NULLIF(current_setting('app.org_id',true),'')::uuid
    AND store_id=NULLIF(current_setting('app.store_id',true),'')::uuid);

CREATE INDEX payment_channel_reconciliations_history_idx
  ON public.payment_channel_reconciliations(org_id,store_id,business_date DESC,at DESC,id DESC);
