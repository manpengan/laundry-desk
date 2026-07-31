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
 * PostgreSQL requires replacing a CHECK constraint to expand its allowed
 * enum-like values, so each broadening shows up as a DROP CONSTRAINT.
 *
 * Every entry here must be an exact (table, constraint) pair that is only ever
 * re-added wider in the same migration: broadening accepts more values and
 * removes no row. Keep this list exact — a loosened pattern would let an
 * arbitrary constraint drop through the expand-only gate.
 */
const COMPATIBLE_CONSTRAINT_REPLACEMENTS: readonly Readonly<{
  table: string;
  constraint: string;
}>[] = [
  // Broadens orders.status for ticketless drafts.
  { table: "orders", constraint: "orders_status_chk" },
  // ADR-17: broadens payments.method with 'balance' so a stored-value
  // settlement lands in the same ledger as every other tender.
  { table: "payments", constraint: "payments_method_chk" },
];

const isCompatibleConstraintReplacement = (statement: string): boolean =>
  COMPATIBLE_CONSTRAINT_REPLACEMENTS.some(({ table, constraint }) =>
    new RegExp(
      `^ALTER\\s+TABLE\\s+(?:"?public"?\\.)?"?${table}"?\\s+DROP\\s+CONSTRAINT\\s+IF\\s+EXISTS\\s+"?${constraint}"?\\s*;?$`,
      "iu",
    ).test(statement),
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
        isCompatibleConstraintReplacement(stripped)
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
