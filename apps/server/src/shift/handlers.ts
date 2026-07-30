/**
 * M2 shift handlers: shift.close + shift.get.
 */

import { createCommandError } from "@laundry/contracts";
import { businessDayStart } from "@laundry/domain";

import type { CommandHandler, HandlerOutcome } from "../bus/types.js";
import { HandlerCommandError } from "../bus/types.js";
import type { StatsQueryPort } from "../stats/types.js";
import { ShiftAlreadyClosedError } from "./memory-store.js";
import type { ShiftClosingRecord, ShiftStore } from "./types.js";

export type ShiftHandlerDeps = Readonly<{
  store: ShiftStore;
  stats: StatsQueryPort;
  now?: () => number;
  timeZone?: string;
  rolloverHour?: number;
}>;

const BUSINESS_DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;

function asRecord(parsed: unknown): Readonly<Record<string, unknown>> {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
  }
  return parsed as Readonly<Record<string, unknown>>;
}

function requireBusinessDate(value: unknown): string {
  if (typeof value !== "string" || !BUSINESS_DATE_RE.test(value)) {
    throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
  }
  return value;
}

function requireSignatureName(value: unknown): string {
  if (typeof value !== "string") {
    throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
  }
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 64) {
    throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
  }
  return trimmed;
}

function requireNonNegativeCents(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
  }
  return value;
}

function toCloseResult(row: ShiftClosingRecord): Readonly<Record<string, unknown>> {
  return Object.freeze({
    shift_id: row.shift_id,
    business_date: row.business_date,
    closed_at: row.closed_at,
    order_count: row.order_count,
    payable_cents: row.payable_cents,
    paid_cents: row.paid_cents,
    payment_cents: row.payment_cents,
    opening_float_cents: row.opening_float_cents,
    counted_cash_cents: row.counted_cash_cents,
    retained_float_cents: row.retained_float_cents,
    expected_cash_cents: row.expected_cash_cents,
    cash_difference_cents: row.cash_difference_cents,
    period_started_at: row.period_started_at,
    period_ended_at: row.period_ended_at,
    signature_name: row.signature_name,
    closed_by_staff_id: row.closed_by_staff_id,
    note: row.note,
  });
}

function closeHandler(deps: ShiftHandlerDeps): CommandHandler {
  return async (ctx): Promise<HandlerOutcome> => {
    const input = asRecord(ctx.parsed);
    const businessDate = requireBusinessDate(input.business_date);
    const countedCashCents = requireNonNegativeCents(input.counted_cash_cents);
    const retainedFloatCents = requireNonNegativeCents(input.retained_float_cents);
    const signatureName = requireSignatureName(input.signature_name);
    const note = typeof input.note === "string" ? input.note : undefined;
    const now = deps.now?.() ?? Math.floor(Date.now() / 1000);

    const summary = await deps.stats.daySummary({
      orgId: ctx.tenant.orgId,
      storeId: ctx.tenant.storeId,
      businessDate,
    });
    const cash = await deps.stats.cashSummary({
      orgId: ctx.tenant.orgId,
      storeId: ctx.tenant.storeId,
      businessDate,
    });
    const previous = await deps.store.getMostRecent(ctx.tenant.orgId, ctx.tenant.storeId);
    const openingFloatCents = previous?.retained_float_cents ?? 0;
    const expectedCashCents = openingFloatCents + cash.cash_cents;
    if (!Number.isSafeInteger(expectedCashCents) || expectedCashCents < 0) {
      throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
    }
    const cashDifferenceCents = countedCashCents - expectedCashCents;

    let record: ShiftClosingRecord;
    try {
      record = await deps.store.close({
        org_id: ctx.tenant.orgId,
        store_id: ctx.tenant.storeId,
        business_date: businessDate,
        closed_by_staff_id: ctx.actor.staffId,
        signature_name: signatureName,
        ...(note !== undefined ? { note } : {}),
        snapshot: Object.freeze({
          order_count: summary.order_count,
          payable_cents: summary.payable_cents,
          paid_cents: summary.paid_cents,
          payment_cents: summary.payment_cents,
          opening_float_cents: openingFloatCents,
          counted_cash_cents: countedCashCents,
          retained_float_cents: retainedFloatCents,
          expected_cash_cents: expectedCashCents,
          cash_difference_cents: cashDifferenceCents,
          period_started_at:
            previous?.closed_at ??
            Math.floor(
              businessDayStart(
                businessDate,
                deps.timeZone ?? "UTC",
                deps.rolloverHour ?? 0,
              ).getTime() / 1000,
            ),
          period_ended_at: now,
        }),
        closed_at: now,
      });
    } catch (error) {
      if (error instanceof ShiftAlreadyClosedError) {
        throw new HandlerCommandError(
          createCommandError("IDEMPOTENCY_CONFLICT", {
            kind: "reason",
            reason: "idempotency_conflict",
          }),
        );
      }
      throw error;
    }

    return Object.freeze({
      result: toCloseResult(record),
      audit: Object.freeze({
        entity: "shift_closing",
        entityId: record.shift_id,
        afterJson: JSON.stringify({
          business_date: record.business_date,
          signature_name: record.signature_name,
          order_count: record.order_count,
          payable_cents: record.payable_cents,
          paid_cents: record.paid_cents,
          payment_cents: record.payment_cents,
          expected_cash_cents: record.expected_cash_cents,
          counted_cash_cents: record.counted_cash_cents,
          cash_difference_cents: record.cash_difference_cents,
        }),
      }),
      events: Object.freeze([
        Object.freeze({
          type: "shift.closed",
          payload: Object.freeze({
            shift_id: record.shift_id,
            business_date: record.business_date,
            closed_at: record.closed_at,
          }),
        }),
      ]),
    });
  };
}

function getHandler(deps: ShiftHandlerDeps): CommandHandler {
  return async (ctx): Promise<HandlerOutcome> => {
    const input = asRecord(ctx.parsed);
    const businessDate = requireBusinessDate(input.business_date);
    const row = await deps.store.getByBusinessDate(
      ctx.tenant.orgId,
      ctx.tenant.storeId,
      businessDate,
    );
    return Object.freeze({
      result: row === null ? null : toCloseResult(row),
    });
  };
}

function historyHandler(deps: ShiftHandlerDeps): CommandHandler {
  return async (ctx): Promise<HandlerOutcome> => {
    const input = asRecord(ctx.parsed);
    const dateFrom = requireBusinessDate(input.date_from);
    const dateTo = requireBusinessDate(input.date_to);
    const limit =
      typeof input.limit === "number" && Number.isSafeInteger(input.limit)
        ? Math.min(input.limit, 100)
        : 31;
    const rows = await deps.store.listHistory(
      ctx.tenant.orgId,
      ctx.tenant.storeId,
      dateFrom,
      dateTo,
      limit,
    );
    return Object.freeze({
      result: Object.freeze({ shifts: Object.freeze(rows.map(toCloseResult)) }),
    });
  };
}

export function registerShiftCommandHandlers(
  registry: Readonly<{ registerHandler: (name: string, handler: CommandHandler) => void }>,
  deps: ShiftHandlerDeps,
): void {
  registry.registerHandler("shift.close", closeHandler(deps));
}

export function registerShiftQueryHandlers(
  registry: Readonly<{ registerHandler: (name: string, handler: CommandHandler) => void }>,
  deps: ShiftHandlerDeps,
): void {
  registry.registerHandler("shift.get", getHandler(deps));
  registry.registerHandler("shift.history", historyHandler(deps));
}
