-- Expand-only RLS + grants for M1 tables.
-- Tenant predicates match @laundry/contracts A3 templates exactly.
-- audit_log: laundry_app gets INSERT + SELECT only (append-oriented; no UPDATE/DELETE/TRUNCATE).

-- ---------------------------------------------------------------------------
-- org-scope (stores, staffs, settings)
-- ---------------------------------------------------------------------------

ALTER TABLE "public"."stores" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."stores" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "stores_org_scope" ON "public"."stores";
CREATE POLICY "stores_org_scope" ON "public"."stores"
  AS PERMISSIVE
  FOR ALL
  TO "laundry_app"
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
DROP POLICY IF EXISTS "stores_maintenance" ON "public"."stores";
CREATE POLICY "stores_maintenance" ON "public"."stores"
  AS PERMISSIVE
  FOR ALL
  TO "laundry_owner"
  USING (true)
  WITH CHECK (true);

ALTER TABLE "public"."staffs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."staffs" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "staffs_org_scope" ON "public"."staffs";
CREATE POLICY "staffs_org_scope" ON "public"."staffs"
  AS PERMISSIVE
  FOR ALL
  TO "laundry_app"
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
DROP POLICY IF EXISTS "staffs_maintenance" ON "public"."staffs";
CREATE POLICY "staffs_maintenance" ON "public"."staffs"
  AS PERMISSIVE
  FOR ALL
  TO "laundry_owner"
  USING (true)
  WITH CHECK (true);

ALTER TABLE "public"."settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."settings" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "settings_org_scope" ON "public"."settings";
CREATE POLICY "settings_org_scope" ON "public"."settings"
  AS PERMISSIVE
  FOR ALL
  TO "laundry_app"
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
DROP POLICY IF EXISTS "settings_maintenance" ON "public"."settings";
CREATE POLICY "settings_maintenance" ON "public"."settings"
  AS PERMISSIVE
  FOR ALL
  TO "laundry_owner"
  USING (true)
  WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- store-scope matrix tables
-- ---------------------------------------------------------------------------

ALTER TABLE "public"."staff_store_roles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."staff_store_roles" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "staff_store_roles_store_scope" ON "public"."staff_store_roles";
CREATE POLICY "staff_store_roles_store_scope" ON "public"."staff_store_roles"
  AS PERMISSIVE
  FOR ALL
  TO "laundry_app"
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid);
DROP POLICY IF EXISTS "staff_store_roles_maintenance" ON "public"."staff_store_roles";
CREATE POLICY "staff_store_roles_maintenance" ON "public"."staff_store_roles"
  AS PERMISSIVE
  FOR ALL
  TO "laundry_owner"
  USING (true)
  WITH CHECK (true);

ALTER TABLE "public"."store_features" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."store_features" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "store_features_store_scope" ON "public"."store_features";
CREATE POLICY "store_features_store_scope" ON "public"."store_features"
  AS PERMISSIVE
  FOR ALL
  TO "laundry_app"
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid);
DROP POLICY IF EXISTS "store_features_maintenance" ON "public"."store_features";
CREATE POLICY "store_features_maintenance" ON "public"."store_features"
  AS PERMISSIVE
  FOR ALL
  TO "laundry_owner"
  USING (true)
  WITH CHECK (true);

ALTER TABLE "public"."audit_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."audit_log" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "audit_log_store_scope" ON "public"."audit_log";
CREATE POLICY "audit_log_store_scope" ON "public"."audit_log"
  AS PERMISSIVE
  FOR ALL
  TO "laundry_app"
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid);
DROP POLICY IF EXISTS "audit_log_maintenance" ON "public"."audit_log";
CREATE POLICY "audit_log_maintenance" ON "public"."audit_log"
  AS PERMISSIVE
  FOR ALL
  TO "laundry_owner"
  USING (true)
  WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- A5 session tables (store-scope predicate; not in A3 matrix)
-- ---------------------------------------------------------------------------

ALTER TABLE "public"."sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."sessions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "sessions_store_scope" ON "public"."sessions";
CREATE POLICY "sessions_store_scope" ON "public"."sessions"
  AS PERMISSIVE
  FOR ALL
  TO "laundry_app"
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid);
DROP POLICY IF EXISTS "sessions_maintenance" ON "public"."sessions";
CREATE POLICY "sessions_maintenance" ON "public"."sessions"
  AS PERMISSIVE
  FOR ALL
  TO "laundry_owner"
  USING (true)
  WITH CHECK (true);

ALTER TABLE "public"."refresh_families" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."refresh_families" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "refresh_families_store_scope" ON "public"."refresh_families";
CREATE POLICY "refresh_families_store_scope" ON "public"."refresh_families"
  AS PERMISSIVE
  FOR ALL
  TO "laundry_app"
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid);
DROP POLICY IF EXISTS "refresh_families_maintenance" ON "public"."refresh_families";
CREATE POLICY "refresh_families_maintenance" ON "public"."refresh_families"
  AS PERMISSIVE
  FOR ALL
  TO "laundry_owner"
  USING (true)
  WITH CHECK (true);

ALTER TABLE "public"."refresh_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."refresh_tokens" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "refresh_tokens_store_scope" ON "public"."refresh_tokens";
CREATE POLICY "refresh_tokens_store_scope" ON "public"."refresh_tokens"
  AS PERMISSIVE
  FOR ALL
  TO "laundry_app"
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid);
DROP POLICY IF EXISTS "refresh_tokens_maintenance" ON "public"."refresh_tokens";
CREATE POLICY "refresh_tokens_maintenance" ON "public"."refresh_tokens"
  AS PERMISSIVE
  FOR ALL
  TO "laundry_owner"
  USING (true)
  WITH CHECK (true);

ALTER TABLE "public"."pin_challenges" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."pin_challenges" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "pin_challenges_store_scope" ON "public"."pin_challenges";
CREATE POLICY "pin_challenges_store_scope" ON "public"."pin_challenges"
  AS PERMISSIVE
  FOR ALL
  TO "laundry_app"
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid);
DROP POLICY IF EXISTS "pin_challenges_maintenance" ON "public"."pin_challenges";
CREATE POLICY "pin_challenges_maintenance" ON "public"."pin_challenges"
  AS PERMISSIVE
  FOR ALL
  TO "laundry_owner"
  USING (true)
  WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- Grants: orgs is global (no tenant RLS). audit_log is append-oriented for app.
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON TABLE orgs TO laundry_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE stores TO laundry_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE staffs TO laundry_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE staff_store_roles TO laundry_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE settings TO laundry_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE store_features TO laundry_app;
GRANT SELECT, INSERT ON TABLE audit_log TO laundry_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE sessions TO laundry_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE refresh_families TO laundry_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE refresh_tokens TO laundry_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE pin_challenges TO laundry_app;
