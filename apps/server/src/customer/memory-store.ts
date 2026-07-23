/**
 * Process-local customer archive (M2).
 * Org-scoped in production; memory store is single-tenant for local/demo.
 */

import { randomUUID } from "node:crypto";

import type {
  CustomerRecord,
  CustomerSearchRow,
  CustomerStore,
  CustomerUpsertInput,
  CustomerUpsertOutcome,
} from "./types.js";

/** Demo seed phones (seed range 13800000xxx — never real PII). */
export const DEMO_CUSTOMERS: readonly CustomerRecord[] = Object.freeze([
  Object.freeze({
    customer_id: "c1111111-1111-4111-8111-111111111111",
    phone: "13800000111",
    name: "张三",
    note: null,
    created_at: 1_700_000_000,
    updated_at: 1_700_000_100,
  }),
  Object.freeze({
    customer_id: "c2222222-2222-4222-8222-222222222222",
    phone: "13800000222",
    name: "李四",
    note: "常客",
    created_at: 1_700_000_000,
    updated_at: 1_700_000_200,
  }),
]);

function toSearchRow(row: CustomerRecord): CustomerSearchRow {
  return Object.freeze({
    customer_id: row.customer_id,
    phone: row.phone,
    name: row.name,
    note: row.note,
    updated_at: row.updated_at,
  });
}

function matchesQuery(row: CustomerRecord, query: string): boolean {
  if (query.length === 0) return true;
  const q = query.toLowerCase();
  if (row.phone.startsWith(query) || row.phone.includes(query)) return true;
  if (row.name !== null && row.name.toLowerCase().includes(q)) return true;
  return false;
}

export class MemoryCustomerStore implements CustomerStore {
  private readonly rows: CustomerRecord[];

  constructor(seed: readonly CustomerRecord[] = DEMO_CUSTOMERS) {
    this.rows = seed.map((row) => Object.freeze({ ...row }));
  }

  async search(query: string | undefined, limit: number): Promise<readonly CustomerSearchRow[]> {
    const capped = Math.max(0, Math.min(limit, 50));
    const q = typeof query === "string" ? query.trim() : "";
    const filtered = this.rows.filter((row) => matchesQuery(row, q));
    const newestFirst = [...filtered].sort((a, b) => b.updated_at - a.updated_at);
    return Object.freeze(newestFirst.slice(0, capped).map((row) => toSearchRow(row)));
  }

  async getByPhone(phone: string): Promise<CustomerRecord | null> {
    return this.rows.find((row) => row.phone === phone) ?? null;
  }

  async upsert(input: CustomerUpsertInput): Promise<CustomerUpsertOutcome> {
    const now = input.now ?? Math.floor(Date.now() / 1000);
    const existingIndex = this.rows.findIndex((row) => row.phone === input.phone);

    if (existingIndex >= 0) {
      const current = this.rows[existingIndex]!;
      const next: CustomerRecord = Object.freeze({
        customer_id: current.customer_id,
        phone: current.phone,
        name: input.name !== undefined ? input.name : current.name,
        note: input.note !== undefined ? input.note : current.note,
        created_at: current.created_at,
        updated_at: now,
      });
      this.rows[existingIndex] = next;
      return Object.freeze({ customer: next, created: false });
    }

    const created: CustomerRecord = Object.freeze({
      customer_id: input.customer_id ?? randomUUID(),
      phone: input.phone,
      name: input.name ?? null,
      note: input.note ?? null,
      created_at: now,
      updated_at: now,
    });
    this.rows.push(created);
    return Object.freeze({ customer: created, created: true });
  }
}

export function createMemoryCustomerStore(
  seed: readonly CustomerRecord[] = DEMO_CUSTOMERS,
): CustomerStore {
  return new MemoryCustomerStore(seed);
}
