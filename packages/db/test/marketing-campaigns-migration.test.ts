import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "src",
    "migrations",
    "0059_marketing_campaigns.sql",
  ),
  "utf8",
);

describe("0059 marketing campaigns migration", () => {
  it("creates only store-scoped campaign, snapshot and budget authorities", () => {
    for (const table of ["campaigns", "campaign_audience_snapshots", "campaign_budget_ledger"]) {
      expect(migration).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${table}`, "iu"));
      expect(migration).toMatch(
        new RegExp(`ALTER TABLE public\\.${table} FORCE ROW LEVEL SECURITY`, "iu"),
      );
      expect(migration).toMatch(new RegExp(`${table}_store_scope`, "iu"));
    }
    expect(migration).toMatch(/budget_limit_cents BETWEEN 1 AND 5000000/iu);
    expect(migration).toMatch(/recipient_limit BETWEEN 1 AND 500/iu);
    expect(migration).toMatch(/ends_at <= starts_at \+ interval '730 days'/iu);
    expect(migration).not.toMatch(/customer_(?:name|phone)|message_body|address_body/iu);
    expect(migration).not.toMatch(/INSERT INTO (?:public\.)?(?:coupon_grants|coupons)/iu);
  });

  it("enforces a fixed audience DSL without dynamic SQL or recipient copies", () => {
    expect(migration).toMatch(/marketing_audience_rule_is_valid/iu);
    expect(migration).toMatch(/marketing_json_exact_keys/iu);
    expect(migration).toMatch(/ARRAY\['customer_age', 'membership', 'order_activity'\]/iu);
    expect(migration).toMatch(/kind' = 'within_days'/iu);
    expect(migration).toMatch(/kind' IN \('any', 'none'\)/iu);
    expect(migration).toMatch(/kind' IN \('any', 'member', 'non_member'\)/iu);
    expect(migration).toMatch(/jsonb_array_length\(membership_rule->'tier_ids'\)/iu);
    expect(migration).toMatch(/tier_id ~\* '\^\(\[0-9a-f\]\{8\}[\s\S]*\[1-8\]/iu);
    expect(migration).not.toMatch(/\bEXECUTE\s+format\s*\(/iu);
    expect(migration).not.toMatch(/\bEXECUTE\s+[a-z_][a-z0-9_]*\s+USING\b/iu);
    expect(migration).not.toMatch(/customer_id uuid NOT NULL[\s\S]*campaign_audience_snapshots/iu);
  });

  it("makes freezes and budget rows append-only and serializes budget checks", () => {
    expect(migration).toMatch(/campaign_audience_snapshots_semantic_uidx/iu);
    expect(migration).toMatch(/MARKETING_AUDIENCE_STALE/iu);
    expect(migration).toMatch(/SELECT budget_limit_cents INTO campaign_budget[\s\S]*FOR UPDATE/iu);
    expect(migration).toMatch(/used_cents \+ NEW\.amount_cents > campaign_budget/iu);
    expect(migration).toMatch(/marketing evidence is append-only/iu);
    expect(migration).toMatch(
      /REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public\.campaign_audience_snapshots/iu,
    );
    expect(migration).toMatch(/NEW\.version <> OLD\.version \+ 1/iu);
    expect(migration).toMatch(/MARKETING_CAMPAIGN_TERMINAL/iu);
    expect(migration).toMatch(/digest\(NEW\.audience_rule::text, 'sha256'\)/iu);
    expect(migration).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS ai_pending_marketing_idempotency_uidx[\s\S]*org_id, store_id, command, idempotency_key[\s\S]*marketing\.campaign\.set[\s\S]*marketing\.campaign\.audience\.freeze/iu,
    );
  });

  it("keeps the reserved budget ledger read-only for the Item 7 app role", () => {
    expect(migration).toMatch(
      /campaign_budget_ledger_store_scope[\s\S]*FOR SELECT TO laundry_app/iu,
    );
    expect(migration).toMatch(
      /GRANT SELECT ON TABLE public\.campaign_budget_ledger TO laundry_app/iu,
    );
    expect(migration).toMatch(
      /REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public\.campaign_budget_ledger FROM laundry_app/iu,
    );
    expect(migration).not.toMatch(
      /GRANT[^;]*\bINSERT\b[^;]*ON TABLE public\.campaign_budget_ledger TO laundry_app/iu,
    );
  });

  it("binds every app-role writer to the authenticated active store admin", () => {
    expect(migration).toMatch(/CREATE OR REPLACE FUNCTION public\.assert_marketing_actor/iu);
    expect(migration).toMatch(/current_setting\('app\.staff_id', true\)/iu);
    expect(migration).toMatch(/current_setting\('app\.org_id', true\)/iu);
    expect(migration).toMatch(/current_setting\('app\.store_id', true\)/iu);
    expect(migration).toMatch(/role\.is_active = true AND role\.role = 'admin'/iu);
    expect(migration.match(/PERFORM public\.assert_marketing_actor/gmu)).toHaveLength(3);
    expect(migration).toMatch(
      /NEW\.created_by_staff_id IS DISTINCT FROM NEW\.updated_by_staff_id/iu,
    );
    expect(migration).toMatch(/db_now < OLD\.updated_at/iu);
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.assert_marketing_actor\(uuid, uuid, uuid\) FROM PUBLIC/iu,
    );
  });
});
