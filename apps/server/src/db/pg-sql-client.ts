/**
 * node-pg adapter implementing SqlClient for the C1 bus / withTenantTransaction.
 *
 * Important: transactions (BEGIN…COMMIT) require a **session-scoped** client
 * (PoolClient), not Pool#query — otherwise SET LOCAL / txn state leaks across
 * connections. Prefer `withPoolClient` around executeCommand.
 */

import type { Pool, PoolClient, QueryResultRow } from "pg";

import type { QueryResult, SqlClient } from "./types.js";

function toQueryResult<TRow>(result: { rows: TRow[]; rowCount: number | null }): QueryResult<TRow> {
  return Object.freeze({
    rows: Object.freeze([...result.rows]) as readonly TRow[],
    rowCount: result.rowCount,
  });
}

/** Wrap an already-checked-out PoolClient (transaction-safe). */
export function createSessionSqlClient(client: PoolClient): SqlClient {
  return Object.freeze({
    async query<TRow = unknown>(
      sql: string,
      params?: readonly unknown[],
    ): Promise<QueryResult<TRow>> {
      const result = await client.query<QueryResultRow>(
        sql,
        params === undefined ? undefined : [...params],
      );
      return toQueryResult({
        rows: result.rows as TRow[],
        rowCount: result.rowCount,
      });
    },
  });
}

/**
 * Run `fn` with a dedicated pool connection released afterward.
 * Use this for executeCommand so BEGIN/SET LOCAL/COMMIT stay on one session.
 */
export async function withPoolClient<T>(
  pool: Pool,
  fn: (sql: SqlClient, raw: PoolClient) => Promise<T>,
): Promise<T> {
  const raw = await pool.connect();
  try {
    return await fn(createSessionSqlClient(raw), raw);
  } finally {
    raw.release();
  }
}
