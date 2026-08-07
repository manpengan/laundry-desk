import type { OwnerDashboardOperations, OwnerDashboardReadPort } from "./types.js";

const EMPTY_OPERATIONS: OwnerDashboardOperations = Object.freeze({
  pickedUpGarmentCount: 0,
  newReceivableCents: 0,
  newReceivableOrderCount: 0,
  overdueGarmentCount: 0,
  overdueOrderCount: 0,
});

export function createMemoryOwnerDashboardSource(
  operations: OwnerDashboardOperations = EMPTY_OPERATIONS,
): OwnerDashboardReadPort {
  const snapshot = Object.freeze({ ...operations });
  return Object.freeze({ readOperations: async () => snapshot });
}
