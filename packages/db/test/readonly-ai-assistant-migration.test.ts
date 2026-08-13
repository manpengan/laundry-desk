import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { assertExpandFriendlyMigrations } from "../src/migration-guard.js";

const filename = "0067_readonly_ai_assistant.sql";
const migration = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "src", "migrations", filename),
  "utf8",
);

describe("0067 read-only AI assistant migration", () => {
  it("is a compatible expansion between 0066 and 0068", () => {
    expect(() =>
      assertExpandFriendlyMigrations([{ file: filename, sql: migration }]),
    ).not.toThrow();
    expect(migration).toMatch(/business\.summary/gu);
    expect(migration).toMatch(/records\.search/gu);
    expect(migration).toMatch(/procedure\.troubleshoot/gu);
    expect(migration).toMatch(/ai_readonly_tool_attempt_append/gu);
  });

  it("keeps direct DML closed and audits metadata only", () => {
    expect(migration).toMatch(/SECURITY DEFINER SET search_path = pg_catalog, public/iu);
    expect(migration).toMatch(/assert_ai_stream_authority\(requested_auth_session_id\)/iu);
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.ai_readonly_tool_attempt_append/iu,
    );
    expect(migration).not.toMatch(/GRANT (?:INSERT|UPDATE|DELETE).*ai_tool_attempts/iu);
    const audit = migration.slice(migration.indexOf("INSERT INTO public.audit_log"));
    expect(audit).toMatch(/tool_name|duration_ms|result_count|source_count|filter_count/iu);
    expect(audit).not.toMatch(
      /requested_(?:prompt|result\b|args)|customer_phone|api_key|headers|url/iu,
    );
  });
});
