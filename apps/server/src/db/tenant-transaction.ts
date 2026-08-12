import { buildSetLocalGucStatements, parseTenantContext } from "./guc.js";
import { runWithActiveTenantTransaction } from "./active-tenant-transaction.js";
import { runWithMemoryUnitOfWork } from "./memory-unit-of-work.js";
import type { SqlClient, TenantContext, TenantTransactionFn } from "./types.js";

export type TenantTransactionOptions = Readonly<{
  isolation?: "read_committed" | "repeatable_read";
  readOnly?: boolean;
}>;

function beginSql(options: TenantTransactionOptions): string {
  const isolation =
    options.isolation === "repeatable_read" ? " ISOLATION LEVEL REPEATABLE READ" : "";
  const readOnly = options.readOnly === true ? " READ ONLY" : "";
  return `BEGIN${isolation}${readOnly}`;
}

/**
 * Run `fn` inside a single Postgres transaction with tenant GUCs applied via SET LOCAL
 * semantics (`set_config(..., is_local := true)`).
 *
 * Lifecycle:
 *   BEGIN → apply app.org_id / app.store_id / app.staff_id → fn → COMMIT
 *   on any error after BEGIN → ROLLBACK (best-effort) → rethrow
 *
 * `client` is an injected port (fake in unit tests; packages/db adapter in production).
 * Do not open a second nested transaction here — callers compose one transaction per request.
 */
export async function withTenantTransaction<TResult>(
  client: SqlClient,
  ctx: TenantContext | unknown,
  fn: TenantTransactionFn<TResult>,
  options: TenantTransactionOptions = {},
): Promise<TResult> {
  const tenant = parseTenantContext(ctx);
  const statements = buildSetLocalGucStatements(tenant);

  await client.query(beginSql(options));
  try {
    const execute = async () => {
      for (const statement of statements) {
        await client.query(statement.sql, statement.values);
      }
      const result = await runWithActiveTenantTransaction(Object.freeze({ client, tenant }), () =>
        fn(client),
      );
      await client.query("COMMIT");
      return result;
    };
    return await (client.memoryTransaction === true ? runWithMemoryUnitOfWork(execute) : execute());
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  }
}

async function rollbackQuietly(client: SqlClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Prefer the original business/query error; ROLLBACK failure is secondary.
  }
}
