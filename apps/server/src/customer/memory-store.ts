/**
 * Process-local customer archive (M2).
 * Org-scoped in production; memory store is single-tenant for local/demo.
 */

import { randomUUID } from "node:crypto";

import type {
  CustomerMergeInput,
  CustomerMergeResult,
  CustomerMemberAccountMergePort,
  CustomerPrivacyActionInput,
  CustomerPrivacyEvent,
  CustomerRecord,
  CustomerSearchRow,
  CustomerStore,
  CustomerUpsertInput,
  CustomerUpsertOutcome,
  CustomerUpdateInput,
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
    merged_into_id: null,
  }),
  Object.freeze({
    customer_id: "c2222222-2222-4222-8222-222222222222",
    phone: "13800000222",
    name: "李四",
    note: "常客",
    created_at: 1_700_000_000,
    updated_at: 1_700_000_200,
    merged_into_id: null,
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
  private readonly privacyEvents: CustomerPrivacyEvent[] = [];

  constructor(
    seed: readonly CustomerRecord[] = DEMO_CUSTOMERS,
    private readonly memberAccounts?: CustomerMemberAccountMergePort,
  ) {
    this.rows = seed.map((row) => Object.freeze({ ...row }));
  }

  async search(query: string | undefined, limit: number): Promise<readonly CustomerSearchRow[]> {
    const capped = Math.max(0, Math.min(limit, 50));
    const q = typeof query === "string" ? query.trim() : "";
    const filtered = this.rows.filter(
      (row) => row.merged_into_id === null && row.anonymized_at == null && matchesQuery(row, q),
    );
    const newestFirst = [...filtered].sort((a, b) => b.updated_at - a.updated_at);
    return Object.freeze(newestFirst.slice(0, capped).map((row) => toSearchRow(row)));
  }

  async getByPhone(phone: string): Promise<CustomerRecord | null> {
    const row = this.rows.find(
      (candidate) => candidate.phone === phone && candidate.anonymized_at == null,
    );
    if (row === undefined) return null;
    if (row.merged_into_id === null) return row;
    return this.rows.find((candidate) => candidate.customer_id === row.merged_into_id) ?? null;
  }

  async getById(customerId: string): Promise<CustomerRecord | null> {
    return (
      this.rows.find(
        (row) =>
          row.customer_id === customerId &&
          row.merged_into_id === null &&
          row.anonymized_at == null,
      ) ?? null
    );
  }

  async upsert(input: CustomerUpsertInput): Promise<CustomerUpsertOutcome> {
    const now = input.now ?? Math.floor(Date.now() / 1000);
    const phoneIndex = this.rows.findIndex((row) => row.phone === input.phone);
    const redirectedId = phoneIndex >= 0 ? (this.rows[phoneIndex]?.merged_into_id ?? null) : null;
    const existingIndex =
      redirectedId === null
        ? phoneIndex
        : this.rows.findIndex((row) => row.customer_id === redirectedId);

    if (existingIndex >= 0) {
      const current = this.rows[existingIndex]!;
      const next: CustomerRecord = Object.freeze({
        customer_id: current.customer_id,
        phone: current.phone,
        name: input.name !== undefined ? input.name : current.name,
        note: input.note !== undefined ? input.note : current.note,
        created_at: current.created_at,
        updated_at: now,
        merged_into_id: null,
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
      merged_into_id: null,
    });
    this.rows.push(created);
    return Object.freeze({ customer: created, created: true });
  }

  async update(input: CustomerUpdateInput): Promise<CustomerRecord | null> {
    const index = this.rows.findIndex(
      (row) => row.customer_id === input.customer_id && row.merged_into_id === null,
    );
    if (index < 0) return null;
    const current = this.rows[index]!;
    const nextPhone = input.phone ?? current.phone;
    if (this.rows.some((row, rowIndex) => rowIndex !== index && row.phone === nextPhone)) {
      return null;
    }
    const next = Object.freeze({
      ...current,
      phone: nextPhone,
      name: input.name !== undefined ? input.name : current.name,
      note: input.note !== undefined ? input.note : current.note,
      updated_at: input.now,
    });
    this.rows[index] = next;
    return next;
  }

  async merge(input: CustomerMergeInput): Promise<CustomerMergeResult | null> {
    const sourceIndex = this.rows.findIndex(
      (row) =>
        row.customer_id === input.source_customer_id &&
        row.merged_into_id === null &&
        row.anonymized_at == null,
    );
    const target = this.rows.find(
      (row) =>
        row.customer_id === input.target_customer_id &&
        row.merged_into_id === null &&
        row.anonymized_at == null,
    );
    if (
      sourceIndex < 0 ||
      target === undefined ||
      input.source_customer_id === input.target_customer_id
    ) {
      return null;
    }
    const source = this.rows[sourceIndex]!;
    const memberOutcome = this.memberAccounts?.mergeCustomerMemberAccount(
      source.customer_id,
      target.customer_id,
    );
    if (memberOutcome === "conflict") return null;

    // There is deliberately no await between the domain-specific member port
    // and this assignment: both in-memory stores commit in one JS turn.
    this.rows[sourceIndex] = Object.freeze({
      ...source,
      merged_into_id: target.customer_id,
      updated_at: input.now,
    });
    return Object.freeze({
      source_customer_id: source.customer_id,
      target_customer_id: target.customer_id,
      relinked_order_count: 0,
    });
  }

  async findDuplicates(customerId: string, limit: number): Promise<readonly CustomerSearchRow[]> {
    const source = await this.getById(customerId);
    if (source === null || source.name === null) return Object.freeze([]);
    const name = source.name.trim().toLocaleLowerCase();
    return Object.freeze(
      this.rows
        .filter(
          (row) =>
            row.customer_id !== customerId &&
            row.merged_into_id === null &&
            row.anonymized_at == null &&
            row.name?.trim().toLocaleLowerCase() === name,
        )
        .sort((left, right) => right.updated_at - left.updated_at)
        .slice(0, Math.min(limit, 20))
        .map(toSearchRow),
    );
  }

  async privacyStatus(customerId: string) {
    const customer = await this.getById(customerId);
    if (customer === null) return null;
    return Object.freeze({
      customer_id: customer.customer_id,
      active_order_count: 0,
      retained_order_count: 0,
      photo_count: 0,
      latest_order_at: null,
      anonymization_eligible: true,
    });
  }

  async listPrivacyEvents(
    customerId: string,
    limit: number,
  ): Promise<readonly CustomerPrivacyEvent[]> {
    return Object.freeze(
      this.privacyEvents
        .filter((event) => event.customer_id === customerId)
        .slice(-Math.min(limit, 50))
        .reverse()
        .map((event) => Object.freeze({ ...event })),
    );
  }

  async exportPrivacy(input: CustomerPrivacyActionInput) {
    const customer = await this.getById(input.customer_id);
    if (customer === null) return null;
    this.privacyEvents.push(
      Object.freeze({
        event_id: input.event_id,
        customer_id: customer.customer_id,
        action: "exported",
        reason: input.reason,
        affected_order_count: 0,
        created_at: input.now,
      }),
    );
    return Object.freeze({
      format_version: 1 as const,
      exported_at: input.now,
      customer: Object.freeze({
        customer_id: customer.customer_id,
        phone: customer.phone,
        name: customer.name,
        note: customer.note,
        created_at: customer.created_at,
        updated_at: customer.updated_at,
      }),
      orders: Object.freeze([]),
      order_count: 0,
      truncated: false,
    });
  }

  async anonymize(input: CustomerPrivacyActionInput) {
    const index = this.rows.findIndex(
      (row) =>
        row.customer_id === input.customer_id &&
        row.merged_into_id === null &&
        row.anonymized_at == null,
    );
    if (index < 0) return null;
    const current = this.rows[index]!;
    this.rows[index] = Object.freeze({
      ...current,
      phone: `anon-${current.customer_id.replaceAll("-", "")}`,
      name: null,
      note: null,
      updated_at: input.now,
      anonymized_at: input.now,
    });
    this.privacyEvents.push(
      Object.freeze({
        event_id: input.event_id,
        customer_id: current.customer_id,
        action: "anonymized",
        reason: input.reason,
        affected_order_count: 0,
        created_at: input.now,
      }),
    );
    return Object.freeze({ customer_id: current.customer_id, affected_order_count: 0 });
  }
}

export function createMemoryCustomerStore(
  seed: readonly CustomerRecord[] = DEMO_CUSTOMERS,
  memberAccounts?: CustomerMemberAccountMergePort,
): CustomerStore {
  return new MemoryCustomerStore(seed, memberAccounts);
}
