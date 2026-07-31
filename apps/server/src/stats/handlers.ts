/**
 * M2 stats handlers: stats.day.summary (order-backed or seeded).
 */

import { BusinessDateSchema, createCommandError } from "@laundry/contracts";
import { businessDayAt } from "@laundry/domain";

import type { CommandHandler, HandlerOutcome } from "../bus/types.js";
import { HandlerCommandError } from "../bus/types.js";
import type { StatsQueryPort } from "./types.js";

export type StatsHandlerDeps = Readonly<{
  source: StatsQueryPort;
  /** Store calendar settings; omitted only in older isolated tests. */
  timeZone?: string;
  rolloverHour?: number;
  now?: () => Date;
}>;

function asRecord(parsed: unknown): Readonly<Record<string, unknown>> {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
  }
  return parsed as Readonly<Record<string, unknown>>;
}

function resolveBusinessDate(value: unknown, deps: StatsHandlerDeps): string {
  if (value === undefined) {
    return businessDayAt(deps.now?.() ?? new Date(), deps.timeZone ?? "UTC", deps.rolloverHour ?? 0)
      .business_date;
  }
  const parsed = BusinessDateSchema.safeParse(value);
  if (!parsed.success) {
    throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
  }
  return parsed.data;
}

function daySummaryHandler(deps: StatsHandlerDeps): CommandHandler {
  return async (ctx): Promise<HandlerOutcome> => {
    const input = asRecord(ctx.parsed);
    const businessDate = resolveBusinessDate(input.business_date, deps);
    const summary = await deps.source.daySummary({
      orgId: ctx.tenant.orgId,
      storeId: ctx.tenant.storeId,
      businessDate,
    });
    return Object.freeze({
      result: Object.freeze({ ...summary }),
    });
  };
}

export function createStatsQueryHandlers(
  deps: StatsHandlerDeps,
): Readonly<Record<string, CommandHandler>> {
  return Object.freeze({
    "stats.day.summary": daySummaryHandler(deps),
  });
}

export function registerStatsQueryHandlers(
  registry: Readonly<{ registerHandler: (name: string, handler: CommandHandler) => void }>,
  deps: StatsHandlerDeps,
): void {
  const handlers = createStatsQueryHandlers(deps);
  registry.registerHandler("stats.day.summary", handlers["stats.day.summary"]!);
}
