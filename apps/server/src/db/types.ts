/**
 * C2 tenant GUC ports — shared types.
 *
 * packages/db (drizzle + real pg Pool) is intentionally not a dependency yet.
 * Plug-in point: implement SqlClient / TransactionalClient against drizzle's
 * session or node-pg Client, then pass that adapter into withTenantTransaction.
 */

/** RFC 4122 UUID string (validated at the tenant boundary). */
export type Uuid = string;

/**
 * Transaction-scoped tenant identity injected into Postgres GUCs.
 * Source of truth is the server session (C6/C8) — never trust client/LLM/Edge.
 */
export type TenantContext = Readonly<{
  orgId: Uuid;
  storeId: Uuid;
  staffId: Uuid;
}>;

/** Minimal query result shape compatible with node-pg / drizzle adapters. */
export type QueryResult<TRow = unknown> = Readonly<{
  rows: readonly TRow[];
  rowCount: number | null;
}>;

/**
 * Injected DB port used by unit tests (fake) and later packages/db adapters.
 * Identifiers in `sql` must be fixed literals from this package; values go in `params`.
 */
export type SqlClient = Readonly<{
  query: <TRow = unknown>(sql: string, params?: readonly unknown[]) => Promise<QueryResult<TRow>>;
}>;

/**
 * Connection-scoped client that can host a single transaction.
 * packages/db will typically wrap Pool#connect() → Client here.
 */
export type TransactionalClient = SqlClient;

/** Callback body executed inside an open tenant transaction. */
export type TenantTransactionFn<TResult> = (client: SqlClient) => Promise<TResult>;
