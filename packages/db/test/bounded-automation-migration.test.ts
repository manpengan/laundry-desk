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
    "0069_bounded_automation.sql",
  ),
  "utf8",
);

describe("0069 bounded automation migration", () => {
  it("is expand-only and has no arbitrary execution surface", () => {
    expect(() =>
      assertExpandFriendlyMigrations([{ file: "0069_bounded_automation.sql", sql: migration }]),
    ).not.toThrow();
    expect(migration).not.toMatch(/CREATE\s+EXTENSION|pg_cron|plpython|plperlu|COPY\s+.*PROGRAM/iu);
    expect(migration).not.toMatch(/provider_url|callback_url|arbitrary_sql|script_body/iu);
  });

  it("freezes the allowlist, quotas, lease state and append-only evidence", () => {
    for (const table of ["automation_policies", "automation_policy_usage_daily", "ai_action_log"]) {
      expect(migration).toMatch(new RegExp(`CREATE TABLE public\\.${table}`, "iu"));
      expect(migration).toMatch(
        new RegExp(`ALTER TABLE public\\.${table} FORCE ROW LEVEL SECURITY`, "iu"),
      );
    }
    expect(migration).toMatch(/tool = 'notification\.delivery_batch\.enqueue'/iu);
    expect(migration).toMatch(/requested_object_count NOT BETWEEN 1 AND LEAST\(10/iu);
    expect(migration).toMatch(/FOR UPDATE OF policy_row/iu);
    expect(migration).toMatch(/FOR UPDATE;[\s\S]*max_runs :=/iu);
    expect(migration).toMatch(/status = 'quota_paused'/iu);
    expect(migration).toMatch(/actor_staff_id uuid NOT NULL/iu);
    expect(migration).toMatch(
      /REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public\.ai_action_log FROM laundry_app/iu,
    );
  });

  it("keeps administrator authority and direct writes fail closed", () => {
    expect(migration).toMatch(/CREATE FUNCTION public\.assert_automation_admin/iu);
    expect(migration).toMatch(/role_row\.role = 'admin'/iu);
    expect(migration).toMatch(
      /store_id = NULLIF\(current_setting\('app\.store_id', true\), ''\)::uuid/iu,
    );
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.automation_policy_write/iu);
    expect(migration).toMatch(
      /REVOKE ALL ON TABLE public\.automation_policy_usage_daily FROM PUBLIC, laundry_app/iu,
    );
    expect(migration).not.toMatch(
      /GRANT SELECT ON TABLE public\.automation_policy_usage_daily TO laundry_app/iu,
    );
    expect(migration).not.toMatch(
      /GRANT (?:INSERT|UPDATE|DELETE|TRUNCATE) ON TABLE public\.automation_policies TO laundry_app/iu,
    );
  });
});
