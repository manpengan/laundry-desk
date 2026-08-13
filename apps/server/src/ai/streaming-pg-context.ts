import type { PgPool } from "../db/pg-pool.js";
import { withPoolClient } from "../db/pg-sql-client.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import type { SqlClient } from "../db/types.js";
import type { AiRequestContext } from "./streaming-store.js";

export async function withAiContext<T>(
  pool: PgPool,
  context: AiRequestContext,
  operation: (client: SqlClient) => Promise<T>,
  readOnly = false,
): Promise<T> {
  return withPoolClient(pool, (client) =>
    withTenantTransaction(
      client,
      context.tenant,
      async (transaction) => {
        await transaction.query("SELECT set_config('app.auth_session_id', $1, true)", [
          context.authSessionId,
        ]);
        return operation(transaction);
      },
      { readOnly },
    ),
  );
}
