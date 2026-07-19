-- Executable store-scope template used by all three spike tables:
--   USING (
--     org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
--     AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid
--   )
--   WITH CHECK (same expression)
--
-- Org-scope template for M1 org-level tables:
--   USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
--   WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
--
-- NULLIF makes missing or empty custom GUCs evaluate to NULL, so reads return
-- zero rows while writes are rejected. Conditions inspect only row columns and
-- transaction-local GUCs; no cross-table subquery is present.

-- Parse and execute the org-only template so it is verified rather than only
-- documented. The transient probe is dropped before the spike schema is used.
CREATE TABLE org_policy_template_probe (org_id uuid NOT NULL);
ALTER TABLE org_policy_template_probe ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_policy_template_probe FORCE ROW LEVEL SECURITY;
CREATE POLICY org_policy_template_probe_scope ON org_policy_template_probe
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
DROP TABLE org_policy_template_probe;

ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders FORCE ROW LEVEL SECURITY;
CREATE POLICY orders_store_scope ON orders
  USING (
    org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid
  );

ALTER TABLE order_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY order_lines_store_scope ON order_lines
  USING (
    org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid
  );

ALTER TABLE garments ENABLE ROW LEVEL SECURITY;
ALTER TABLE garments FORCE ROW LEVEL SECURITY;
CREATE POLICY garments_store_scope ON garments
  USING (
    org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND store_id = NULLIF(current_setting('app.store_id', true), '')::uuid
  );
