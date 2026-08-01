import { createMemoryMemberStore } from "./memory-store.js";
import type { MemberRuntimeDeps } from "./handlers.js";

/**
 * Memory runtime: the caller supplies which customers exist so opening an
 * account for an unknown one is refused exactly as PostgreSQL's FK would.
 */
export function createMemoryMemberDeps(customerIds: readonly string[]): MemberRuntimeDeps {
  return Object.freeze({
    persistence: "memory" as const,
    store: createMemoryMemberStore({ customerIds }),
  });
}

/**
 * PostgreSQL runtime. The real store is built per request from the transaction
 * client, so this placeholder is never the one that runs (see resolveStore).
 */
export function createPgMemberDeps(): MemberRuntimeDeps {
  return Object.freeze({
    persistence: "sql" as const,
    store: createMemoryMemberStore({ customerIds: [] }),
  });
}
