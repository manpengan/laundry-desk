-- Durable WYSIWYS confirmation authority (ADR-05 / local-first product design §6.2).
-- The runtime inserts and consumes these rows inside the existing command
-- transaction so card state, business ledgers and audit evidence cannot split.

CREATE TABLE IF NOT EXISTS ai_pending_actions (
  nonce uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  command text NOT NULL,
  command_version text NOT NULL,
  args_json jsonb NOT NULL,
  authority_json jsonb,
  authority_present boolean NOT NULL DEFAULT false,
  args_hash char(64) NOT NULL,
  entity_versions_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  creator_staff_id uuid NOT NULL,
  idempotency_key uuid NOT NULL,
  created_at_epoch bigint NOT NULL,
  expires_at_epoch bigint NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  effective_risk text NOT NULL,
  policy_outcome text NOT NULL,
  requires_other_approver boolean NOT NULL,
  consumed_by_staff_id uuid,
  consumed_at_epoch bigint,
  CONSTRAINT ai_pending_actions_store_fk
    FOREIGN KEY (org_id, store_id) REFERENCES stores (org_id, id),
  CONSTRAINT ai_pending_actions_creator_fk
    FOREIGN KEY (org_id, creator_staff_id) REFERENCES staffs (org_id, id),
  CONSTRAINT ai_pending_actions_consumer_fk
    FOREIGN KEY (org_id, consumed_by_staff_id) REFERENCES staffs (org_id, id),
  CONSTRAINT ai_pending_actions_hash_chk CHECK (args_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ai_pending_actions_entity_versions_chk
    CHECK (jsonb_typeof(entity_versions_json) = 'array'),
  CONSTRAINT ai_pending_actions_authority_chk CHECK (
    authority_present OR authority_json IS NULL
  ),
  CONSTRAINT ai_pending_actions_expiry_chk CHECK (expires_at_epoch > created_at_epoch),
  CONSTRAINT ai_pending_actions_status_chk
    CHECK (status IN ('pending', 'consumed', 'expired', 'denied')),
  CONSTRAINT ai_pending_actions_risk_chk
    CHECK (effective_risk IN ('R0', 'R1', 'R2', 'R3', 'R4', 'R5')),
  CONSTRAINT ai_pending_actions_policy_outcome_chk
    CHECK (policy_outcome IN ('confirm', 'step_up')),
  CONSTRAINT ai_pending_actions_consumption_chk CHECK (
    (status = 'consumed' AND consumed_by_staff_id IS NOT NULL AND consumed_at_epoch IS NOT NULL)
    OR (status <> 'consumed' AND consumed_by_staff_id IS NULL AND consumed_at_epoch IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS ai_pending_actions_store_expiry_idx
  ON ai_pending_actions (org_id, store_id, status, expires_at_epoch);

-- PostgreSQL does not automatically index referencing columns. These indexes
-- keep staff deletion/governance checks bounded without broad table scans.
CREATE INDEX IF NOT EXISTS ai_pending_actions_creator_staff_idx
  ON ai_pending_actions (org_id, creator_staff_id);

CREATE INDEX IF NOT EXISTS ai_pending_actions_consumer_staff_idx
  ON ai_pending_actions (org_id, consumed_by_staff_id)
  WHERE consumed_by_staff_id IS NOT NULL;

ALTER TABLE "public"."ai_pending_actions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."ai_pending_actions" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ai_pending_actions_store_scope" ON "public"."ai_pending_actions";
CREATE POLICY "ai_pending_actions_store_scope" ON "public"."ai_pending_actions"
  AS PERMISSIVE
  FOR ALL
  TO "laundry_app"
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid);

DROP POLICY IF EXISTS "ai_pending_actions_maintenance" ON "public"."ai_pending_actions";
CREATE POLICY "ai_pending_actions_maintenance" ON "public"."ai_pending_actions"
  AS PERMISSIVE
  FOR ALL
  TO "laundry_owner"
  USING (true)
  WITH CHECK (true);

-- DELETE is limited by the same forced tenant/store RLS policy and is used only
-- by bounded, transaction-local retention cleanup in the PostgreSQL store.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ai_pending_actions TO laundry_app;
