import type { AccountingReadPort } from "../accounting/types.js";
import { createMemoryOwnerDashboardSource } from "./memory-source.js";
import { createPgOwnerDashboardSource } from "./pg-source.js";
import type { ReportingHandlerDeps } from "./types.js";

export function createMemoryReportingDeps(
  accounting: AccountingReadPort,
  timeZone: string,
): ReportingHandlerDeps {
  return Object.freeze({
    accounting,
    source: createMemoryOwnerDashboardSource(undefined, { timeZone }),
    timeZone,
  });
}

export function createPgReportingDeps(
  accounting: AccountingReadPort,
  timeZone: string,
): ReportingHandlerDeps {
  return Object.freeze({ accounting, source: createPgOwnerDashboardSource(), timeZone });
}
