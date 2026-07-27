/** Canonical request hashing and durable/process-local command replay helpers. */

import { createCommandError } from "@laundry/contracts";
import { createHash } from "node:crypto";

import type { TenantContext } from "../db/types.js";
import type {
  CommandIdempotencyStore,
  CommandRequest,
  CommandResult,
  DurableIdempotencyLookup,
  IdempotencyStore,
  TransactionalIdempotencyStore,
} from "./types.js";

export function asTransactionalIdempotencyStore(
  store: CommandIdempotencyStore | undefined,
): TransactionalIdempotencyStore | null {
  if (
    store !== undefined &&
    "lookup" in store &&
    "claim" in store &&
    "complete" in store &&
    typeof store.lookup === "function" &&
    typeof store.claim === "function" &&
    typeof store.complete === "function"
  ) {
    return store as TransactionalIdempotencyStore;
  }
  return null;
}

export async function readIdempotentReplay(
  tenant: TenantContext,
  request: CommandRequest,
  store: IdempotencyStore | undefined,
): Promise<CommandResult | null> {
  if (store === undefined || request.idempotencyKey === undefined) return null;
  return store.get(tenant, request.name, request.idempotencyKey);
}

export function durableLookupResult(lookup: DurableIdempotencyLookup): CommandResult | null {
  if (lookup.kind === "replay") return lookup.result;
  if (lookup.kind === "conflict") return fail("IDEMPOTENCY_CONFLICT");
  if (lookup.kind === "in_progress") return fail("RESOURCE_UNAVAILABLE");
  return null;
}

export function hashIdempotencyRequest(request: CommandRequest): string {
  const canonical = stableJson({
    name: request.name,
    version: request.version,
    input: request.input,
    dryRun: request.dryRun,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function fail(code: "IDEMPOTENCY_CONFLICT" | "RESOURCE_UNAVAILABLE"): CommandResult {
  return Object.freeze({ ok: false as const, error: createCommandError(code) });
}

function stableJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Idempotency request must be JSON-safe");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    const entries = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  throw new TypeError("Idempotency request must be JSON-safe");
}
