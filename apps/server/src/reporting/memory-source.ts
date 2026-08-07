import type { OwnerDashboardDrilldownKind } from "@laundry/contracts";

import type {
  OwnerDashboardDrilldownSnapshot,
  OwnerDashboardOperations,
  OwnerDashboardReadPort,
  OwnerPortfolioStoreCandidate,
} from "./types.js";

const EMPTY_OPERATIONS: OwnerDashboardOperations = Object.freeze({
  pickedUpGarmentCount: 0,
  newReceivableCents: 0,
  newReceivableOrderCount: 0,
  overdueGarmentCount: 0,
  overdueOrderCount: 0,
});

export type MemoryOwnerDashboardSourceOptions = Readonly<{
  drilldowns?: Readonly<
    Partial<Record<OwnerDashboardDrilldownKind, OwnerDashboardDrilldownSnapshot>>
  >;
  portfolioStores?: readonly OwnerPortfolioStoreCandidate[];
  authorizedStoreIds?: readonly string[];
  timeZone?: string;
}>;

function emptyDrilldown(kind: OwnerDashboardDrilldownKind): OwnerDashboardDrilldownSnapshot {
  if (kind === "today_pickups") {
    return Object.freeze({
      kind,
      totalRowCount: 0,
      pickedUpGarmentCount: 0,
      rows: Object.freeze([]),
    });
  }
  if (kind === "new_receivables") {
    return Object.freeze({
      kind,
      totalRowCount: 0,
      newReceivableCents: 0,
      newReceivableOrderCount: 0,
      rows: Object.freeze([]),
    });
  }
  return Object.freeze({
    kind,
    totalRowCount: 0,
    overdueGarmentCount: 0,
    overdueOrderCount: 0,
    rows: Object.freeze([]),
  });
}

export function createMemoryOwnerDashboardSource(
  operations: OwnerDashboardOperations = EMPTY_OPERATIONS,
  options: MemoryOwnerDashboardSourceOptions = {},
): OwnerDashboardReadPort {
  const snapshot = Object.freeze({ ...operations });
  const configuredStores = options.portfolioStores?.map((store) => Object.freeze({ ...store }));
  const authorized =
    options.authorizedStoreIds === undefined ? null : new Set(options.authorizedStoreIds);
  return Object.freeze({
    readOperations: async () => snapshot,
    readDrilldown: async (request) =>
      options.drilldowns?.[request.kind] ?? emptyDrilldown(request.kind),
    listPortfolioStores: async (_client, tenant) =>
      Object.freeze(
        configuredStores ?? [
          Object.freeze({
            storeId: tenant.storeId,
            storeCode: "local",
            storeName: "本店",
            timeZone: options.timeZone ?? "UTC",
          }),
        ],
      ),
    withAuthorizedPortfolioStore: async (request, read) => {
      const allowed =
        authorized?.has(request.store.storeId) ?? request.store.storeId === request.tenant.storeId;
      if (!allowed) return null;
      return read(Object.freeze({ ...request.tenant, storeId: request.store.storeId }));
    },
  });
}
