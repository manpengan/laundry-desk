-- Expand-only: M2 BYOK credentials. API keys are envelope-encrypted in the
-- application before reaching this table; plaintext is never persisted.

CREATE TABLE IF NOT EXISTS ai_credentials (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  provider text NOT NULL,
  key_ciphertext text NOT NULL,
  key_nonce text NOT NULL,
  key_tag text NOT NULL,
  wrapped_dek text NOT NULL,
  dek_wrap_nonce text NOT NULL,
  dek_wrap_tag text NOT NULL,
  key_version text NOT NULL,
  last4 char(4) NOT NULL,
  status text NOT NULL DEFAULT 'unverified',
  created_by_staff_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz,
  CONSTRAINT ai_credentials_org_id_uidx UNIQUE (org_id, id),
  CONSTRAINT ai_credentials_provider_chk CHECK (provider IN ('openai')),
  CONSTRAINT ai_credentials_status_chk CHECK (status IN ('unverified', 'verified', 'invalid')),
  CONSTRAINT ai_credentials_key_version_chk CHECK (char_length(key_version) BETWEEN 1 AND 64),
  CONSTRAINT ai_credentials_last4_chk CHECK (char_length(last4) = 4),
  CONSTRAINT ai_credentials_staff_fk
    FOREIGN KEY (org_id, created_by_staff_id) REFERENCES staffs (org_id, id)
);

CREATE INDEX IF NOT EXISTS ai_credentials_org_created_idx
  ON ai_credentials (org_id, created_at ASC, id ASC);

CREATE TABLE IF NOT EXISTS ai_credential_events (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  store_id uuid NOT NULL,
  credential_id uuid NOT NULL,
  actor_staff_id uuid NOT NULL,
  action text NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_credential_events_tenant_id_uidx UNIQUE (org_id, store_id, id),
  CONSTRAINT ai_credential_events_credential_fk
    FOREIGN KEY (org_id, credential_id) REFERENCES ai_credentials (org_id, id),
  CONSTRAINT ai_credential_events_store_fk
    FOREIGN KEY (org_id, store_id) REFERENCES stores (org_id, id),
  CONSTRAINT ai_credential_events_staff_fk
    FOREIGN KEY (org_id, actor_staff_id) REFERENCES staffs (org_id, id),
  CONSTRAINT ai_credential_events_action_chk
    CHECK (action IN ('created', 'verification_succeeded', 'verification_failed')),
  CONSTRAINT ai_credential_events_status_chk CHECK (status IN ('unverified', 'verified', 'invalid'))
);

ALTER TABLE "public"."ai_credentials" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."ai_credentials" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ai_credentials_org_scope" ON "public"."ai_credentials";
CREATE POLICY "ai_credentials_org_scope" ON "public"."ai_credentials"
  AS PERMISSIVE
  FOR ALL
  TO "laundry_app"
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
DROP POLICY IF EXISTS "ai_credentials_maintenance" ON "public"."ai_credentials";
CREATE POLICY "ai_credentials_maintenance" ON "public"."ai_credentials"
  AS PERMISSIVE
  FOR ALL
  TO "laundry_owner"
  USING (true)
  WITH CHECK (true);

ALTER TABLE "public"."ai_credential_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."ai_credential_events" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ai_credential_events_store_scope" ON "public"."ai_credential_events";
CREATE POLICY "ai_credential_events_store_scope" ON "public"."ai_credential_events"
  AS PERMISSIVE
  FOR ALL
  TO "laundry_app"
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid);
DROP POLICY IF EXISTS "ai_credential_events_maintenance" ON "public"."ai_credential_events";
CREATE POLICY "ai_credential_events_maintenance" ON "public"."ai_credential_events"
  AS PERMISSIVE
  FOR ALL
  TO "laundry_owner"
  USING (true)
  WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE ON TABLE ai_credentials TO laundry_app;
GRANT SELECT, INSERT ON TABLE ai_credential_events TO laundry_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE ai_credential_events FROM laundry_app;
