import { OwnerDashboardInputSchema, createCommandError } from "@laundry/contracts";
import { businessDayAt, businessDayStart } from "@laundry/domain";

import type { MutableQueryRegistry } from "../bus/query-registry.js";
import { HandlerCommandError, type CommandHandler, type HandlerOutcome } from "../bus/types.js";
import {
  OWNER_DASHBOARD_TREND_DAYS,
  ownerDashboardOverdueCutoff,
  shiftBusinessDate,
} from "./dates.js";
import { buildOwnerDashboardResult } from "./model.js";
import type { ReportingHandlerDeps } from "./types.js";

function requireAccountingRead(permissions: readonly string[] | undefined): void {
  if (permissions?.includes("accounting_read") !== true) {
    throw new HandlerCommandError(createCommandError("PERMISSION_DENIED"));
  }
}

function validNow(deps: ReportingHandlerDeps): Date {
  const now = deps.now?.() ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new HandlerCommandError(createCommandError("TRANSACTION_FAILED"));
  }
  return now;
}

function queryHandler(deps: ReportingHandlerDeps): CommandHandler {
  return async (ctx): Promise<HandlerOutcome> => {
    requireAccountingRead(ctx.actor.permissions);
    OwnerDashboardInputSchema.parse(ctx.parsed);
    const now = validNow(deps);
    const rolloverHour = deps.rolloverHour ?? 0;
    const businessDate = businessDayAt(now, deps.timeZone, rolloverHour).business_date;
    const dateFrom = shiftBusinessDate(businessDate, -(OWNER_DASHBOARD_TREND_DAYS - 1));
    const accounting = await deps.accounting.readReport({
      client: ctx.client,
      tenant: ctx.tenant,
      dateFrom,
      dateTo: businessDate,
      groupBy: "day",
      staffId: null,
    });
    const operations = await deps.source.readOperations({
      client: ctx.client,
      tenant: ctx.tenant,
      businessDate,
      dayStartedAt: businessDayStart(businessDate, deps.timeZone, rolloverHour),
      nextDayStartedAt: businessDayStart(
        shiftBusinessDate(businessDate, 1),
        deps.timeZone,
        rolloverHour,
      ),
      overdueCutoff: ownerDashboardOverdueCutoff(now),
    });
    return Object.freeze({
      result: buildOwnerDashboardResult({
        businessDate,
        generatedAt: now.toISOString(),
        accounting,
        operations,
      }),
    });
  };
}

export function createReportingHandlers(
  deps: ReportingHandlerDeps,
): Readonly<Record<"reporting.owner_dashboard.get", CommandHandler>> {
  return Object.freeze({ "reporting.owner_dashboard.get": queryHandler(deps) });
}

export function registerReportingQueryHandlers(
  queryRegistry: MutableQueryRegistry,
  deps: ReportingHandlerDeps,
): void {
  const handlers = createReportingHandlers(deps);
  queryRegistry.registerHandler(
    "reporting.owner_dashboard.get",
    handlers["reporting.owner_dashboard.get"],
  );
}
