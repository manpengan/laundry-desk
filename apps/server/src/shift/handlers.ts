/**
 * M2 shift handlers: shift.close + shift.get.
 */

import { createCommandError } from "@laundry/contracts";

import type { CommandHandler, HandlerOutcome } from "../bus/types.js";
import { HandlerCommandError } from "../bus/types.js";
import type { StatsQueryPort } from "../stats/types.js";
import { ShiftAlreadyClosedError } from "./memory-store.js";
import type { ShiftClosingRecord, ShiftStore } from "./types.js";

export type ShiftHandlerDeps = Readonly<{
  store: ShiftStore;
  stats: StatsQueryPort;
  now?: () => number;
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

function toCloseResult(row: ShiftClosingRecord): Readonly<Record<string, unknown>> {
  return Object.freeze({
    shift_id: row.shift_id,
    business_date: row.business_date,
    closed_at: row.closed_at,
    order_count: row.order_count,
    payable_cents: row.payable_cents,
    paid_cents: row.paid_cents,
    payment_cents: row.payment_cents,
    signature_name: row.signature_name,
    closed_by_staff_id: row.closed_by_staff_id,
    note: row.note,
  });
}

function closeHandler(deps: ShiftHandlerDeps): CommandHandler {
  return async (ctx): Promise<HandlerOutcome> => {
    const input = asRecord(ctx.parsed);
    const businessDate = requireBusinessDate(input.business_date);
    const signatureName = requireSignatureName(input.signature_name);
    const note = typeof input.note === "string" ? input.note : undefined;
    const now = deps.now?.() ?? Math.floor(Date.now() / 1000);

    const summary = await deps.stats.daySummary({
      orgId: ctx.tenant.orgId,
      storeId: ctx.tenant.storeId,
      businessDate,
    });

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
}
