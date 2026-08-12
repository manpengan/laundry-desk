import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { assertExpandFriendlyMigrations } from "../src/migration-guard.js";

const migration = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "src",
    "migrations",
    "0064_byok_model_registry.sql",
  ),
  "utf8",
);

describe("0064 BYOK and model registry migration", () => {
  it("remains expand-only", () => {
    expect(() =>
      assertExpandFriendlyMigrations([{ file: "0064_byok_model_registry.sql", sql: migration }]),
    ).not.toThrow();
  });

  it("creates an empty owner-verified registry and no guessed model rows", () => {
    expect(migration).toMatch(/CREATE TABLE public\.ai_model_registry/iu);
    expect(migration).toMatch(/source_url text NOT NULL/iu);
    expect(migration).toMatch(/verified_at timestamptz NOT NULL/iu);
    expect(migration).not.toMatch(/INSERT\s+INTO\s+(?:public\.)?ai_model_registry/iu);
    expect(migration).toMatch(
      /REVOKE ALL ON TABLE public\.ai_model_registry FROM PUBLIC, laundry_app/iu,
    );
    expect(migration).toMatch(/GRANT SELECT ON TABLE public\.ai_model_registry TO laundry_app/iu);
  });

  it("stores only envelope fields with strict AES-GCM dimensions", () => {
    expect(migration).toMatch(/CREATE TABLE public\.ai_provider_keys/iu);
    expect(migration).toMatch(/octet_length\(nonce\) = 12/iu);
    expect(migration).toMatch(/octet_length\(auth_tag\) = 16/iu);
    expect(migration).toMatch(/envelope_schema_version = 1/iu);
    expect(migration).toMatch(/ciphertext bytea NOT NULL/iu);
    expect(migration).toMatch(/wrapped_dek bytea NOT NULL/iu);
    expect(migration).not.toMatch(/\bapi_key\b|\bplaintext\b|\bsecret_value\b/iu);
  });

  it("forces org RLS, terminal transitions, and bounded uniqueness", () => {
    expect(migration).toMatch(/ALTER TABLE public\.ai_provider_keys FORCE ROW LEVEL SECURITY/iu);
    expect(migration).toMatch(
      /org_id = NULLIF\(current_setting\('app\.org_id', true\), ''\)::uuid/iu,
    );
    expect(migration).toMatch(/WHERE status = 'active'/iu);
    expect(migration).toMatch(/WHERE status = 'pending_verification'/iu);
    expect(migration).toMatch(
      /CREATE UNIQUE INDEX ai_pending_byok_idempotency_uidx[\s\S]*'ai\.provider_credential\.replace'[\s\S]*'ai\.provider_credential\.revoke'/iu,
    );
    expect(migration).toMatch(/invalid credential lifecycle transition/iu);
    expect(migration).toMatch(
      /REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public\.ai_provider_keys FROM laundry_app/iu,
    );
  });

  it("makes lifecycle writes database-authoritative and R5-bound", () => {
    expect(migration).toMatch(/CREATE FUNCTION public\.assert_ai_provider_key_admin\(\)/iu);
    expect(migration).toMatch(/role_row\.role = 'admin'/iu);
    expect(migration).toMatch(/CREATE FUNCTION public\.assert_ai_provider_key_operation/iu);
    expect(migration).toMatch(/pending\.effective_risk = 'R5'/iu);
    expect(migration).toMatch(/pending\.status = 'consumed'/iu);
    expect(migration).toMatch(/proof\.status = 'consumed'/iu);
    expect(migration).toMatch(/CREATE FUNCTION public\.ai_provider_key_stage/iu);
    expect(migration).toMatch(/CREATE FUNCTION public\.ai_provider_key_revoke/iu);
    expect(migration).toMatch(/db_now timestamptz := statement_timestamp\(\)/iu);
    expect(migration).toMatch(/expected_row_version integer/iu);
    expect(migration).toMatch(/SET search_path = pg_catalog, public/iu);
    expect(migration).toMatch(/GRANT SELECT ON TABLE public\.ai_provider_keys TO laundry_app/iu);
    expect(migration).not.toMatch(/GRANT (?:SELECT, )?INSERT ON TABLE public\.ai_provider_keys/iu);
    expect(migration).not.toMatch(/GRANT UPDATE[\s\S]*ON TABLE public\.ai_provider_keys/iu);
  });

  it("keeps provider verification and KEK rewrap on owner-only internal paths", () => {
    expect(migration).toMatch(/CREATE FUNCTION public\.ai_provider_key_verify_transition/iu);
    expect(migration).toMatch(/verification_status NOT IN \('active', 'invalid'\)/iu);
    expect(migration).toMatch(/CREATE FUNCTION public\.ai_provider_key_rewrap/iu);
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.ai_provider_key_rewrap[\s\S]*FROM PUBLIC, laundry_app/iu,
    );
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.ai_provider_key_rewrap[\s\S]*TO laundry_owner/iu,
    );
    const rewrapBody = migration.match(
      /CREATE FUNCTION public\.ai_provider_key_rewrap[\s\S]*?END\n\$\$;/u,
    )?.[0];
    expect(rewrapBody).toBeDefined();
    expect(rewrapBody).not.toMatch(/ciphertext\s*=/iu);
    expect(rewrapBody).not.toMatch(/nonce\s*=/iu);
    expect(rewrapBody).not.toMatch(/auth_tag\s*=/iu);
  });
});
