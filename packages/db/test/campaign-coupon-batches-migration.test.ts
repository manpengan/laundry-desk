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
    "0060_campaign_coupon_batches.sql",
  ),
  "utf8",
);

describe("0060 campaign coupon batches migration", () => {
  it("links bounded batches to frozen audiences and the existing coupon ledger", () => {
    for (const table of ["campaign_coupon_batches", "campaign_coupon_grants"]) {
      expect(migration).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${table}`, "iu"));
      expect(migration).toMatch(
        new RegExp(`ALTER TABLE public\\.${table} FORCE ROW LEVEL SECURITY`, "iu"),
      );
      expect(migration).toMatch(new RegExp(`${table}_store_scope`, "iu"));
    }
    expect(migration).toMatch(/campaign_coupon_batches_semantic_uidx/iu);
    expect(migration).toMatch(/coupon_version integer NOT NULL/iu);
    expect(migration).toMatch(/coupon_row\.version <> NEW\.coupon_version/iu);
    expect(migration).toMatch(/REFERENCES coupon_grants \(org_id, id, account_id\)/iu);
    expect(migration).toMatch(/eligible_recipient_count BETWEEN 1 AND audience_recipient_count/iu);
    expect(migration).toMatch(/granted_count = eligible_recipient_count/iu);
    expect(migration).toMatch(
      /budget_committed_cents = coupon_discount_cents::bigint \* granted_count/iu,
    );
  });

  it("keeps issuance evidence immutable and budget debits exact", () => {
    expect(migration).toMatch(/campaign_coupon_batches_append_only_trg/iu);
    expect(migration).toMatch(/campaign_coupon_grants_append_only_trg/iu);
    expect(migration).toMatch(/campaign_coupon_batches_complete_trg/iu);
    expect(migration).toMatch(/campaign_coupon_grants_complete_trg/iu);
    expect(migration).toMatch(/DEFERRABLE INITIALLY DEFERRED/iu);
    expect(migration).toMatch(/id = NEW\.batch_id FOR UPDATE/iu);
    expect(migration).toMatch(/mapped_count >= batch_row\.granted_count/iu);
    expect(migration).toMatch(/mapped_count <> batch_row\.granted_count/iu);
    expect(migration).toMatch(/ledger_count <> 1/iu);
    expect(migration).toMatch(/ledger_amount <> batch_row\.budget_committed_cents/iu);
    expect(migration).toMatch(/MARKETING_BUDGET_SOURCE_INVALID/iu);
    expect(migration).toMatch(/NEW\.amount_cents <> batch_amount/iu);
    expect(migration).toMatch(/used_cents \+ NEW\.amount_cents > campaign_budget/iu);
    expect(migration).toMatch(
      /REVOKE UPDATE, DELETE, TRUNCATE ON TABLE[\s\S]*campaign_coupon_batches[\s\S]*campaign_coupon_grants FROM laundry_app/iu,
    );
  });

  it("does not create a second coupon or customer identity authority", () => {
    expect(migration).not.toMatch(/CREATE TABLE[^;]+(?:customer_name|customer_phone)/iu);
    expect(migration).not.toMatch(/ALTER TABLE public\.coupon_(?:grants|redemptions)/iu);
    expect(migration).not.toMatch(/UPDATE\s+(?:public\.)?coupon_(?:grants|redemptions)/iu);
    expect(migration).not.toMatch(/DELETE\s+FROM\s+(?:public\.)?coupon_/iu);
  });
});
