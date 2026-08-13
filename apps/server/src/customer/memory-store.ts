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
import { CustomerErasedError as ErasedCustomer } from "./types.js";

/** Demo seed phones (seed range 13800000xxx — never real PII). */
export const DEMO_CUSTOMERS: readonly CustomerRecord[] = Object.freeze([
  Object.freeze({
    customer_id: "c1111111-1111-4111-8111-111111111111",
    phone: "13800000111",
    name: "张三",
    note: null,
    version: 1,
    created_at: 1_700_000_000,
    updated_at: 1_700_000_100,
    merged_into_id: null,
  }),
  Object.freeze({
    customer_id: "c2222222-2222-4222-8222-222222222222",
    phone: "13800000222",
    name: "李四",
    note: "常客",
    version: 1,
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
    version: row.version,
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
  private rows: readonly CustomerRecord[];
  private privacyEvents: readonly CustomerPrivacyEvent[] = Object.freeze([]);
  private erasedPhones: ReadonlySet<string> = new Set();

  constructor(
    seed: readonly CustomerRecord[] = DEMO_CUSTOMERS,
    private readonly memberAccounts?: CustomerMemberAccountMergePort,
  ) {
    this.rows = Object.freeze(seed.map((row) => Object.freeze({ ...row })));
  }

  private rootFor(customerId: string): CustomerRecord | null {
    let currentId = customerId;
    const visited = new Set<string>();
    for (let depth = 0; depth <= 64; depth += 1) {
      if (visited.has(currentId)) throw new Error("customer merge cycle detected");
      visited.add(currentId);
      const current = this.rows.find((row) => row.customer_id === currentId);
      if (current === undefined) return null;
      if (current.merged_into_id === null) return current;
      currentId = current.merged_into_id;
    }
    throw new Error("customer merge depth exceeded");
  }
  private groupFor(customerId: string): readonly CustomerRecord[] {
    const root = this.rootFor(customerId);
    if (root === null) return Object.freeze([]);
    const group = this.rows.filter(
      (candidate) => this.rootFor(candidate.customer_id)?.customer_id === root.customer_id,
    );
    if (group.length > 1000) throw new Error("customer merge group size exceeded");
    return Object.freeze(group);
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
    const root = this.rootFor(row.customer_id);
    return root?.anonymized_at == null ? root : null;
  }
  async getById(customerId: string): Promise<CustomerRecord | null> {
    const root = this.rootFor(customerId);
    return root?.anonymized_at == null ? root : null;
  }

  async resolveCanonicalId(customerId: string): Promise<string | null> {
    const root = this.rootFor(customerId);
    return root !== null && root.anonymized_at == null ? root.customer_id : null;
  }

  async listCanonicalGroup(customerId: string): Promise<readonly string[]> {
    const root = this.rootFor(customerId);
    if (root === null || root.anonymized_at != null) return Object.freeze([]);
    return Object.freeze(this.groupFor(customerId).map((row) => row.customer_id));
  }

  async upsert(input: CustomerUpsertInput): Promise<CustomerUpsertOutcome> {
    if (this.erasedPhones.has(input.phone)) throw new ErasedCustomer();
    const now = input.now ?? Math.floor(Date.now() / 1000);
    const phoneIndex = this.rows.findIndex((row) => row.phone === input.phone);
    const source = phoneIndex < 0 ? null : this.rows[phoneIndex]!;
    const root = source === null ? null : this.rootFor(source.customer_id);
    const existingIndex =
      root === null ? -1 : this.rows.findIndex((row) => row.customer_id === root.customer_id);

    if (existingIndex >= 0) {
      const current = this.rows[existingIndex]!;
      if (current.anonymized_at != null) throw new ErasedCustomer();
      const next: CustomerRecord = Object.freeze({
        customer_id: current.customer_id,
        phone: current.phone,
        name: input.name !== undefined ? input.name : current.name,
        note: input.note !== undefined ? input.note : current.note,
        version: current.version + 1,
        created_at: current.created_at,
        updated_at: now,
        merged_into_id: null,
      });
      this.rows = Object.freeze(
        this.rows.map((row, index) => (index === existingIndex ? next : row)),
      );
      return Object.freeze({ customer: next, created: false });
    }

    const created: CustomerRecord = Object.freeze({
      customer_id: input.customer_id ?? randomUUID(),
      phone: input.phone,
      name: input.name ?? null,
      note: input.note ?? null,
      version: 1,
      created_at: now,
      updated_at: now,
      merged_into_id: null,
    });
    this.rows = Object.freeze([...this.rows, created]);
    return Object.freeze({ customer: created, created: true });
  }

  async update(input: CustomerUpdateInput): Promise<CustomerRecord | null> {
    const root = this.rootFor(input.customer_id);
    const index = this.rows.findIndex((row) => row.customer_id === root?.customer_id);
    if (index < 0) return null;
    const current = this.rows[index]!;
    if (current.anonymized_at != null || current.version !== input.expected_version) return null;
    const nextPhone = input.phone ?? current.phone;
    if (this.erasedPhones.has(nextPhone)) throw new ErasedCustomer();
    if (this.rows.some((row, rowIndex) => rowIndex !== index && row.phone === nextPhone)) {
      return null;
    }
    const next = Object.freeze({
      ...current,
      phone: nextPhone,
      name: input.name !== undefined ? input.name : current.name,
      note: input.note !== undefined ? input.note : current.note,
      version: current.version + 1,
      updated_at: input.now,
    });
    this.rows = Object.freeze(this.rows.map((row, rowIndex) => (rowIndex === index ? next : row)));
    return next;
  }

  async merge(input: CustomerMergeInput): Promise<CustomerMergeResult | null> {
    const source = this.rootFor(input.source_customer_id);
    const target = this.rootFor(input.target_customer_id);
    if (
      source === null ||
      target === null ||
      source.customer_id === target.customer_id ||
      source.anonymized_at != null ||
      target.anonymized_at != null
    ) {
      return null;
    }
    const affectedIds = new Set(
      [...this.groupFor(source.customer_id), ...this.groupFor(target.customer_id)].map(
        (row) => row.customer_id,
      ),
    );
    if (affectedIds.size > 1000) return null;
    const memberOutcome = this.memberAccounts?.mergeCustomerMemberAccount(
      source.customer_id,
      target.customer_id,
    );
    if (memberOutcome === "conflict") return null;
    // There is deliberately no await between the domain-specific member port
    // and this replacement: both in-memory stores commit in one JS turn.
    this.rows = Object.freeze(
      this.rows.map((row) =>
        affectedIds.has(row.customer_id)
          ? Object.freeze({
              ...row,
              merged_into_id: row.customer_id === target.customer_id ? null : target.customer_id,
              version: row.version + 1,
              updated_at: input.now,
            })
          : row,
      ),
    );
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
    const groupIds = new Set(this.groupFor(customerId).map((row) => row.customer_id));
    if (groupIds.size === 0) return Object.freeze([]);
    return Object.freeze(
      this.privacyEvents
        .filter((event) => groupIds.has(event.customer_id))
        .slice(-Math.min(limit, 50))
        .reverse()
        .map((event) => Object.freeze({ ...event })),
    );
  }

  async exportPrivacy(input: CustomerPrivacyActionInput) {
    const customer = await this.getById(input.customer_id);
    if (customer === null) return null;
    const canonicalCustomers = this.groupFor(customer.customer_id);
    this.privacyEvents = Object.freeze([
      ...this.privacyEvents,
      Object.freeze({
        event_id: input.event_id,
        customer_id: customer.customer_id,
        action: "exported",
        reason: input.reason,
        affected_order_count: 0,
        created_at: input.now,
      }),
    ]);
    return Object.freeze({
      format_version: 2 as const,
      exported_at: input.now,
      customer: Object.freeze({
        customer_id: customer.customer_id,
        phone: customer.phone,
        name: customer.name,
        note: customer.note,
        created_at: customer.created_at,
        updated_at: customer.updated_at,
      }),
      canonical_customers: Object.freeze(
        canonicalCustomers.map((row) =>
          Object.freeze({
            customer_id: row.customer_id,
            phone: row.phone,
            name: row.name,
            note: row.note,
            merged_into_id: row.merged_into_id,
            created_at: row.created_at,
            updated_at: row.updated_at,
          }),
        ),
      ),
      canonical_customer_count: canonicalCustomers.length,
      profile: null,
      profiles: Object.freeze([]),
      profile_count: 0,
      profiles_truncated: false,
      addresses: Object.freeze([]),
      address_count: 0,
      addresses_truncated: false,
      retired_address_count: 0,
      identifiers: Object.freeze([]),
      identifier_count: 0,
      identifiers_truncated: false,
      retired_identifier_count: 0,
      related_narratives: Object.freeze([]),
      related_narrative_count: 0,
      related_narratives_truncated: false,
      retained_garment_photo_count: 0,
      notification_deliveries: Object.freeze([]),
      notification_delivery_count: 0,
      notification_deliveries_truncated: false,
      factory_handoff_evidence: Object.freeze([]),
      factory_handoff_evidence_count: 0,
      factory_handoff_evidence_truncated: false,
      delivery_evidence_count: 0,
      delivery_attachment_count: 0,
      delivery_evidence_retention: "retained_operational_evidence",
      delivery_unlinked_upload_cleanup: "private_file_purged_after_expiry_metadata_retained",
      orders: Object.freeze([]),
      order_count: 0,
      truncated: false,
    });
  }

  async anonymize(input: CustomerPrivacyActionInput) {
    const current = this.rootFor(input.customer_id);
    if (current === null || current.anonymized_at != null) return null;
    const group = this.groupFor(current.customer_id);
    const groupIds = new Set(group.map((row) => row.customer_id));
    this.erasedPhones = new Set([
      ...this.erasedPhones,
      ...group.map((row) => row.phone).filter((phone) => /^1[3-9]\d{9}$/u.test(phone)),
    ]);
    this.rows = Object.freeze(
      this.rows.map((row) =>
        groupIds.has(row.customer_id)
          ? Object.freeze({
              ...row,
              phone: `anon-${row.customer_id.replaceAll("-", "")}`,
              name: null,
              note: null,
              version: row.version + 1,
              updated_at: input.now,
              anonymized_at: input.now,
            })
          : row,
      ),
    );
    this.privacyEvents = Object.freeze([
      ...this.privacyEvents,
      Object.freeze({
        event_id: input.event_id,
        customer_id: current.customer_id,
        action: "anonymized",
        reason: input.reason,
        affected_order_count: 0,
        created_at: input.now,
      }),
    ]);
    return Object.freeze({ customer_id: current.customer_id, affected_order_count: 0 });
  }
}

export function createMemoryCustomerStore(
  seed: readonly CustomerRecord[] = DEMO_CUSTOMERS,
  memberAccounts?: CustomerMemberAccountMergePort,
): CustomerStore {
  return new MemoryCustomerStore(seed, memberAccounts);
}
