import type { QueryResult, SqlClient } from "./types.js";

export type RecordedQuery = Readonly<{
  sql: string;
  params: readonly unknown[] | undefined;
}>;

/**
 * In-memory SqlClient for unit tests — no real Postgres required.
 * Not exported from the public db barrel (test helper only).
 */
export class FakeSqlClient implements SqlClient {
  readonly queries: RecordedQuery[] = [];
  private failNextSql: string | null = null;

  failOn(sql: string): void {
    this.failNextSql = sql;
  }

  async query<TRow = unknown>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<TRow>> {
    this.queries.push(Object.freeze({ sql, params }));
    if (this.failNextSql !== null && sql === this.failNextSql) {
      this.failNextSql = null;
      throw new Error(`fake client forced failure on: ${sql}`);
    }
    return Object.freeze({ rows: Object.freeze([]) as readonly TRow[], rowCount: 0 });
  }

  sqlSequence(): readonly string[] {
    return this.queries.map((entry) => entry.sql);
  }
}
