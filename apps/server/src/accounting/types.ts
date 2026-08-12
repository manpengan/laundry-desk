import type { AccountingAggregation, AccountingGroupBy, AccountingMovement } from "@laundry/domain";

import type { SqlClient, TenantContext } from "../db/types.js";
import type { StoreTimeZoneResolver } from "../store-management/time-zone.js";

export type AccountingReadRequest = Readonly<{
  client: SqlClient;
  tenant: TenantContext;
  dateFrom: string;
  dateTo: string;
  groupBy: AccountingGroupBy;
  staffId: string | null;
}>;

export type AccountingReadPort = Readonly<{
  readReport: (request: AccountingReadRequest) => Promise<AccountingAggregation>;
}>;

export type AccountingHandlerDeps = Readonly<{
  source: AccountingReadPort;
  timeZone: string;
  resolveTimeZone?: StoreTimeZoneResolver;
  rolloverHour?: number;
  now?: () => Date;
}>;

export type MemoryAccountingSourceInput = readonly AccountingMovement[];
