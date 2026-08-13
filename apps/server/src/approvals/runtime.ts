import { MemoryApprovalStore } from "./memory-store.js";
import { createPgApprovalStore } from "./pg-store.js";
import type { ApprovalStore, ApprovalTransaction } from "./types.js";
import { withPoolClient } from "../db/pg-sql-client.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import type { QueryResult, SqlClient, TenantContext } from "../db/types.js";
import type { LocalRuntime } from "../local/runtime-types.js";

const MEMORY_SQL_CLIENT: SqlClient = Object.freeze({
  memoryTransaction: true as const,
  async query<TRow = unknown>(): Promise<QueryResult<TRow>> {
    return Object.freeze({ rows: Object.freeze([]) as readonly TRow[], rowCount: 0 });
  },
});

export type ApprovalRuntime = Readonly<{
  local: LocalRuntime;
  store: ApprovalStore;
  transact<T>(
    tenant: TenantContext,
    operation: (context: ApprovalTransaction) => Promise<T>,
  ): Promise<T>;
  withSql<T>(operation: (client: SqlClient) => Promise<T>): Promise<T>;
}>;

export function createApprovalRuntime(local: LocalRuntime): ApprovalRuntime {
  const store = local.approvalStore ?? createApprovalStoreForRuntime(local);
  const transact = async <T>(
    tenant: TenantContext,
    operation: (context: ApprovalTransaction) => Promise<T>,
  ): Promise<T> => {
    if (local.pool === null) {
      return withTenantTransaction(MEMORY_SQL_CLIENT, tenant, (client) =>
        operation(Object.freeze({ client, tenant })),
      );
    }
    return withPoolClient(local.pool, (client) =>
      withTenantTransaction(client, tenant, (transactionClient) =>
        operation(Object.freeze({ client: transactionClient, tenant })),
      ),
    );
  };
  const withSql = async <T>(operation: (client: SqlClient) => Promise<T>): Promise<T> =>
    local.pool === null ? operation(MEMORY_SQL_CLIENT) : withPoolClient(local.pool, operation);
  return Object.freeze({ local, store, transact, withSql });
}

export function createApprovalStoreForRuntime(local: Pick<LocalRuntime, "pool">): ApprovalStore {
  return local.pool === null ? new MemoryApprovalStore() : createPgApprovalStore(local.pool);
}
