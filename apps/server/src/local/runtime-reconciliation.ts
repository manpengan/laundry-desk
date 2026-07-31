import type { OrderStore } from "../order/types.js";
import type { MemoryPrintJobStore } from "../print/memory-store.js";
import {
  createMemoryEdgeConflictReadPort,
  createMemoryReconciliationSource,
} from "../reconciliation/memory-source.js";
import {
  createPgEdgeConflictReadPort,
  createPgReconciliationSource,
} from "../reconciliation/pg-source.js";
import type { ReconciliationHandlerDeps } from "../reconciliation/types.js";
import type { ShiftStore } from "../shift/types.js";
import { LOCAL_PROFILE } from "./profile.js";

export type { ReconciliationHandlerDeps };

export function createMemoryReconciliationDeps(
  orders: OrderStore,
  shifts: ShiftStore,
  printJobs: MemoryPrintJobStore,
): ReconciliationHandlerDeps {
  return Object.freeze({
    source: createMemoryReconciliationSource({
      orders,
      shifts,
      printJobs,
      timeZone: LOCAL_PROFILE.timezone,
    }),
    edgeConflicts: createMemoryEdgeConflictReadPort(),
    timeZone: LOCAL_PROFILE.timezone,
  });
}

export function createPgReconciliationDeps(): ReconciliationHandlerDeps {
  return Object.freeze({
    source: createPgReconciliationSource(LOCAL_PROFILE.timezone),
    edgeConflicts: createPgEdgeConflictReadPort(),
    timeZone: LOCAL_PROFILE.timezone,
  });
}
