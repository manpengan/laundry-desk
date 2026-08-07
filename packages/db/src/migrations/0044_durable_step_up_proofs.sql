-- Durable two-person step-up authority (ADR-05 / local-first product design §6.2).
-- Consumption joins the command transaction so a failed business mutation or
-- audit write cannot burn the proof independently.

CREATE UNIQUE INDEX IF NOT EXISTS ai_pending_actions_tenant_nonce_uidx
  ON ai_pending_actions (org_id, store_id, nonce);

CREATE TABLE IF NOT EXISTS step_up_proofs (
  proof_id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  pending_action_ref uuid NOT NULL,
  args_hash char(64) NOT NULL,
  entity_versions_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  idempotency_key uuid NOT NULL,
  requester_staff_id uuid NOT NULL,
  approver_staff_id uuid NOT NULL,
  session_id uuid NOT NULL,
  session_version integer NOT NULL,
  issued_at_epoch bigint NOT NULL,
  expires_at_epoch bigint NOT NULL,
  status text NOT NULL DEFAULT 'active',
  consumed_at_epoch bigint,
  CONSTRAINT step_up_proofs_store_fk
    FOREIGN KEY (org_id, store_id) REFERENCES stores (org_id, id),
  CONSTRAINT step_up_proofs_pending_fk
    FOREIGN KEY (org_id, store_id, pending_action_ref)
      REFERENCES ai_pending_actions (org_id, store_id, nonce) ON DELETE CASCADE,
  CONSTRAINT step_up_proofs_requester_fk
    FOREIGN KEY (org_id, requester_staff_id) REFERENCES staffs (org_id, id),
  CONSTRAINT step_up_proofs_approver_fk
    FOREIGN KEY (org_id, approver_staff_id) REFERENCES staffs (org_id, id),
  CONSTRAINT step_up_proofs_session_fk
    FOREIGN KEY (org_id, store_id, session_id) REFERENCES sessions (org_id, store_id, id),
  CONSTRAINT step_up_proofs_hash_chk CHECK (args_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT step_up_proofs_entity_versions_chk
    CHECK (jsonb_typeof(entity_versions_json) = 'array'),
  CONSTRAINT step_up_proofs_session_version_chk CHECK (session_version > 0),
  CONSTRAINT step_up_proofs_expiry_chk CHECK (expires_at_epoch > issued_at_epoch),
  CONSTRAINT step_up_proofs_approver_chk CHECK (requester_staff_id <> approver_staff_id),
  CONSTRAINT step_up_proofs_status_chk CHECK (status IN ('active', 'consumed')),
  CONSTRAINT step_up_proofs_consumption_chk CHECK (
    (status = 'consumed' AND consumed_at_epoch IS NOT NULL)
    OR (status = 'active' AND consumed_at_epoch IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS step_up_proofs_pending_active_idx
  ON step_up_proofs (org_id, store_id, pending_action_ref, issued_at_epoch DESC)
  WHERE status = 'active';

-- Referential actions must also find consumed proofs. The active-only lookup
-- index above cannot support the parent retention DELETE's ON DELETE CASCADE.
CREATE INDEX IF NOT EXISTS step_up_proofs_pending_fk_idx
  ON step_up_proofs (org_id, store_id, pending_action_ref);

CREATE INDEX IF NOT EXISTS step_up_proofs_requester_staff_idx
  ON step_up_proofs (org_id, requester_staff_id);

CREATE INDEX IF NOT EXISTS step_up_proofs_approver_staff_idx
  ON step_up_proofs (org_id, approver_staff_id);

CREATE INDEX IF NOT EXISTS step_up_proofs_session_idx
  ON step_up_proofs (org_id, store_id, session_id);

ALTER TABLE "public"."step_up_proofs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."step_up_proofs" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "step_up_proofs_store_scope" ON "public"."step_up_proofs";
CREATE POLICY "step_up_proofs_store_scope" ON "public"."step_up_proofs"
  AS PERMISSIVE
  FOR ALL
  TO "laundry_app"
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid);

DROP POLICY IF EXISTS "step_up_proofs_maintenance" ON "public"."step_up_proofs";
CREATE POLICY "step_up_proofs_maintenance" ON "public"."step_up_proofs"
  AS PERMISSIVE
  FOR ALL
  TO "laundry_owner"
  USING (true)
  WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE ON TABLE step_up_proofs TO laundry_app;
