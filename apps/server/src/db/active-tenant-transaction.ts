/**
 * Request-local binding for the command bus transaction.
 *
 * PG repositories normally open their own GUC-scoped transaction for direct
 * use. When called from a command handler they must instead reuse the bus
 * transaction so the business write and its audit row commit or roll back
 * together. AsyncLocalStorage keeps that binding private to the server call
 * chain; it is never populated from request arguments.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import type { SqlClient, TenantContext } from "./types.js";

export type ActiveTenantTransaction = Readonly<{
  client: SqlClient;
  tenant: TenantContext;
}>;

const activeTenantTransaction = new AsyncLocalStorage<ActiveTenantTransaction>();

export function runWithActiveTenantTransaction<T>(
  value: ActiveTenantTransaction,
  fn: () => Promise<T>,
): Promise<T> {
  return activeTenantTransaction.run(value, fn);
}

export function getActiveTenantTransaction(): ActiveTenantTransaction | undefined {
  return activeTenantTransaction.getStore();
}
