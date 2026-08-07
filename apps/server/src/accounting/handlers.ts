import { createHash } from "node:crypto";

import {
  AccountingReportExportInputSchema,
  AccountingReportExportResultSchema,
  AccountingReportInputSchema,
  AccountingReportResultSchema,
  createCommandError,
  type AccountingGroupBy,
  type AccountingReportResult,
} from "@laundry/contracts";
import { businessDayAt } from "@laundry/domain";

import type { MutableCommandRegistry } from "../bus/registry.js";
import type { MutableQueryRegistry } from "../bus/query-registry.js";
import { HandlerCommandError, type CommandHandler, type HandlerOutcome } from "../bus/types.js";
import { buildAccountingCsv } from "./csv.js";
import type { AccountingHandlerDeps } from "./types.js";

type ParsedFilters = Readonly<{
  date_from?: string | undefined;
  date_to?: string | undefined;
  group_by?: AccountingGroupBy | undefined;
  staff_id?: string | undefined;
}>;

function requirePermission(permissions: readonly string[] | undefined, permission: string): void {
  if (permissions?.includes(permission) !== true) {
    throw new HandlerCommandError(createCommandError("PERMISSION_DENIED"));
  }
}

function validNow(deps: AccountingHandlerDeps): Date {
  const now = deps.now?.() ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new HandlerCommandError(createCommandError("TRANSACTION_FAILED"));
  }
  return now;
}

function resolveFilters(
  input: ParsedFilters,
  deps: AccountingHandlerDeps,
  now: Date,
): Readonly<{
  dateFrom: string;
  dateTo: string;
  groupBy: AccountingGroupBy;
  staffId: string | null;
}> {
  const current = businessDayAt(now, deps.timeZone, deps.rolloverHour ?? 0).business_date;
  return Object.freeze({
    dateFrom: input.date_from ?? current,
    dateTo: input.date_to ?? current,
    groupBy: input.group_by ?? "day",
    staffId: input.staff_id ?? null,
  });
}

async function readReport(
  ctx: Parameters<CommandHandler>[0],
  deps: AccountingHandlerDeps,
  input: ParsedFilters,
  now: Date,
): Promise<AccountingReportResult> {
  const filters = resolveFilters(input, deps, now);
  const report = await deps.source.readReport({
    client: ctx.client,
    tenant: ctx.tenant,
    ...filters,
  });
  return AccountingReportResultSchema.parse({
    date_from: filters.dateFrom,
    date_to: filters.dateTo,
    group_by: filters.groupBy,
    staff_id: filters.staffId,
    generated_at: now.toISOString(),
    ...report,
  });
}

function queryHandler(deps: AccountingHandlerDeps): CommandHandler {
  return async (ctx): Promise<HandlerOutcome> => {
    requirePermission(ctx.actor.permissions, "accounting_read");
    const input = AccountingReportInputSchema.parse(ctx.parsed);
    return Object.freeze({ result: await readReport(ctx, deps, input, validNow(deps)) });
  };
}

function exportHandler(deps: AccountingHandlerDeps): CommandHandler {
  return async (ctx): Promise<HandlerOutcome> => {
    requirePermission(ctx.actor.permissions, "accounting_read");
    requirePermission(ctx.actor.permissions, "ledger_export");
    const input = AccountingReportExportInputSchema.parse(ctx.parsed);
    const report = await readReport(ctx, deps, input, validNow(deps));
    const csv = buildAccountingCsv(report);
    const contentSha256 = createHash("sha256").update(csv, "utf8").digest("hex");
    const result = AccountingReportExportResultSchema.parse({
      filename: `accounting-${report.date_from}-${report.date_to}-${report.group_by}.csv`,
      content_sha256: contentSha256,
      csv,
    });
    return Object.freeze({
      result,
      audit: Object.freeze({
        entity: "accounting_report_export",
        entityId: contentSha256,
        afterJson: JSON.stringify({
          date_from: report.date_from,
          date_to: report.date_to,
          group_by: report.group_by,
          staff_id: report.staff_id,
          row_count: report.rows.length,
          content_sha256: contentSha256,
        }),
      }),
      events: Object.freeze([
        Object.freeze({
          type: "accounting.report_exported",
          payload: Object.freeze({ content_sha256: contentSha256, row_count: report.rows.length }),
        }),
      ]),
    });
  };
}

export function createAccountingHandlers(
  deps: AccountingHandlerDeps,
): Readonly<Record<"accounting.report.get" | "accounting.report.export", CommandHandler>> {
  return Object.freeze({
    "accounting.report.get": queryHandler(deps),
    "accounting.report.export": exportHandler(deps),
  });
}

export function registerAccountingHandlers(
  commandRegistry: MutableCommandRegistry,
  queryRegistry: MutableQueryRegistry | null,
  deps: AccountingHandlerDeps,
): void {
  const handlers = createAccountingHandlers(deps);
  commandRegistry.registerHandler("accounting.report.export", handlers["accounting.report.export"]);
  queryRegistry?.registerHandler("accounting.report.get", handlers["accounting.report.get"]);
}
