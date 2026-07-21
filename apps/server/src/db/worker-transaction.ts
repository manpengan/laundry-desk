import { withTenantTransaction } from "./tenant-transaction.js";
import type { SqlClient, TenantContext, TenantTransactionFn } from "./types.js";

/**
 * Worker / queue path for tenant GUC injection.
 *
 * Architecture §4 / ADR-02: background tasks and queue workers MUST use the same
 * transaction-local GUC injection as request handlers. Naked connections (no
 * app.org_id / app.store_id / app.staff_id) are forbidden — M0-1 "worker 漏注入"
 * is a CI-gated negative case.
 *
 * This helper is intentionally a thin alias of withTenantTransaction so there is
 * exactly one injection implementation. Callers must still resolve TenantContext
 * from job payload + server-side authorization (never trust the job alone for
 * org/store when staff identity is involved — C8 will own that membrane).
 *
 * packages/db note: workers share the laundry_app role (NOBYPASSRLS). Migration
 * and maintenance work goes through bypass.ts + owner role, not this path.
 */
export async function withWorkerTenantTransaction<TResult>(
  client: SqlClient,
  ctx: TenantContext | unknown,
  fn: TenantTransactionFn<TResult>,
): Promise<TResult> {
  return withTenantTransaction(client, ctx, fn);
}
