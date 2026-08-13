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
    "0065_ai_streaming_sessions.sql",
  ),
  "utf8",
);

describe("0065 bounded AI streaming migration", () => {
  it("is expand-only and creates the minimal durable state", () => {
    expect(() =>
      assertExpandFriendlyMigrations([{ file: "0065_ai_streaming_sessions.sql", sql: migration }]),
    ).not.toThrow();
    for (const table of [
      "ai_sessions",
      "ai_turns",
      "ai_messages",
      "ai_stream_events",
      "ai_usage",
      "ai_tool_attempts",
    ]) {
      expect(migration).toMatch(new RegExp(`CREATE TABLE public\\.${table}`, "u"));
    }
  });

  it("forces staff-scoped RLS and removes all direct application DML", () => {
    expect(migration.match(/FORCE ROW LEVEL SECURITY/gu)).toHaveLength(1);
    expect(migration).toMatch(/FOREACH table_name IN ARRAY/iu);
    expect(migration).toMatch(/staff_id = NULLIF\(current_setting\(''app\.staff_id''/iu);
    expect(migration).toMatch(
      /auth_session_id = NULLIF\(current_setting\(''app\.auth_session_id''/iu,
    );
    expect(migration).toMatch(/bound_auth_session <> requested_auth_session_id/iu);
    expect(migration).toMatch(/REVOKE ALL ON TABLE public\.%I FROM PUBLIC, laundry_app/iu);
    expect(migration).toMatch(/GRANT SELECT ON TABLE public\.%I TO laundry_app/iu);
    expect(migration).not.toMatch(
      /GRANT (?:INSERT|UPDATE|DELETE|TRUNCATE).*TABLE.*TO laundry_app/iu,
    );
  });

  it("bounds active turns, events, output, tokens, and exact read-only tool name", () => {
    expect(migration).toMatch(/ai_turns_one_active_uidx[\s\S]*status IN \('queued', 'running'\)/iu);
    expect(migration).toMatch(/event_count BETWEEN 0 AND 256/iu);
    expect(migration).toMatch(/output_bytes BETWEEN 0 AND 32768/iu);
    expect(migration).toMatch(/max_output_tokens BETWEEN 1 AND 1024/iu);
    expect(migration).toMatch(/tool_steps BETWEEN 0 AND 4/iu);
    expect(migration).toMatch(/tool_name = 'synthetic\.lookup'/iu);
    expect(migration).not.toMatch(/order\.refund|payment\.|member\.|notification\./iu);
  });

  it("writes only closed metadata to audit and keeps messages append-only", () => {
    const auditBlocks = [...migration.matchAll(/INSERT INTO public\.audit_log[\s\S]*?;\n/gu)]
      .map((match) => match[0])
      .join("\n");
    expect(auditBlocks).toMatch(/prompt_sha256/iu);
    expect(auditBlocks).toMatch(/prompt_chars/iu);
    expect(auditBlocks).not.toMatch(
      /requested_assistant_text|tool_args|['"](?:prompt|response|tool_args)['"]/iu,
    );
    expect(migration).not.toMatch(/UPDATE public\.ai_messages|DELETE FROM public\.ai_messages/iu);
    expect(migration).toMatch(/ai_messages_sequence_uidx UNIQUE/iu);
  });
});
