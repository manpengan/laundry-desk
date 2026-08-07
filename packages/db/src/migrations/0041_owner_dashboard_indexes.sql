-- ADR-26: bounded tenant/store transition scan for the owner dashboard pickup card.
CREATE INDEX IF NOT EXISTS garment_status_log_store_transition_at_idx
  ON public.garment_status_log (org_id, store_id, to_status, at);
