import type { AccountingReadPort } from "../accounting/types.js";
import type { SqlClient, TenantContext } from "../db/types.js";

export type OwnerDashboardOperations = Readonly<{
  pickedUpGarmentCount: number;
  newReceivableCents: number;
  newReceivableOrderCount: number;
  overdueGarmentCount: number;
  overdueOrderCount: number;
}>;

export type OwnerDashboardReadRequest = Readonly<{
  client: SqlClient;
  tenant: TenantContext;
  businessDate: string;
  dayStartedAt: Date;
  nextDayStartedAt: Date;
  overdueCutoff: Date;
}>;

export type OwnerDashboardReadPort = Readonly<{
  readOperations: (request: OwnerDashboardReadRequest) => Promise<OwnerDashboardOperations>;
}>;

export type ReportingHandlerDeps = Readonly<{
  accounting: AccountingReadPort;
  source: OwnerDashboardReadPort;
  timeZone: string;
  rolloverHour?: number;
  now?: () => Date;
}>;
