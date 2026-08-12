import type { SqlClient, TenantContext } from "../db/types.js";
import { registerMemoryCommit } from "../db/memory-unit-of-work.js";
import type {
  CommandResult,
  DurableIdempotencyLookup,
  IdempotencyStore,
  TransactionalIdempotencyStore,
} from "./types.js";

const scopeKey = (tenant: TenantContext, command: string, key: string): string =>
  `${tenant.orgId}:${tenant.storeId}:${command}:${key}`;

type MemoryEntry = Readonly<{
  requestHash: string | null;
  status: "in_progress" | "completed";
  result: CommandResult | null;
}>;

function lookupEntry(
  entry: MemoryEntry | undefined,
  requestHash: string,
): DurableIdempotencyLookup {
  if (entry === undefined) return Object.freeze({ kind: "miss" });
  if (entry.requestHash !== requestHash) return Object.freeze({ kind: "conflict" });
  if (entry.status === "in_progress") return Object.freeze({ kind: "in_progress" });
  if (entry.result === null) throw new Error("Completed memory idempotency entry has no result");
  return Object.freeze({ kind: "replay", result: entry.result });
}

export class MemoryIdempotencyStore implements IdempotencyStore, TransactionalIdempotencyStore {
  private entries: ReadonlyMap<string, MemoryEntry> = new Map();

  async get(tenant: TenantContext, command: string, key: string): Promise<CommandResult | null> {
    const entry = this.entries.get(scopeKey(tenant, command, key));
    return entry?.status === "completed" ? entry.result : null;
  }

  async put(
    tenant: TenantContext,
    command: string,
    key: string,
    result: CommandResult,
  ): Promise<void> {
    if (!result.ok) return;
    this.replace(
      scopeKey(tenant, command, key),
      Object.freeze({ requestHash: null, status: "completed", result }),
    );
  }

  async lookup(
    tenant: TenantContext,
    command: string,
    key: string,
    requestHash: string,
  ): Promise<DurableIdempotencyLookup> {
    return lookupEntry(this.entries.get(scopeKey(tenant, command, key)), requestHash);
  }

  async claim(
    _client: SqlClient,
    tenant: TenantContext,
    command: string,
    key: string,
    requestHash: string,
  ): Promise<DurableIdempotencyLookup> {
    const scoped = scopeKey(tenant, command, key);
    const decision = lookupEntry(this.entries.get(scoped), requestHash);
    if (decision.kind !== "miss") return decision;
    this.replace(scoped, Object.freeze({ requestHash, status: "in_progress", result: null }));
    return decision;
  }

  async complete(
    _client: SqlClient,
    tenant: TenantContext,
    command: string,
    key: string,
    requestHash: string,
    result: CommandResult,
  ): Promise<void> {
    const scoped = scopeKey(tenant, command, key);
    const current = this.entries.get(scoped);
    if (current?.requestHash !== requestHash || current.status !== "in_progress") {
      throw new Error("Unable to complete memory idempotency claim");
    }
    const completed = Object.freeze({ requestHash, status: "completed" as const, result });
    registerMemoryCommit(
      () => this.entries.get(scoped) === current,
      () => this.replace(scoped, completed),
    );
  }

  async abort(
    tenant: TenantContext,
    command: string,
    key: string,
    requestHash: string,
  ): Promise<void> {
    const scoped = scopeKey(tenant, command, key);
    if (this.entries.get(scoped)?.requestHash !== requestHash) return;
    const next = new Map(this.entries);
    next.delete(scoped);
    this.entries = next;
  }

  size(): number {
    return this.entries.size;
  }

  private replace(key: string, entry: MemoryEntry): void {
    this.entries = new Map([...this.entries, [key, entry]]);
  }
}
