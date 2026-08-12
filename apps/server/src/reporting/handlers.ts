import {
  OwnerDashboardDrilldownInputSchema,
  OwnerDashboardInputSchema,
  OwnerPortfolioInputSchema,
  createCommandError,
} from "@laundry/contracts";
import { businessDayAt, businessDayStart } from "@laundry/domain";

import type { MutableQueryRegistry } from "../bus/query-registry.js";
import { HandlerCommandError, type CommandHandler, type HandlerOutcome } from "../bus/types.js";
import {
  OWNER_DASHBOARD_TREND_DAYS,
  ownerDashboardOverdueCutoff,
  shiftBusinessDate,
} from "./dates.js";
import {
  buildOwnerCardMetrics,
  buildOwnerDashboardResult,
  buildOwnerDrilldownResult,
  buildOwnerPortfolioResult,
  type OwnerPortfolioStoreSnapshot,
} from "./model.js";
import type {
  OwnerDashboardReadRequest,
  OwnerPortfolioStoreCandidate,
  ReportingHandlerDeps,
} from "./types.js";

const OWNER_RESULT_ROWS = 50;
const PORTFOLIO_OVERFLOW = Symbol("owner-portfolio-overflow");

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
    const timeZone =
      deps.resolveTimeZone === undefined
        ? deps.timeZone
        : await deps.resolveTimeZone(ctx.client, ctx.tenant);
    const businessDate = businessDayAt(now, timeZone, rolloverHour).business_date;
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
      dayStartedAt: businessDayStart(businessDate, timeZone, rolloverHour),
      nextDayStartedAt: businessDayStart(
        shiftBusinessDate(businessDate, 1),
        timeZone,
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

function readScope(
  deps: ReportingHandlerDeps,
  now: Date,
  timeZone: string,
): Omit<OwnerDashboardReadRequest, "client" | "tenant"> {
  const rolloverHour = deps.rolloverHour ?? 0;
  const businessDate = businessDayAt(now, timeZone, rolloverHour).business_date;
  return Object.freeze({
    businessDate,
    dayStartedAt: businessDayStart(businessDate, timeZone, rolloverHour),
    nextDayStartedAt: businessDayStart(shiftBusinessDate(businessDate, 1), timeZone, rolloverHour),
    overdueCutoff: ownerDashboardOverdueCutoff(now),
  });
}

function drilldownHandler(deps: ReportingHandlerDeps): CommandHandler {
  return async (ctx): Promise<HandlerOutcome> => {
    requireAccountingRead(ctx.actor.permissions);
    const input = OwnerDashboardDrilldownInputSchema.parse(ctx.parsed);
    const now = validNow(deps);
    const timeZone =
      deps.resolveTimeZone === undefined
        ? deps.timeZone
        : await deps.resolveTimeZone(ctx.client, ctx.tenant);
    const scope = readScope(deps, now, timeZone);
    const snapshot = await deps.source.readDrilldown({
      client: ctx.client,
      tenant: ctx.tenant,
      ...scope,
      kind: input.kind,
      limit: OWNER_RESULT_ROWS,
    });
    return Object.freeze({
      result: buildOwnerDrilldownResult({
        businessDate: scope.businessDate,
        generatedAt: now.toISOString(),
        snapshot,
      }),
    });
  };
}

async function readPortfolioStore(
  deps: ReportingHandlerDeps,
  client: Parameters<CommandHandler>[0]["client"],
  tenant: Parameters<CommandHandler>[0]["tenant"],
  store: OwnerPortfolioStoreCandidate,
  now: Date,
): Promise<OwnerPortfolioStoreSnapshot> {
  const scope = readScope(deps, now, store.timeZone);
  const accounting = await deps.accounting.readReport({
    client,
    tenant,
    dateFrom: scope.businessDate,
    dateTo: scope.businessDate,
    groupBy: "day",
    staffId: null,
  });
  const operations = await deps.source.readOperations({ client, tenant, ...scope });
  return Object.freeze({
    store,
    businessDate: scope.businessDate,
    metrics: buildOwnerCardMetrics(scope.businessDate, accounting, operations),
  });
}

function portfolioHandler(deps: ReportingHandlerDeps): CommandHandler {
  return async (ctx): Promise<HandlerOutcome> => {
    requireAccountingRead(ctx.actor.permissions);
    OwnerPortfolioInputSchema.parse(ctx.parsed);
    const now = validNow(deps);
    const candidates = await deps.source.listPortfolioStores(ctx.client, ctx.tenant);
    const stores: OwnerPortfolioStoreSnapshot[] = [];
    let truncated = false;
    for (const store of candidates) {
      const scoped = await deps.source.withAuthorizedPortfolioStore(
        Object.freeze({ client: ctx.client, tenant: ctx.tenant, store }),
        async (tenant): Promise<OwnerPortfolioStoreSnapshot | typeof PORTFOLIO_OVERFLOW> => {
          if (stores.length === OWNER_RESULT_ROWS) return PORTFOLIO_OVERFLOW;
          return readPortfolioStore(deps, ctx.client, tenant, store, now);
        },
      );
      if (scoped === null) continue;
      if (scoped === PORTFOLIO_OVERFLOW) {
        truncated = true;
        break;
      }
      stores.push(scoped);
    }
    return Object.freeze({
      result: buildOwnerPortfolioResult({ generatedAt: now.toISOString(), stores, truncated }),
    });
  };
}

type ReportingQueryName =
  | "reporting.owner_dashboard.get"
  | "reporting.owner_dashboard.drilldown"
  | "reporting.owner_portfolio.get";

export function createReportingHandlers(
  deps: ReportingHandlerDeps,
): Readonly<Record<ReportingQueryName, CommandHandler>> {
  return Object.freeze({
    "reporting.owner_dashboard.get": queryHandler(deps),
    "reporting.owner_dashboard.drilldown": drilldownHandler(deps),
    "reporting.owner_portfolio.get": portfolioHandler(deps),
  });
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
  queryRegistry.registerHandler(
    "reporting.owner_dashboard.drilldown",
    handlers["reporting.owner_dashboard.drilldown"],
  );
  queryRegistry.registerHandler(
    "reporting.owner_portfolio.get",
    handlers["reporting.owner_portfolio.get"],
  );
}
