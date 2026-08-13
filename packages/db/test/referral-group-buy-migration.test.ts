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
    "0063_referral_and_group_buy.sql",
  ),
  "utf8",
);

describe("0063 referral and group-buy migration", () => {
  it("binds one qualified referral to one existing coupon grant and exact budget debit", () => {
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS public\.referral_rewards/iu);
    expect(migration).toMatch(/referral_rewards_referred_campaign_uidx/iu);
    expect(migration).toMatch(/referral_rewards_order_uidx/iu);
    expect(migration).toMatch(/REFERENCES coupon_grants \(org_id, id\)/iu);
    expect(migration).toMatch(/order_row\.status <> 'closed'/iu);
    expect(migration).toMatch(/order_row\.balance_cents <> 0/iu);
    expect(migration).toMatch(/ledger_count <> 1 OR ledger_amount <> NEW\.reward_cents/iu);
    expect(migration).toMatch(/budget_remaining_before_cents integer NOT NULL/iu);
    expect(migration).toMatch(
      /NEW\.budget_remaining_before_cents <> campaign_row\.budget_limit_cents - used_cents/iu,
    );
    expect(migration).toMatch(/source_count <> 1/iu);
    expect(migration).toMatch(/COALESCE\(batch_amount, referral_amount\)/iu);
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.append_referral_budget_ledger\([\s\S]*SECURITY DEFINER/iu,
    );
    expect(migration).toMatch(
      /reward\.created_by_staff_id = actor_id[\s\S]*INSERT INTO public\.campaign_budget_ledger/iu,
    );
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.append_referral_budget_ledger\(uuid, uuid\) TO laundry_app/iu,
    );
    expect(migration).not.toMatch(
      /GRANT[^;]*INSERT[^;]*campaign_budget_ledger[^;]*TO laundry_app/iu,
    );
  });

  it("stores no bearer code and atomically binds one voucher to one order", () => {
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS public\.group_buy_vouchers/iu);
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS public\.group_buy_redemptions/iu);
    expect(migration).toMatch(/code_digest text NOT NULL/iu);
    expect(migration).toMatch(/code_last4 text NOT NULL/iu);
    expect(migration).not.toMatch(/voucher_code text|raw_code|plaintext_code/iu);
    expect(migration).toMatch(/group_buy_redemptions_voucher_uidx/iu);
    expect(migration).toMatch(/group_buy_redemptions_order_uidx/iu);
    expect(migration).toMatch(/order_row\.discount_source <> 'manual'/iu);
    expect(migration).toMatch(
      /LEAST\(voucher_row\.face_value_cents, order_row\.original_cents\)/iu,
    );
  });

  it("forces store RLS and append-only application grants on all three evidence tables", () => {
    for (const table of ["referral_rewards", "group_buy_vouchers", "group_buy_redemptions"]) {
      expect(migration).toMatch(
        new RegExp(`ALTER TABLE public\\.${table} FORCE ROW LEVEL SECURITY`, "iu"),
      );
      expect(migration).toMatch(new RegExp(`${table}_store_scope`, "iu"));
      expect(migration).toMatch(new RegExp(`${table}_append_only_trg`, "iu"));
    }
    expect(migration).toMatch(
      /REVOKE UPDATE, DELETE, TRUNCATE ON TABLE[\s\S]*referral_rewards[\s\S]*group_buy_vouchers[\s\S]*group_buy_redemptions FROM laundry_app/iu,
    );
  });
});
