/**
 * Process-local shift closings (M2 skeleton).
 * One close per org|store|business_date; append-only.
 */

import { randomUUID } from "node:crypto";

import type { ShiftCloseInput, ShiftClosingRecord, ShiftStore } from "./types.js";

function storeKey(orgId: string, storeId: string, businessDate: string): string {
  return `${orgId}|${storeId}|${businessDate}`;
}

export class MemoryShiftStore implements ShiftStore {
  private readonly byDate = new Map<string, ShiftClosingRecord>();

  async getByBusinessDate(
    orgId: string,
    storeId: string,
    businessDate: string,
  ): Promise<ShiftClosingRecord | null> {
    return this.byDate.get(storeKey(orgId, storeId, businessDate)) ?? null;
  }

  async close(input: ShiftCloseInput): Promise<ShiftClosingRecord> {
    const key = storeKey(input.org_id, input.store_id, input.business_date);
    if (this.byDate.has(key)) {
      throw new ShiftAlreadyClosedError(input.business_date);
    }

    const record: ShiftClosingRecord = Object.freeze({
      shift_id: input.shift_id ?? randomUUID(),
      org_id: input.org_id,
      store_id: input.store_id,
      business_date: input.business_date,
      closed_by_staff_id: input.closed_by_staff_id,
      note: input.note ?? null,
      order_count: input.snapshot.order_count,
      payable_cents: input.snapshot.payable_cents,
      paid_cents: input.snapshot.paid_cents,
      payment_cents: input.snapshot.payment_cents,
      opening_float_cents: input.snapshot.opening_float_cents ?? 0,
      counted_cash_cents: input.snapshot.counted_cash_cents ?? 0,
      retained_float_cents: input.snapshot.retained_float_cents ?? 0,
      expected_cash_cents: input.snapshot.expected_cash_cents ?? 0,
      cash_difference_cents: input.snapshot.cash_difference_cents ?? 0,
      signature_name: input.signature_name,
      period_started_at: input.snapshot.period_started_at ?? input.closed_at,
      period_ended_at: input.snapshot.period_ended_at ?? input.closed_at,
      closed_at: input.closed_at,
    });
    this.byDate.set(key, record);
    return record;
  }

  async getMostRecentBefore(
    orgId: string,
    storeId: string,
    businessDate: string,
  ): Promise<ShiftClosingRecord | null> {
    const prefix = `${orgId}|${storeId}|`;
    let current: ShiftClosingRecord | null = null;
    for (const [key, row] of this.byDate) {
      if (!key.startsWith(prefix) || row.business_date >= businessDate) continue;
      if (current === null || row.business_date > current.business_date) current = row;
    }
    return current;
  }

  async listHistory(
    orgId: string,
    storeId: string,
    dateFrom: string,
    dateTo: string,
    limit: number,
  ): Promise<readonly ShiftClosingRecord[]> {
    const prefix = `${orgId}|${storeId}|`;
    return Object.freeze(
      [...this.byDate]
        .filter(
          ([key, row]) =>
            key.startsWith(prefix) && row.business_date >= dateFrom && row.business_date <= dateTo,
        )
        .map(([, row]) => row)
        .sort((left, right) => right.business_date.localeCompare(left.business_date))
        .slice(0, Math.min(limit, 100)),
    );
  }

  clear(): void {
    this.byDate.clear();
  }
}

export class ShiftAlreadyClosedError extends Error {
  readonly businessDate: string;

  constructor(businessDate: string) {
    super(`Shift already closed for ${businessDate}`);
    this.name = "ShiftAlreadyClosedError";
    this.businessDate = businessDate;
  }
}

export function createMemoryShiftStore(): MemoryShiftStore {
  return new MemoryShiftStore();
}
