/**
 * Static guards for expand-friendly migrations.
 * Destructive DDL is rejected so M1 schema expands without drop/truncate.
 */

const DESTRUCTIVE_SQL_PATTERNS: readonly Readonly<{ name: string; pattern: RegExp }>[] = [
  { name: "DROP TABLE", pattern: /\bDROP\s+TABLE\b/iu },
  { name: "TRUNCATE", pattern: /\bTRUNCATE\b/iu },
  { name: "DROP COLUMN", pattern: /\bDROP\s+COLUMN\b/iu },
  { name: "ALTER ... DROP CONSTRAINT (data-loss style)", pattern: /\bDROP\s+CONSTRAINT\b/iu },
];

/**
 * PostgreSQL requires replacing a CHECK constraint to expand its allowed enum-like
 * values. This sole replacement broadens `orders.status` for ticketless drafts;
 * it does not remove rows or values. Keep the exception exact so arbitrary
 * constraint drops remain a migration-gate failure.
 */
const isCompatibleOrdersStatusConstraintReplacement = (statement: string): boolean =>
  /^ALTER\s+TABLE\s+(?:"?public"?\.)?"?orders"?\s+DROP\s+CONSTRAINT\s+IF\s+EXISTS\s+"?orders_status_chk"?\s*;?$/iu.test(
    statement,
  );

export type DestructiveMigrationFinding = Readonly<{
  file: string;
  rule: string;
  line: number;
  snippet: string;
}>;

/** Scan a single migration SQL body for destructive statements. */
export const findDestructiveSql = (
  file: string,
  sql: string,
): readonly DestructiveMigrationFinding[] => {
  const findings: DestructiveMigrationFinding[] = [];
  const lines = sql.split(/\r?\n/u);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const stripped = line.replace(/--.*$/u, "").trim();
    if (stripped.length === 0) continue;

    for (const rule of DESTRUCTIVE_SQL_PATTERNS) {
      // This is a privilege revocation, not a TRUNCATE statement. Keep the
      // expand-only guard strict for actual data-removal SQL while allowing
      // append-only ledgers to explicitly revoke the TRUNCATE privilege.
      if (rule.name === "TRUNCATE" && /^REVOKE\b/iu.test(stripped)) continue;
      if (
        rule.name === "ALTER ... DROP CONSTRAINT (data-loss style)" &&
        isCompatibleOrdersStatusConstraintReplacement(stripped)
      ) {
        continue;
      }
      if (rule.pattern.test(stripped)) {
        findings.push({
          file,
          rule: rule.name,
          line: index + 1,
          snippet: stripped.slice(0, 160),
        });
      }
    }
  }

  return findings;
};

/** True when migration SQL is expand-only (no destructive findings). */
export const isExpandFriendlyMigration = (sql: string): boolean =>
  findDestructiveSql("<inline>", sql).length === 0;

/** Assert no destructive findings; throws with a compact multi-line message. */
export const assertExpandFriendlyMigrations = (
  files: ReadonlyArray<Readonly<{ file: string; sql: string }>>,
): void => {
  const findings = files.flatMap((entry) => findDestructiveSql(entry.file, entry.sql));
  if (findings.length === 0) return;

  const detail = findings
    .map((item) => `${item.file}:${item.line} [${item.rule}] ${item.snippet}`)
    .join("\n");
  throw new Error(`Destructive migration SQL rejected:\n${detail}`);
};
