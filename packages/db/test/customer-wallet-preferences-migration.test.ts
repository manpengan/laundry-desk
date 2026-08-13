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
    "0062_customer_wallet_and_preferences.sql",
  ),
  "utf8",
);

describe("0062 customer wallet and preferences migration", () => {
  it("projects the existing wallet and benefit authorities without write primitives", () => {
    for (const view of [
      "customer_portal_wallet",
      "customer_portal_wallet_ledger",
      "customer_portal_membership",
      "customer_portal_points",
      "customer_portal_punch_cards",
      "customer_portal_coupons",
    ]) {
      expect(migration).toMatch(new RegExp(`VIEW public\\.${view}[\\s\\S]*security_invoker`, "iu"));
    }
    expect(migration).toMatch(/FROM public\.member_ledger/iu);
    expect(migration).toMatch(/JOIN public\.points_ledger/iu);
    expect(migration).toMatch(/FROM public\.punch_cards/iu);
    expect(migration).toMatch(/FROM public\.coupon_grants/iu);
    expect(migration).not.toMatch(/customer_portal_(?:topup|pay|redeem|consume)\s*\(/iu);
  });

  it("replaces only portal-owned addresses under canonical CAS authority", () => {
    expect(migration).toMatch(/portal_managed boolean NOT NULL DEFAULT false/iu);
    expect(migration).toMatch(/customer_portal_profile_update\(/iu);
    expect(migration).toMatch(/customer_portal_session_validate/iu);
    expect(migration).toMatch(/pg_advisory_xact_lock\(hashtextextended/iu);
    expect(migration).toMatch(/AND address\.portal_managed AND address\.retired_at IS NULL/iu);
    expect(migration).toMatch(/AND NOT address\.portal_managed/iu);
    expect(migration).toMatch(
      /preserved_count \+ jsonb_array_length\(requested_addresses\) > 10/iu,
    );
    expect(migration).toMatch(/preserved_defaults \+ requested_defaults > 1/iu);
    expect(migration).toMatch(/CUSTOMER_PORTAL_PROFILE_STALE/iu);
  });

  it("keeps direct app DML fail-closed and access evidence free of address PII", () => {
    expect(migration).toMatch(/current_user <> 'laundry_app'/iu);
    expect(migration).toMatch(/CUSTOMER_PORTAL_ADDRESS_DML_DENIED/iu);
    expect(migration).toMatch(/REVOKE ALL ON TABLE public\.customer_portal_preferences/iu);
    expect(migration).toMatch(/GRANT SELECT ON TABLE public\.customer_portal_preferences/iu);
    const accessInsert = migration.match(
      /INSERT INTO public\.customer_portal_access_log \([\s\S]*?'profile\.update'[\s\S]*?\);/iu,
    )?.[0];
    expect(accessInsert).toBeDefined();
    expect(accessInsert).toMatch(/address_count, preference, profile_version/iu);
    expect(accessInsert).not.toMatch(/address_body|recipient|contact_phone/iu);
  });
});
