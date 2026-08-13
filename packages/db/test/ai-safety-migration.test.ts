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
    "0066_ai_safety_metering.sql",
  ),
  "utf8",
);

describe("0066 AI safety metering migration", () => {
  it("is expand-only and uses durable integer accounting", () => {
    expect(() =>
      assertExpandFriendlyMigrations([{ file: "0066_ai_safety_metering.sql", sql: migration }]),
    ).not.toThrow();
    for (const table of [
      "ai_safety_policies",
      "ai_cost_reservations",
      "ai_usage_daily",
      "ai_circuit_breakers",
      "ai_safety_events",
    ]) {
      expect(migration).toMatch(new RegExp(`CREATE TABLE public\\.${table}`, "u"));
    }
    expect(migration).toMatch(/estimated_cost_micros bigint/iu);
    expect(migration).not.toMatch(/\b(?:real|double precision|money)\b/iu);
  });

  it("serializes org budget reservations and persists breaker state", () => {
    expect(migration).toMatch(/pg_advisory_xact_lock/iu);
    expect(migration).toMatch(/released_at IS NULL/iu);
    expect(migration).toMatch(/AI_BUDGET_EXCEEDED/iu);
    expect(migration).toMatch(/AI_CIRCUIT_OPEN/iu);
    expect(migration).toMatch(/consecutive_failures/iu);
  });

  it("forces RLS and exposes only closed security-definer functions", () => {
    expect(migration).toMatch(/FORCE ROW LEVEL SECURITY/iu);
    expect(migration).toMatch(/REVOKE ALL ON TABLE public\.%I FROM PUBLIC, laundry_app/iu);
    expect(migration).not.toMatch(/GRANT (?:INSERT|UPDATE|DELETE|TRUNCATE).*TO laundry_app/iu);
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.ai_safety_status/iu);
    for (const legacyFunction of ["ai_turn_create", "ai_turn_start", "ai_turn_finish"]) {
      expect(migration).toMatch(
        new RegExp(
          `REVOKE EXECUTE ON FUNCTION public\\.${legacyFunction}[^;]+FROM laundry_app`,
          "u",
        ),
      );
    }
  });

  it("stores prompt rejection hashes but no raw prompt or provider endpoint", () => {
    expect(migration).toMatch(/content_sha256/iu);
    const auditBlocks = [...migration.matchAll(/INSERT INTO public\.audit_log[\s\S]*?;\n/gu)]
      .map((match) => match[0])
      .join("\n");
    expect(auditBlocks).not.toMatch(/requested_prompt[^_]|base_url|api_key|authorization header/iu);
  });
});
