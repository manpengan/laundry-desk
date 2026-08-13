import type { ByokKmsPort } from "./byok-kms.js";
import { MemoryByokStore } from "./byok-memory-store.js";
import { createPgByokStore } from "./byok-pg-store.js";
import type { ByokStore, ByokTransactionContext } from "./byok-types.js";
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

export type ByokRuntime = Readonly<{
  local: LocalRuntime;
  store: ByokStore;
  kms: ByokKmsPort | null;
  transact<T>(
    tenant: TenantContext,
    operation: (context: ByokTransactionContext) => Promise<T>,
  ): Promise<T>;
}>;

export function createByokRuntime(
  local: LocalRuntime,
  kms: ByokKmsPort | null,
  store?: ByokStore,
): ByokRuntime {
  const resolvedStore =
    store ?? (local.pool === null ? new MemoryByokStore() : createPgByokStore(local.pool));
  const transact = async <T>(
    tenant: TenantContext,
    operation: (context: ByokTransactionContext) => Promise<T>,
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
  return Object.freeze({ local, store: resolvedStore, kms, transact });
}
