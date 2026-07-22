/**
 * M2 stats handlers: stats.day.summary (order-backed or seeded).
 */

import { createCommandError } from "@laundry/contracts";

import type { CommandHandler, HandlerOutcome } from "../bus/types.js";
import { HandlerCommandError } from "../bus/types.js";
import type { StatsQueryPort } from "./types.js";

export type StatsHandlerDeps = Readonly<{
  source: StatsQueryPort;
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

function daySummaryHandler(deps: StatsHandlerDeps): CommandHandler {
  return async (ctx): Promise<HandlerOutcome> => {
    const input = asRecord(ctx.parsed);
    const businessDate = requireBusinessDate(input.business_date);
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
