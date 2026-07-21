/**
 * Tenant-scoped idempotency store port + in-memory implementation for tests.
 * Production will persist in Postgres; M1 skeleton uses memory only.
 */

import type { CommandResult, IdempotencyStore } from "./types.js";
import type { TenantContext } from "../db/types.js";

const scopeKey = (tenant: TenantContext, command: string, key: string): string =>
  `${tenant.orgId}:${tenant.storeId}:${command}:${key}`;

/** Process-local store — not shared across instances; tests inject this. */
export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly map = new Map<string, CommandResult>();

  async get(tenant: TenantContext, command: string, key: string): Promise<CommandResult | null> {
    return this.map.get(scopeKey(tenant, command, key)) ?? null;
  }

  async put(
    tenant: TenantContext,
    command: string,
    key: string,
    result: CommandResult,
  ): Promise<void> {
    if (result.ok !== true) return;
    this.map.set(scopeKey(tenant, command, key), result);
  }

  size(): number {
    return this.map.size;
  }
}
