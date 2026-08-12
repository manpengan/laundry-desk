import type { OwnerDashboardDrilldownKind } from "@laundry/contracts";
import type { AccountingReadPort } from "../accounting/types.js";
import type { SqlClient, TenantContext } from "../db/types.js";
import type { StoreTimeZoneResolver } from "../store-management/time-zone.js";

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

export type OwnerTodayPickupDetail = Readonly<{
  ticketNo: string;
  pickedAt: Date;
  garmentCount: number;
}>;

export type OwnerNewReceivableDetail = Readonly<{
  ticketNo: string;
  receivedAt: Date;
  balanceCents: number;
}>;

export type OwnerStagnantGarmentDetail = Readonly<{
  ticketNo: string;
  receivedAt: Date;
  garmentCount: number;
  balanceCents: number;
}>;

export type OwnerDashboardDrilldownSnapshot =
  | Readonly<{
      kind: "today_pickups";
      totalRowCount: number;
      pickedUpGarmentCount: number;
      rows: readonly OwnerTodayPickupDetail[];
    }>
  | Readonly<{
      kind: "new_receivables";
      totalRowCount: number;
      newReceivableCents: number;
      newReceivableOrderCount: number;
      rows: readonly OwnerNewReceivableDetail[];
    }>
  | Readonly<{
      kind: "stagnant_garments";
      totalRowCount: number;
      overdueGarmentCount: number;
      overdueOrderCount: number;
      rows: readonly OwnerStagnantGarmentDetail[];
    }>;

export type OwnerDashboardDrilldownReadRequest = OwnerDashboardReadRequest &
  Readonly<{
    kind: OwnerDashboardDrilldownKind;
    limit: number;
  }>;

export type OwnerPortfolioStoreCandidate = Readonly<{
  storeId: string;
  storeCode: string;
  storeName: string;
  timeZone: string;
}>;

export type OwnerPortfolioStoreScopeRequest = Readonly<{
  client: SqlClient;
  tenant: TenantContext;
  store: OwnerPortfolioStoreCandidate;
}>;

export type OwnerDashboardReadPort = Readonly<{
  readOperations: (request: OwnerDashboardReadRequest) => Promise<OwnerDashboardOperations>;
  readDrilldown: (
    request: OwnerDashboardDrilldownReadRequest,
  ) => Promise<OwnerDashboardDrilldownSnapshot>;
  listPortfolioStores: (
    client: SqlClient,
    tenant: TenantContext,
  ) => Promise<readonly OwnerPortfolioStoreCandidate[]>;
  withAuthorizedPortfolioStore: <TResult>(
    request: OwnerPortfolioStoreScopeRequest,
    read: (tenant: TenantContext) => Promise<TResult>,
  ) => Promise<TResult | null>;
}>;

export type ReportingHandlerDeps = Readonly<{
  accounting: AccountingReadPort;
  source: OwnerDashboardReadPort;
  timeZone: string;
  resolveTimeZone?: StoreTimeZoneResolver;
  rolloverHour?: number;
  now?: () => Date;
}>;
